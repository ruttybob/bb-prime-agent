import type { DaemonCommandResult } from "./daemon/client.js";
import {
  daemonForkResultSchema,
  daemonSessionSummarySchema,
  daemonSessionTreeSchema,
  daemonSwitchSessionResultSchema,
  daemonUserMessagesForForkingSchema,
} from "./daemon/wire.js";
import { resolveForkTarget } from "./fork-points.js";

/**
 * The daemon choreography behind bb's `thread/fork` (bbpa-ggf.7).
 *
 * prime's `fork {activeSessionId, entryId, position}` does not produce a new
 * daemon session: it branches the source session's transcript at the entry
 * (`createBranchedSession` → a NEW session file holding the path root→entry)
 * and REPLACES the source session's runtime with that branch in place — the
 * same rebuild a prime-side /fork does, pushed to attached clients as
 * `session_replaced` under the SAME `activeSessionId`.
 *
 * bb's fork, though, keeps the source thread intact and points a NEW thread at
 * the branched history. So the choreography is a bracket:
 *
 * 1. `get_state` — the source's transcript file, and proof it is resident.
 * 2. `get_session_tree` (+ `get_user_messages_for_forking` when a checkpoint
 *    names the turn) — resolve the fork entry.
 * 3. `fork {entryId, position:"at"}` — the branch exists; the source state now
 *    runs it.
 * 4. `get_state` again — the branch's file path (never guessed).
 * 5. `switch_session` back to the original file — the source session is
 *    exactly what it was, and the branch is no longer loaded anywhere.
 *
 * Only then may the caller `create` the new thread's session with
 * `sessionPath: <branch>`: a create for an already-loaded file JOINS the live
 * state instead of opening a second one, which is why the branch must be
 * unloaded before the new session can adopt it as its own resident worker.
 *
 * The bracket is the one window where a crash between `fork` and
 * `switch_session` leaves the source session running the branched transcript;
 * the original file is untouched on disk and a re-fork re-brackets (recovery
 * across such windows is bbpa-ggf.11's business).
 */

type Request = (
  command: { type: string } & Record<string, unknown>,
  args?: { timeoutMs?: number },
) => Promise<DaemonCommandResult>;

export interface PrimeForkOutcome {
  /**
   * The branched transcript file for the new thread's session to adopt, or
   * `undefined` when the source had no entries to fork — a fresh session
   * through the ordinary create funnel matches that history exactly.
   */
  sessionFile: string | undefined;
}

interface AskResult<T> {
  success: true;
  data: T;
}
interface AskIssue {
  success: false;
  issues: string;
}

/** Send one command and read its answer, with prime's refusals legible. */
async function ask<T>(
  request: Request,
  command: { type: string } & Record<string, unknown>,
  parse: (data: unknown) => AskResult<T> | AskIssue,
): Promise<T> {
  const result = await request(command);
  if (!result.success) {
    throw new Error(
      `prime-agent refused "${command.type}": ${result.error ?? "unknown daemon error"}`,
    );
  }
  const parsed = parse(result.data);
  if (!parsed.success) {
    throw new Error(
      `prime-agent answered "${command.type}" with something this bridge cannot read (${parsed.issues})`,
    );
  }
  return parsed.data;
}

/** The transcript file a session summary names — the thing fork reads twice. */
function transcriptFile(data: unknown): AskResult<string> | AskIssue {
  const parsed = daemonSessionSummarySchema.safeParse(data);
  if (!parsed.success || parsed.data.sessionFile === undefined) {
    return { success: false, issues: "the summary carries no sessionFile" };
  }
  return { success: true, data: parsed.data.sessionFile };
}

/**
 * Branch the source session at the fork point and hand the source its own
 * transcript back. Returns the branch file for the caller's `create`.
 */
export async function forkPrimeSession(args: {
  request: Request;
  sourceActiveSessionId: string;
  /** bb's `sourceProviderCheckpointId`; absent means fork at the tip. */
  checkpointId: string | undefined;
}): Promise<PrimeForkOutcome> {
  const send = (command: { type: string } & Record<string, unknown>) =>
    args.request({ activeSessionId: args.sourceActiveSessionId, ...command });

  const originalFile = await ask(
    send,
    { type: "get_state" },
    transcriptFile,
  );

  const tree = await ask(
    send,
    { type: "get_session_tree" },
    (data) => {
      const parsed = daemonSessionTreeSchema.safeParse(data);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const, issues: "not a session tree answer" };
    },
  );

  let userMessages: readonly { entryId: string; text: string }[] | undefined;
  if (args.checkpointId !== undefined) {
    userMessages = await ask(
      send,
      { type: "get_user_messages_for_forking" },
      (data) => {
        const parsed = daemonUserMessagesForForkingSchema.safeParse(data);
        return parsed.success
          ? { success: true as const, data: parsed.data.messages }
          : { success: false as const, issues: "not a fork-point list" };
      },
    );
  }

  const target = resolveForkTarget({
    checkpointId: args.checkpointId,
    tree,
    userMessages,
  });
  if (target.kind === "error") {
    throw new Error(`cannot fork the prime-agent session: ${target.message}`);
  }
  if (target.kind === "empty") {
    return { sessionFile: undefined };
  }

  await ask(
    send,
    { type: "fork", entryId: target.entryId, position: "at" },
    (data) => {
      const parsed = daemonForkResultSchema.safeParse(data);
      if (!parsed.success) {
        return { success: false as const, issues: "not a fork answer" };
      }
      return parsed.data.cancelled === true
        ? { success: false as const, issues: "prime-agent cancelled the fork" }
        : { success: true as const, data: parsed.data };
    },
  );

  // The source state now runs the branch; read the branch's file from it. A
  // summary read right after the fork can still observe the pre-branch
  // transcript while the replacement is applying — wait until the state
  // actually reports a different file, and refuse to guess.
  let branchedFile = originalFile;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    branchedFile = await ask(send, { type: "get_state" }, transcriptFile);
    if (branchedFile !== originalFile) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (branchedFile === originalFile) {
    throw new Error(
      "prime-agent did not report a branched transcript after the fork; refusing to build the new session on the source's own file",
    );
  }

  // Hand the source session back its own transcript before anything can create
  // from the branch (a create for a loaded file joins the live state instead).
  await ask(
    send,
    { type: "switch_session", sessionPath: originalFile },
    (data) => {
      const parsed = daemonSwitchSessionResultSchema.safeParse(data);
      if (!parsed.success) {
        return {
          success: false as const,
          issues: "not a switch_session answer",
        };
      }
      return parsed.data.cancelled === true
        ? {
            success: false as const,
            issues:
              "prime-agent cancelled the switch back; the source session is left running the branched transcript",
          }
        : { success: true as const, data: parsed.data };
    },
  );

  // And verify the restore actually surfaced: a create for a file a state
  // still runs JOINS that state, so the branch must be observably unloaded.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const current = await ask(send, { type: "get_state" }, transcriptFile);
    if (current === originalFile) {
      return { sessionFile: branchedFile };
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    "prime-agent still reports the source session on the branched transcript after the switch back; refusing to create the new session on top of it",
  );
}

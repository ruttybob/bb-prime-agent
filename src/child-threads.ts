/**
 * Child subagent sessions surfaced as bb threads (bbpa-b1m.11, ADR-0005).
 *
 * When a watched resident session spawns an RLM child, the plugin mints a bb
 * thread for it (`bb.sdk.threads.spawn` with `parentThreadId`, attributed to
 * the plugin automatically). The spawn's mandatory first input is a MARKER:
 * an agent-only text part carrying the child's daemon session id. The bridge
 * consumes the marker in `thread/start` — it never reaches prime or a model —
 * and instead attaches to the child's session, whose adopted-session replay
 * fills the fresh thread with the child's transcript.
 *
 * This module is the shared seam between the two halves that need to agree on
 * the marker: the server half builds it when spawning; the bridge half parses
 * it when a start arrives. Everything here is pure.
 */
// Single line on purpose: the server-graph check counts a multi-line
// import-type statement as a value import by its statement-head heuristic.
import type { DynamicTool, PromptInput } from "@get-bb/plugin-sdk/provider-bridge";
import { errorMessage } from "./error-message.js";
import { isChildLive, type PrimeChild } from "./subagents/children.js";

/**
 * The start fields the marker branch reads. Structural, not the bridge
 * schema: the server entry must never value-import an SDK subpath (it dies
 * under bb's jiti reload), and this branch needs nothing beyond these.
 */
export interface ChildThreadStartParams {
  threadId: string;
  cwd: string;
  dynamicTools?: readonly DynamicTool[];
  input?: readonly PromptInput[];
}

/**
 * The marker's text form. Deliberately exact and single-line: the bridge
 * accepts only this shape, so ordinary (or adversarial) user text can never
 * masquerade as a marker — a marker is something only this plugin's spawn
 * writes, and `visibility: "agent-only"` keeps it out of the timeline even
 * before the bridge consumes it.
 */
const MARKER_PREFIX = "@prime-child:";

const MARKER_PATTERN = new RegExp(`^${MARKER_PREFIX}([A-Za-z0-9_-]+)$`);

/** The agent-only spawn input that names the child session to attach to. */
export function childThreadMarkerInput(childSessionId: string): PromptInput {
  return {
    type: "text",
    text: `${MARKER_PREFIX}${childSessionId}`,
    mentions: [],
    visibility: "agent-only",
  };
}

/**
 * The spawned thread's title: the child's prime-side label, flattened to one
 * line and capped. Prime labels unnamed children with their whole task text,
 * so verbatim labels are often a full prompt — a title must stay a title.
 */
const CHILD_THREAD_TITLE_MAX_CHARS = 64;

export function childThreadTitle(childLabel: string): string {
  const oneLine = childLabel.replaceAll(/\s+/gu, " ").trim();
  if (oneLine.length <= CHILD_THREAD_TITLE_MAX_CHARS) {
    return oneLine;
  }
  return `${oneLine.slice(0, CHILD_THREAD_TITLE_MAX_CHARS - 1)}…`;
}

/**
 * The child session id a start request's input carries, or `undefined` when
 * the input is not exactly one marker part (ordinary prompts, extra parts,
 * multi-line smuggling).
 */
export function childThreadMarkerFromInput(
  input: readonly PromptInput[] | undefined,
): { childSessionId: string } | undefined {
  if (input === undefined || input.length !== 1) {
    return undefined;
  }
  const part = input[0];
  if (part.type !== "text" || part.visibility !== "agent-only") {
    return undefined;
  }
  const match = MARKER_PATTERN.exec(part.text);
  if (match === null) {
    return undefined;
  }
  return { childSessionId: match[1] };
}


/**
 * The server half (bbpa-b1m.11): turn `subagents.changed` signals into bb
 * threads. Every dependency is an injected function, so the wiring in
 * `server.ts` owns the bb.sdk calls and tests own fakes.
 */
export interface ChildThreadServiceDeps {
  log: { info(message: string): void; warn(message: string): void };
  /** Parent prime session id → the bb thread it backs, when known. */
  resolveParentThreadId(parentSessionId: string): Promise<string | undefined>;
  /** A recent bb thread's prime session, when it has one (watch sweep). */
  resolveThreadSession(threadId: string): Promise<string | undefined>;
  /** The parent thread's filing: where the child thread is spawned. */
  getParentThread(
    threadId: string,
  ): Promise<{ projectId: string; environmentId: string | null } | undefined>;
  /** Whether a thread titled `title` already hangs off this parent. */
  findExistingChildThread(parentThreadId: string, title: string): Promise<boolean>;
  /** Mint the child thread (bb creates it attributed to the plugin). */
  spawnChildThread(args: {
    parentThreadId: string;
    projectId: string;
    environmentId: string | null;
    title: string;
    childSessionId: string;
  }): Promise<void>;
  /** Keep a host watching the session's children (best effort). */
  watchSession(sessionId: string): Promise<void>;
  /** Recent, non-archived bb threads this provider backs (watch sweep). */
  listRecentPrimeThreadIds(): Promise<string[]>;
}

export function createChildThreadService(deps: ChildThreadServiceDeps): {
  onChildren(parentSessionId: string, children: readonly PrimeChild[]): Promise<void>;
  watchRecentThreads(): Promise<void>;
} {
  /** Child sessions this process already threaded. Claimed before any await. */
  const spawned = new Set<string>();

  async function maybeSpawn(
    parentSessionId: string,
    child: PrimeChild,
  ): Promise<void> {
    const childSessionId = child.activeSessionId;
    // A child without a booted session has no transcript to attach to — it
    // stays a delegation row until a later signal names its session. A
    // finished child's transcript lives in the delegation row's recap, not a
    // thread minted after the fact.
    if (childSessionId === undefined || !isChildLive(child)) {
      return;
    }
    if (spawned.has(childSessionId)) {
      return;
    }
    // Claim before any await: two signals carrying the same child must not
    // race into two threads. Every bail releases the claim so the next
    // signal retries.
    spawned.add(childSessionId);
    const done = await attemptSpawn(parentSessionId, child, childSessionId);
    if (!done) {
      spawned.delete(childSessionId);
    }
  }

  /** Spawn one child thread; `true` when the thread exists afterwards. */
  async function attemptSpawn(
    parentSessionId: string,
    child: PrimeChild,
    childSessionId: string,
  ): Promise<boolean> {
    try {
      const parentThreadId = await deps.resolveParentThreadId(parentSessionId);
      if (parentThreadId === undefined) {
        return false;
      }
      const title = childThreadTitle(child.label);
      // The claim set dies with the process; a server restart re-derives
      // "already threaded" from the parent's existing children by title.
      // Two live children sharing a label would then fold into one thread —
      // accepted over the alternative, a duplicate thread per restart.
      if (await deps.findExistingChildThread(parentThreadId, title)) {
        deps.log.info(
          `child threads: "${title}" already has a thread under ${parentThreadId}`,
        );
        return true;
      }
      const parent = await deps.getParentThread(parentThreadId);
      if (parent === undefined) {
        return false;
      }
      await deps.spawnChildThread({
        parentThreadId,
        projectId: parent.projectId,
        environmentId: parent.environmentId,
        title,
        childSessionId,
      });
      deps.log.info(
        `child threads: spawned a thread for "${title}" (${childSessionId})`,
      );
      return true;
    } catch (error) {
      deps.log.warn(
        `child threads: could not spawn a thread for ${childSessionId} (${errorMessage(error)})`,
      );
      return false;
    }
  }

  return {
    onChildren(parentSessionId, children) {
      return Promise.all(
        children.map((child) => maybeSpawn(parentSessionId, child)),
      ).then(() => {});
    },
    async watchRecentThreads() {
      // The spawn signals only flow for watched sessions, and watching is
      // hosted where the daemon runs. Recent prime-backed threads are the
      // candidate set; panels cover their own threads on demand.
      const seen = new Set<string>();
      for (const threadId of await deps.listRecentPrimeThreadIds()) {
        const sessionId = await deps.resolveThreadSession(threadId);
        if (sessionId === undefined || seen.has(sessionId)) {
          continue;
        }
        seen.add(sessionId);
        try {
          await deps.watchSession(sessionId);
        } catch {
          // No connected host holds it right now; the next sweep retries.
        }
      }
    },
  };
}

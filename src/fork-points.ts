/**
 * Fork-point identity: how a prime session's history becomes a fork anchor bb
 * can hand back later (bbpa-ggf.7).
 *
 * The bridge declares `fork: "checkpoint"`, so every settled turn carries a
 * `providerCheckpointId` on its `turn.boundary` delta — bb stores it on the
 * turn's completion and sends it back as `thread/fork`'s
 * `sourceProviderCheckpointId` when the user forks from an earlier message.
 *
 * The checkpoint is deliberately NOT a prime entry id: learning prime's entry
 * ids would cost a daemon round trip per turn for a fork the user may never
 * ask for. It is instead a self-contained reference to the prompt that opened
 * the turn — its ordinal among this lane's sent inputs plus a digest of its
 * text — which the fork resolves against prime's own fork-point discovery
 * (`get_user_messages_for_forking`) at fork time. The digest makes the
 * resolution verified rather than positional: an out-of-band user message
 * (someone typed at prime's own TUI) shifts the list, and a shifted list fails
 * the fork honestly instead of forking at the wrong point silently.
 */

import { createHash } from "node:crypto";

const FORK_CHECKPOINT_PREFIX = "bbpa-ck-";
const FORK_CHECKPOINT_DIGEST_CHARS = 16;

/** Collapse whitespace runs and trim: the text identity both sides agree on. */
function normalizeForkText(text: string): string {
  return text.replaceAll(/\s+/gu, " ").trim();
}

function digestForkText(text: string): string {
  return createHash("sha256")
    .update(normalizeForkText(text))
    .digest("hex")
    .slice(0, FORK_CHECKPOINT_DIGEST_CHARS);
}

/**
 * The fork anchor for the `ordinal`-th prompt this lane sent, identified by
 * its text. Opaque to bb; only this module reads it back.
 */
export function forkCheckpointFor(ordinal: number, promptText: string): string {
  return `${FORK_CHECKPOINT_PREFIX}${ordinal}-${digestForkText(promptText)}`;
}

export interface ForkCheckpoint {
  ordinal: number;
  digest: string;
}

/** Read a checkpoint back; `undefined` when it is not one of ours. */
export function parseForkCheckpoint(
  checkpointId: string,
): ForkCheckpoint | undefined {
  if (!checkpointId.startsWith(FORK_CHECKPOINT_PREFIX)) {
    return undefined;
  }
  const rest = checkpointId.slice(FORK_CHECKPOINT_PREFIX.length);
  const separator = rest.indexOf("-");
  if (separator <= 0) {
    return undefined;
  }
  const ordinal = Number.parseInt(rest.slice(0, separator), 10);
  const digest = rest.slice(separator + 1);
  if (
    !Number.isInteger(ordinal) ||
    ordinal <= 0 ||
    digest.length !== FORK_CHECKPOINT_DIGEST_CHARS ||
    /[^0-9a-f]/u.test(digest)
  ) {
    return undefined;
  }
  return { ordinal, digest };
}

/* --------------------------- fork-point resolution --------------------------- */

/** One entry of prime's session tree, as `get_session_tree` reports it. */
export interface ForkTreeEntry {
  id: string;
  parentId?: string | null;
  type?: string;
  message?: { role?: string };
}

/** `get_session_tree`'s answer, narrowed to what resolution reads. */
export interface ForkSessionTree {
  leafId?: string | null;
  flatNodes?: ReadonlyArray<{ entry: ForkTreeEntry }>;
}

/** `get_user_messages_for_forking`'s answer. */
export interface ForkUserMessage {
  entryId: string;
  text: string;
}

export type ForkTarget =
  | { kind: "entry"; entryId: string }
  | { kind: "empty" }
  | { kind: "error"; message: string };

function error(message: string): ForkTarget {
  return { kind: "error", message };
}

/**
 * Which prime entry the fork must branch at (`fork {entryId, position:"at"}`).
 *
 * A checkpoint names the user message that opened the turn, but bb's fork
 * point is the END of that turn — its copied timeline carries the turn's
 * answer, so the branched transcript must too. Resolution therefore extends
 * the anchor along prime's active branch to the entry just before the next
 * user message (the leaf, when the turn is the last one). A tip fork (no
 * checkpoint) branches at the leaf; a session with no entries has nothing to
 * fork (`empty`) — the new thread's session is created fresh instead.
 */
export function resolveForkTarget(args: {
  checkpointId: string | undefined;
  tree: ForkSessionTree;
  userMessages?: readonly ForkUserMessage[];
}): ForkTarget {
  const entries = new Map<string, ForkTreeEntry>();
  for (const node of args.tree.flatNodes ?? []) {
    if (typeof node.entry?.id === "string") {
      entries.set(node.entry.id, node.entry);
    }
  }
  const leafId = typeof args.tree.leafId === "string" ? args.tree.leafId : null;

  if (args.checkpointId === undefined) {
    if (leafId === null) {
      return { kind: "empty" };
    }
    if (!entries.has(leafId)) {
      return error(
        `the session tree reported leaf ${leafId} but none of its ${entries.size} entries`,
      );
    }
    return { kind: "entry", entryId: leafId };
  }

  const checkpoint = parseForkCheckpoint(args.checkpointId);
  if (checkpoint === undefined) {
    return error(
      `${args.checkpointId} is not a prime-agent fork checkpoint (expected ${FORK_CHECKPOINT_PREFIX}<ordinal>-<digest>)`,
    );
  }

  // The ordinal counts the inputs this lane sent; the anchor therefore sits at
  // that position in prime's list or later (out-of-band user messages can only
  // push our messages further out, never earlier). Among same-text messages
  // that puts repeated prompts ("continue", "yes") in their sent order too.
  const messages = (args.userMessages ?? [])
    .map((message, index) => ({ ...message, index }))
    .filter((message) => digestForkText(message.text) === checkpoint.digest);
  const anchor = messages.find(
    (message) => message.index >= checkpoint.ordinal - 1,
  );
  if (anchor === undefined) {
    return error(
      `fork checkpoint ${args.checkpointId} no longer matches the session's fork points (${messages.length} user message(s) with that text, none at or after position ${checkpoint.ordinal}); the session's history has moved on since the turn was recorded`,
    );
  }
  const anchorEntry = entries.get(anchor.entryId);
  if (anchorEntry === undefined) {
    return error(
      `the fork point's entry ${anchor.entryId} is missing from the session tree`,
    );
  }

  // The active branch, root first: leaf → root by parent links.
  const branch: ForkTreeEntry[] = [];
  const seen = new Set<string>();
  for (let cursor = leafId; cursor !== null && cursor !== undefined; ) {
    if (seen.has(cursor)) {
      break;
    }
    seen.add(cursor);
    const entry = entries.get(cursor);
    if (entry === undefined) {
      break;
    }
    branch.unshift(entry);
    cursor = entry.parentId ?? null;
  }
  const anchorIndex = branch.findIndex((entry) => entry.id === anchor.entryId);
  if (anchorIndex < 0) {
    return error(
      "the fork point is not on the session's active branch (that turn was branched away inside prime)",
    );
  }
  const nextUserIndex = branch.findIndex(
    (entry, index) =>
      index > anchorIndex &&
      entry.type === "message" &&
      entry.message?.role === "user",
  );
  const target =
    nextUserIndex > 0 ? branch[nextUserIndex - 1]! : (branch.at(-1) ?? anchorEntry);
  return { kind: "entry", entryId: target.id };
}

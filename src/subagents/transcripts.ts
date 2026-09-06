import type { DaemonCommandResult } from "../daemon/client.js";
import type { DaemonPushMessage } from "../daemon/protocol.js";
import type { SubagentsRosterSeams } from "./roster.js";
import {
  boundTranscript,
  entriesFromWireMessages,
  toolResultOf,
  transcriptEntrySchema,
  type BoundedTranscript,
  type TranscriptBounds,
  type TranscriptEntry,
} from "./transcript.js";

/**
 * The child-transcript tracker (bbpa-b1m.8): read-only transcript reads of one
 * RLM child's own daemon session, over the same connection the roster uses.
 *
 * Wire facts (prime-agent 0.7.3 dist): daemon session commands resolve any
 * session the daemon holds, and an `attach` to a subagent-kind session
 * rehydrates a passivated child (`getOrHydrateBoundSessionState` →
 * `hydratePassiveRlmSubagent`) — while plain `get_messages` uses a bare
 * session lookup and fails for a passivated child. Attach is therefore the
 * read surface: the answer's `snapshot.messages` seeds the transcript, and the
 * `message_end` pushes an attached client receives carry every durable message
 * appended afterwards (user, assistant, toolResult alike). Pushes at or before
 * the attach snapshot's cursor are history the seed already has and are
 * dropped, exactly like the provider lane's snapshot↔live boundary
 * (`src/prime-session.ts`).
 *
 * Nothing here writes: the attach sends no prompt and no cancel, and the
 * detach on release returns the session to exactly the daemon's own care.
 */

/**
 * Read-only attach slim, the same members the roster attaches with: the
 * snapshot (with `messages`), the event cursor to bound stale pushes, and no
 * duplicate `session_attached` echo.
 */
const TRANSCRIPT_ATTACH_CAPABILITIES = [
  "attach_snapshot",
  "event_sequence",
  "slim_attach",
];

/** How long a child nobody reads stays attached. */
const DEFAULT_INTEREST_TTL_MS = 10 * 60_000;
/** How often idle children are swept. */
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

/**
 * The history bounds: the most recent 200 rows, at most 128 KiB of rendered
 * text. A child transcript can run far longer; a panel shows the recent run,
 * and these bounds keep one child's cache, every RPC answer, and the tracker's
 * memory flat no matter how long the child runs.
 */
export const TRANSCRIPT_BOUNDS: TranscriptBounds = {
  maxEntries: 200,
  maxTotalBytes: 128 * 1024,
};

/** One child's tracked transcript state: the rows, and the attach behind them. */
interface TrackedChild {
  activeSessionId: string;
  attached: boolean;
  /** The tracker's rows (with pairing glue the contract strips). */
  entries: TranscriptEntry[];
  truncated: boolean;
  /** The snapshot↔live boundary: pushes at or before it are already in the seed. */
  boundary: { generation: string; sequence: number } | undefined;
  lastInterestAt: number;
}

export class ChildTranscripts {
  private readonly tracked = new Map<string, TrackedChild>();
  private readonly unsubscribe: () => void;
  private readonly reconnectUnsubscribe: (() => void) | undefined;
  private readonly interestTtlMs: number;
  private readonly sweepIntervalMs: number;
  private readonly bounds: TranscriptBounds;
  private sweepTimer: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(
    private readonly seams: SubagentsRosterSeams,
    args: {
      interestTtlMs?: number;
      sweepIntervalMs?: number;
      bounds?: TranscriptBounds;
    } = {},
  ) {
    this.interestTtlMs = args.interestTtlMs ?? DEFAULT_INTEREST_TTL_MS;
    this.sweepIntervalMs = args.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.bounds = args.bounds ?? TRANSCRIPT_BOUNDS;
    this.unsubscribe = seams.subscribePush((message) => this.handlePush(message));
    this.reconnectUnsubscribe = seams.onReconnect?.(() => {
      void this.reattachAll();
    });
  }

  /**
   * The child session's bounded transcript: attaching on the first read
   * (seeded by the snapshot), push-maintained afterwards. A child that has no
   * session yet never reaches this — the caller decides what an unbooted child
   * answers.
   */
  async read(childActiveSessionId: string): Promise<BoundedTranscript> {
    this.assertAlive();
    const existing = this.tracked.get(childActiveSessionId);
    if (existing?.attached === true) {
      existing.lastInterestAt = Date.now();
      this.startSweepTimer();
      return this.bounded(existing);
    }
    const entry: TrackedChild = existing ?? {
      activeSessionId: childActiveSessionId,
      attached: false,
      entries: [],
      truncated: false,
      boundary: undefined,
      lastInterestAt: Date.now(),
    };
    this.tracked.set(childActiveSessionId, entry);
    entry.lastInterestAt = Date.now();
    await this.attach(entry);
    this.startSweepTimer();
    return this.bounded(entry);
  }

  /** Stop reading a child (detach best-effort — an absent daemon holds nothing). */
  async release(childActiveSessionId: string): Promise<void> {
    const entry = this.tracked.get(childActiveSessionId);
    if (entry === undefined) {
      return;
    }
    this.tracked.delete(childActiveSessionId);
    this.stopSweepTimerWhenIdle();
    if (entry.attached) {
      entry.attached = false;
      await this.detachQuietly(childActiveSessionId);
    }
  }

  /** Detach every child and stop listening (host worker dispose, tests). */
  async dispose(): Promise<void> {
    this.disposed = true;
    const ids = [...this.tracked.keys()];
    this.tracked.clear();
    this.stopSweepTimerWhenIdle();
    this.unsubscribe();
    this.reconnectUnsubscribe?.();
    for (const id of ids) {
      await this.detachQuietly(id);
    }
  }

  /**
   * Detach children whose last read is older than the TTL. Returns the session
   * ids dropped — tests assert on them, the timer ignores the answer.
   */
  async sweepIdle(now: number = Date.now()): Promise<string[]> {
    const stale = [...this.tracked.values()]
      .filter((entry) => now - entry.lastInterestAt >= this.interestTtlMs)
      .map((entry) => entry.activeSessionId);
    for (const id of stale) {
      await this.release(id);
    }
    return stale;
  }

  private assertAlive(): void {
    if (this.disposed) {
      throw new Error("the child-transcript tracker was disposed");
    }
  }

  private bounded(entry: TrackedChild): BoundedTranscript {
    const { entries, truncated } = boundTranscript(entry.entries, this.bounds);
    // The contract's schema is where pairing glue is stripped from the wire;
    // parse (not passthrough) makes the read answer the panel shape directly.
    return {
      entries: entries.map((row) => transcriptEntrySchema.parse(row)),
      truncated: truncated || entry.truncated,
    };
  }

  private async attach(entry: TrackedChild): Promise<void> {
    const answer = await this.seams.request({
      type: "attach",
      activeSessionId: entry.activeSessionId,
      capabilities: TRANSCRIPT_ATTACH_CAPABILITIES,
    });
    if (!answer.success) {
      this.tracked.delete(entry.activeSessionId);
      this.stopSweepTimerWhenIdle();
      throw new Error(
        `prime-agent refused to attach for the transcript of ${entry.activeSessionId}: ${
          answer.error ?? "unknown daemon error"
        }`,
      );
    }
    const data = answer.data as
      | {
          snapshot?: { messages?: unknown };
          lastEventCursor?: { generation?: unknown; sequence?: unknown };
        }
      | undefined;
    entry.attached = true;
    const seed = data?.snapshot?.messages;
    entry.entries = entriesFromWireMessages(Array.isArray(seed) ? seed : []);
    entry.truncated = false;
    entry.boundary =
      data?.lastEventCursor &&
      typeof data.lastEventCursor.generation === "string" &&
      typeof data.lastEventCursor.sequence === "number"
        ? { generation: data.lastEventCursor.generation, sequence: data.lastEventCursor.sequence }
        : undefined;
  }

  /** A reconnect wipes the daemon's attach state: re-read everything still open. */
  private async reattachAll(): Promise<void> {
    for (const entry of this.tracked.values()) {
      entry.attached = false;
    }
    for (const entry of [...this.tracked.values()]) {
      try {
        await this.attach(entry);
      } catch {
        // The child session may be gone after a daemon restart; its transcript
        // drops rather than failing every later read.
        this.tracked.delete(entry.activeSessionId);
        this.stopSweepTimerWhenIdle();
      }
    }
  }

  private handlePush(message: DaemonPushMessage): void {
    if (this.disposed) {
      return;
    }
    const activeSessionId = (message as { activeSessionId?: unknown }).activeSessionId;
    if (typeof activeSessionId !== "string") {
      return;
    }
    const entry = this.tracked.get(activeSessionId);
    if (entry === undefined || !entry.attached) {
      return;
    }
    if (
      message.type === "session_closed" ||
      message.type === "session_resynced" ||
      message.type === "session_replaced"
    ) {
      // The daemon closed or replaced the child session under us: drop the
      // cache. A later read re-attaches (and rehydrates) from scratch.
      entry.attached = false;
      void this.release(activeSessionId);
      return;
    }
    if (message.type !== "session_event") {
      return;
    }
    if (isStalePush(message, entry.boundary)) {
      return;
    }
    const event = (message as { event?: unknown }).event;
    if ((event as { type?: unknown } | undefined)?.type !== "message_end") {
      // Streaming deltas (`message_update`) are not durable; the boundaries and
      // state chatter have no transcript meaning.
      return;
    }
    const durable = (event as { message?: unknown }).message;
    if (durable === undefined || durable === null) {
      return;
    }
    this.appendDurable(entry, durable);
  }

  /**
   * Append one durable message. Pushes arrive one message at a time, so the
   * pairing the bulk parse does over a whole list happens here: a `toolResult`
   * fills the tool row its call opened (or is dropped when that row was
   * already bounded away), everything else appends its rows.
   */
  private appendDurable(entry: TrackedChild, durable: unknown): void {
    const callId = (durable as { toolCallId?: unknown } | undefined)?.toolCallId;
    if (typeof callId === "string") {
      const result = toolResultOf(durable);
      if (result !== undefined) {
        fillToolResult(entry.entries, callId, result);
        return;
      }
    }
    const appended = entriesFromWireMessages([durable]);
    if (appended.length > 0) {
      entry.entries.push(...appended);
    }
  }

  private startSweepTimer(): void {
    if (
      this.disposed ||
      this.sweepIntervalMs <= 0 ||
      this.sweepTimer !== undefined ||
      this.tracked.size === 0
    ) {
      return;
    }
    this.sweepTimer = setInterval(() => {
      void this.sweepIdle();
    }, this.sweepIntervalMs);
    // Never a reason for the worker to stay alive on its own.
    this.sweepTimer.unref?.();
  }

  private stopSweepTimerWhenIdle(): void {
    if (this.tracked.size === 0 && this.sweepTimer !== undefined) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }

  private detachQuietly(childActiveSessionId: string): Promise<void> {
    return this.seams
      .request({ type: "detach", activeSessionId: childActiveSessionId })
      .then(
        () => undefined,
        () => undefined,
      );
  }
}

/** Fill the open tool row a `toolCallId` named, if it is still in the list. */
function fillToolResult(
  rows: TranscriptEntry[],
  callId: string,
  result: { text: string; isError: boolean },
): void {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row.kind === "tool" && row.toolCallId === callId) {
      row.resultText = result.text;
      row.isError = result.isError;
      return;
    }
  }
}

/**
 * Whether a push predates the snapshot boundary: the same event generation at
 * or before it. A different generation is a daemon-side session replacement,
 * whose events are live by definition (the lane's rule, `src/prime-session.ts`).
 */
function isStalePush(
  message: DaemonPushMessage,
  boundary: { generation: string; sequence: number } | undefined,
): boolean {
  if (boundary === undefined) {
    return false;
  }
  const cursor = (message as { meta?: { cursor?: unknown } }).meta?.cursor as
    | { generation?: unknown; sequence?: unknown }
    | undefined;
  if (cursor === undefined) {
    return false;
  }
  if (cursor.generation !== boundary.generation) {
    return false;
  }
  return (cursor.sequence as number) <= boundary.sequence;
}

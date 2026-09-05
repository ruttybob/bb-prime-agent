import type {
  ClientTurnRequestId,
  PromptInput,
  ReasoningLevel,
  ThreadDelta,
} from "@get-bb/plugin-sdk/provider-bridge";
import type { DaemonCommandResult } from "./daemon/client.js";
import type { DaemonHello, DaemonPushMessage } from "./daemon/protocol.js";
import {
  createPrimeDeltaTranslator,
  type PrimeDeltaTranslator,
  type TranslationContext,
} from "./delta-translation.js";
import {
  agentEndEventSchema,
  daemonAttachResultSchema,
  daemonCreateResultSchema,
  daemonQueueResultSchema,
  sessionClosedSchema,
  sessionEventEnvelopeSchema,
  type DaemonEventCursor,
  type DaemonQueueResult,
  type SessionEventEnvelope,
} from "./daemon/wire.js";
import {
  buildPrimeCreateCommand,
  type PrimeDynamicToolsConfig,
} from "./session-params.js";
import { forkCheckpointFor } from "./fork-points.js";
import { asWireCommand } from "./daemon/transport.js";
import type { SessionRecord } from "./session-table.js";

/**
 * One bb thread's resident prime session.
 *
 * A session is daemon-resident: `create` (`lifecycle: "resident"`) boots a
 * worker that keeps running after the bridge disconnects, and the session file
 * is the durable artifact bb's thread points at. The lane owns the
 * snapshot↔live boundary — pushes at or before the attach snapshot's cursor are
 * history the daemon already counted and are dropped, everything after it
 * streams — and translates pushes into bb deltas on the way through.
 *
 * The lane never dials the wire itself: the bridge process owns one daemon
 * connection (`src/daemon/connection.ts`) and hands this class its `request`
 * and push-subscription seams, so tests can drive a session over a scripted
 * transport and the parity replay can serve a recorded lane.
 */

/** The bb-side identity the runtime adopted for this thread. */
export interface SessionIdentity {
  providerThreadId: string;
  sessionRestorable: boolean;
}

export interface StartSessionArgs {
  threadId: string;
  cwd: string;
  title?: string | undefined;
  /** An existing transcript to adopt (the fork branch, bbpa-ggf.7), when any. */
  sessionPath?: string | undefined;
  model?: string | undefined;
  reasoningLevel?: ReasoningLevel | undefined;
  /** Extension-picker paths to load explicitly (bbpa-ggf.12), when any. */
  enabledExtensions?: readonly string[] | undefined;
  /** Dynamic-tools channel fragment for the create (bbpa-ggf.13), when any. */
  dynamicTools?: PrimeDynamicToolsConfig | undefined;
}

export interface PrimeSessionOptions {
  record: SessionRecord;
  emit: (deltas: { threadId: string; deltas: readonly ThreadDelta[] }) => void;
  subscribePush: (listener: (message: DaemonPushMessage) => void) => () => void;
  request: (command: { type: string } & Record<string, unknown>, args?: { timeoutMs?: number }) => Promise<DaemonCommandResult>;
  ensureConnected: () => Promise<DaemonHello>;
}

function readCommandData<T>(
  result: DaemonCommandResult,
  command: string,
  parse: (data: unknown) => { success: true; data: T } | { success: false; issues: string },
): T {
  if (!result.success) {
    throw new Error(
      `prime-agent refused "${command}": ${result.error ?? "unknown daemon error"}`,
    );
  }
  const parsed = parse(result.data);
  if (!parsed.success) {
    throw new Error(
      `prime-agent answered "${command}" with something this bridge cannot read (${parsed.issues})`,
    );
  }
  return parsed.data;
}

export class PrimeSession {
  private readonly record: SessionRecord;
  private readonly emit: PrimeSessionOptions["emit"];
  private readonly request: PrimeSessionOptions["request"];
  private readonly translator: PrimeDeltaTranslator;
  private readonly unsubscribe: () => void;

  /** Pushes that arrived before the attach snapshot fixed the boundary. */
  private buffered: SessionEventEnvelope[] = [];
  private boundary: DaemonEventCursor | undefined;
  private lastSequence = -1;
  private attached = false;
  private closed = false;
  /** The daemon told us it closed this session (prime quit it, eviction, …). */
  private daemonClosed = false;
  /** The turn this lane is driving, while prime streams it. */
  private openTurn:
    | { clientRequestId?: ClientTurnRequestId; settledLocally: boolean }
    | undefined;
  /**
   * Fork anchors for the prompt-carrying runs sent but not yet settled
   * (bbpa-ggf.7), FIFO in the order prime will run them (steering and
   * follow-up lanes are both FIFO). Each `agent_end` consumes the head and
   * stamps its checkpoint onto the boundary delta; a fork resolves it later
   * against prime's own fork-point discovery.
   */
  private readonly pendingCheckpoints: string[] = [];
  private inputOrdinal = 0;

  constructor(options: PrimeSessionOptions) {
    this.record = options.record;
    this.emit = options.emit;
    this.request = options.request;
    this.translator = createPrimeDeltaTranslator();
    this.unsubscribe = options.subscribePush((message) => this.handlePush(message));
  }

  get threadId(): string {
    return this.record.threadId;
  }

  get hasOpenTurn(): boolean {
    return this.openTurn !== undefined && !this.openTurn.settledLocally;
  }

  /**
   * Create the daemon-resident session and attach to it. Resolves once the
   * snapshot boundary is armed, so the caller answers `thread/start` with live
   * streaming already in place.
   */
  async start(args: StartSessionArgs): Promise<SessionIdentity> {
    const create = buildPrimeCreateCommand({
      threadId: args.threadId,
      title: args.title,
      cwd: args.cwd,
      sessionPath: args.sessionPath,
      model: args.model,
      reasoningLevel: args.reasoningLevel,
      enabledExtensions: args.enabledExtensions,
      dynamicTools: args.dynamicTools,
    });
    const created = readCommandData(
      await this.request(asWireCommand(create)),
      "create",
      (data) => {
        const parsed = daemonCreateResultSchema.safeParse(data);
        return parsed.success && parsed.data.activeSessionId !== undefined
          ? { success: true as const, data: parsed.data }
          : {
              success: false as const,
              issues: `no activeSessionId in ${JSON.stringify(data)?.slice(0, 200)}`,
            };
      },
    );
    this.record.activeSessionId = created.activeSessionId;
    this.record.sessionFile = created.sessionFile;
    this.record.sessionName = created.sessionName;
    await this.attach();
    // The provider thread id is daemon-derived, so a resumed thread points at
    // the same session no matter which bridge process created it. The bridge
    // re-indexes the record under it (`adoptProviderThreadId`).
    return {
      providerThreadId: `prime_${created.activeSessionId}`,
      sessionRestorable: true,
    };
  }

  /**
   * Attach (or re-attach) and arm live streaming past the snapshot boundary.
   * The snapshot itself is kept on the record — it is the timeline source for a
   * session adopted from another bridge process.
   */
  async attach(): Promise<void> {
    if (this.record.activeSessionId === undefined) {
      throw new Error("cannot attach before the session is created");
    }
    const answer = readCommandData(
      await this.request(
        asWireCommand({
          type: "attach",
          activeSessionId: this.record.activeSessionId,
        }),
      ),
      "attach",
      (data) => {
        const parsed = daemonAttachResultSchema.safeParse(data);
        return parsed.success
          ? { success: true as const, data: parsed.data }
          : {
              success: false as const,
              issues: parsed.error.issues.map((issue) => issue.path.join(".")).join(", "),
            };
      },
    );
    const snapshotMessages = answer.snapshot?.messages ?? [];
    this.record.sessionFile =
      answer.snapshot?.summary?.sessionFile ?? this.record.sessionFile;
    this.record.sessionName =
      answer.snapshot?.summary?.sessionName ?? this.record.sessionName;
    // The snapshot is the boundary: everything at or before its cursor is
    // already in it, so only strictly newer events stream.
    this.boundary = answer.lastEventCursor ?? answer.snapshot?.lastEventCursor;
    this.lastSequence =
      answer.lastEventSequence ?? answer.snapshot?.lastEventSequence ?? -1;
    const stale = this.buffered;
    this.buffered = [];
    this.attached = true;
    this.record.snapshotMessages = snapshotMessages;
    for (const push of stale) {
      if (!this.isStale(push)) {
        this.deliver(push);
      }
    }
    // Work can already be waiting from before this attach — queued by another
    // bb session or from prime's own TUI. `session_action_update` pushes only
    // announce changes, so read the lanes once; visibility is best-effort and
    // never blocks the attach (bbpa-ggf.5).
    try {
      const queue = readCommandData<DaemonQueueResult>(
        await this.request(
          asWireCommand({
            type: "get_queue",
            activeSessionId: this.record.activeSessionId,
          }),
        ),
        "get_queue",
        (data) => {
          const parsed = daemonQueueResultSchema.safeParse(data);
          return parsed.success
            ? { success: true as const, data: parsed.data }
            : { success: false as const, issues: "not a queue answer" };
        },
      );
      const previews = (values: readonly unknown[]): string[] =>
        values.filter((preview): preview is string => typeof preview === "string");
      const steering = previews(queue.steering);
      const followUps = previews(queue.followUp);
      if (steering.length > 0 || followUps.length > 0) {
        this.pushDeltas(
          this.translator.queueStateDeltas(this.record.threadId, { steering, followUps }),
        );
      }
    } catch {
      // A daemon that will not answer get_queue still attaches; the next
      // session_action_update surfaces the lanes instead.
    }
  }

  /**
   * Whether a push predates the snapshot boundary: the same event generation at
   * or before it. A different generation is a daemon-side session replacement,
   * whose events are live by definition.
   */
  private isStale(push: SessionEventEnvelope): boolean {
    const cursor = push.meta?.cursor;
    if (cursor === undefined || this.boundary === undefined) {
      return false;
    }
    if (cursor.generation !== this.boundary.generation) {
      this.boundary = cursor;
      return false;
    }
    return cursor.sequence <= this.boundary.sequence;
  }

  private handlePush(message: DaemonPushMessage): void {
    if (this.closed || this.record.activeSessionId === undefined) {
      return;
    }
    const closed = sessionClosedSchema.safeParse(message);
    if (closed.success && closed.data.activeSessionId === this.record.activeSessionId) {
      // The daemon closed the session (prime quit it, update restart, …). The
      // session file survives on disk; the lane stops streaming.
      this.daemonClosed = true;
      this.closed = true;
      return;
    }
    if (message.type === "session_resynced" || message.type === "session_replaced") {
      // Prime replaced the worker under us: re-attach for a fresh snapshot
      // rather than inventing deltas for a transcript we can no longer see.
      void this.attach().catch(() => {
        this.closed = true;
      });
      return;
    }
    const parsed = sessionEventEnvelopeSchema.safeParse(message);
    if (
      !parsed.success ||
      parsed.data.activeSessionId !== this.record.activeSessionId
    ) {
      return;
    }
    if (!this.attached) {
      this.buffered.push(parsed.data);
      return;
    }
    if (this.isStale(parsed.data)) {
      return;
    }
    this.deliver(parsed.data);
  }

  private deliver(push: SessionEventEnvelope): void {
    const sequence = push.meta?.sequence;
    if (typeof sequence === "number" && this.lastSequence >= 0 && sequence <= this.lastSequence) {
      return;
    }
    if (typeof sequence === "number") {
      this.lastSequence = sequence;
    }
    // Every agent_end belongs to the oldest unsettled input, settled or not:
    // consuming here (boundary suppressed or not) keeps the FIFO aligned with
    // prime's runs.
    const checkpointId = agentEndEventSchema.safeParse(push.event).success
      ? this.pendingCheckpoints.shift()
      : undefined;
    const context: TranslationContext = {
      threadId: this.record.threadId,
      cwd: this.record.cwd,
      // An interrupt settled the turn locally; prime's own `agent_end` still
      // carries the item closes but must not close the turn twice.
      suppressTurnBoundary: this.openTurn?.settledLocally === true,
      ...(checkpointId === undefined ? {} : { providerCheckpointId: checkpointId }),
      onTurnSettled: () => {
        if (this.openTurn !== undefined) {
          this.openTurn.settledLocally = true;
        }
      },
    };
    this.pushDeltas(this.translator.translate(push.event, context));
  }

  /** Mint the fork anchor for a prompt-carrying run about to be sent. */
  private queueCheckpoint(promptText: string): void {
    this.inputOrdinal += 1;
    this.pendingCheckpoints.push(forkCheckpointFor(this.inputOrdinal, promptText));
  }

  private pushDeltas(deltas: readonly ThreadDelta[]): void {
    if (deltas.length === 0) {
      return;
    }
    this.emit({ threadId: this.record.threadId, deltas });
  }

  /** bb prompt text: the text parts joined; skill/command mentions are bbpa-ggf.8. */
  static promptText(input: readonly PromptInput[]): string {
    const parts: string[] = [];
    for (const part of input) {
      if (part.type === "text" && part.text.trim() !== "") {
        parts.push(part.text);
      }
    }
    return parts.join("\n");
  }

  /** The bb thread title as the bridge can see it: the first prompt text. */
  static titleFromInput(
    input: readonly PromptInput[] | undefined,
  ): string | undefined {
    for (const part of input ?? []) {
      if (part.type === "text" && part.text.trim() !== "") {
        return part.text;
      }
    }
    return undefined;
  }

  /** Prompt prime and leave the turn open until `agent_end` settles it. */
  async turn(args: {
    clientRequestId: ClientTurnRequestId | undefined;
    input: readonly PromptInput[];
  }): Promise<void> {
    if (this.record.activeSessionId === undefined) {
      throw new Error("cannot prompt before the session is created");
    }
    this.openTurn = {
      clientRequestId: args.clientRequestId,
      settledLocally: false,
    };
    // The anchor is queued with the send: prime settles every admitted input
    // with an agent_end, which consumes it. If the prompt is refused, the
    // anchor is taken back so the FIFO stays aligned with prime's runs.
    this.queueCheckpoint(PrimeSession.promptText(args.input));
    try {
      await this.request(
        asWireCommand({
          type: "prompt",
          activeSessionId: this.record.activeSessionId,
          message: PrimeSession.promptText(args.input),
          // Prime refuses a bare prompt while it is streaming ("Specify
          // streamingBehavior …"), and a prompt that lands on a busy session
          // must not take the session away from the running turn: the
          // follow-up lane holds it and prime delivers it only after the
          // agent finishes. On an idle session this is exactly prime's
          // ordinary prompt — the daemon applies resumeIfIdle either way
          // (bbpa-ggf.5).
          streamingBehavior: "followUp",
        }),
      );
    } catch (error) {
      this.pendingCheckpoints.pop();
      throw error;
    }
  }

  /**
   * Steer prime with a user message — the one primitive behind bb's steer,
   * whatever the lane state. The message goes to prime's steering lane
   * (`next_turn_boundary`): prime delivers it after the work in flight
   * finishes and before whatever runs next, never interrupting anything. On
   * an idle session the daemon's `resumeIfIdle` starts a fresh run with it,
   * so a steer is never a silent no-op. (On the calibrated 0.7.3 daemon a
   * steer of a streaming session is delivered when that run settles, and the
   * steered answer streams as the follow-up run — a new bb turn.)
   */
  async steer(args: { input: readonly PromptInput[] }): Promise<void> {
    if (this.record.activeSessionId === undefined) {
      throw new Error("cannot steer before the session is created");
    }
    this.openTurn = { settledLocally: false };
    this.queueCheckpoint(PrimeSession.promptText(args.input));
    try {
      await readCommandData(
        await this.request(
          asWireCommand({
            type: "steer",
            activeSessionId: this.record.activeSessionId,
            message: PrimeSession.promptText(args.input),
          }),
        ),
        "steer",
        (data) => ({ success: true as const, data }),
      );
    } catch (error) {
      this.pendingCheckpoints.pop();
      throw error;
    }
  }

  /**
   * Soft stop: prime finishes the current tool round and stops streaming, and
   * the transcript (the session file) is preserved — the release primitive,
   * never `kill`. The bridge settles the turn locally so bb's timeline closes
   * without waiting for the daemon to agree.
   */
  async interrupt(): Promise<readonly ThreadDelta[]> {
    const deltas = this.translator.interruptDeltas(this.record.threadId);
    if (this.record.activeSessionId !== undefined && this.hasOpenTurn) {
      this.openTurn = { ...this.openTurn!, settledLocally: true };
      try {
        await this.request(
          asWireCommand({
            type: "abort",
            activeSessionId: this.record.activeSessionId,
          }),
        );
      } catch {
        // A daemon that already went away cannot abort anything; the turn is
        // over either way and the session file is untouched on disk.
      }
    }
    return deltas;
  }

  /** Detach this client from the session; the resident session keeps running. */
  async detach(): Promise<void> {
    if (this.record.activeSessionId === undefined) {
      return;
    }
    try {
      await this.request(
        asWireCommand({
          type: "detach",
          activeSessionId: this.record.activeSessionId,
        }),
      );
    } catch {
      // Detaching from a daemon that is gone is already done.
    }
  }

  /** Release: soft-stop anything running, detach, and stop listening. */
  async release(): Promise<void> {
    await this.interrupt();
    await this.detach();
    this.translator.resetThread(this.record.threadId);
    this.unsubscribe();
    this.closed = true;
  }

  /**
   * Discard: soft-stop anything running, then remove the session for good —
   * `kill` closes the daemon's state (reason "killed") and `delete_saved_session`
   * trashes the transcript file. Only the session identity this lane holds is
   * ever addressed: the `activeSessionId` and `sessionFile` on this record.
   *
   * A failed step throws one legible error naming it — the caller decides
   * whether to surface it, since a half-removed session (daemon state closed
   * but the file still on disk, say) is the user's to know about. Both steps
   * are one-way: a session the daemon already closed (a `session_closed` push,
   * or this lane's own successful kill) is not killed again, and deleting a
   * file that is already gone succeeds on the daemon — so a retried discard
   * converges instead of failing twice.
   */
  async destroy(): Promise<void> {
    await this.release();
    const failures: string[] = [];
    if (!this.daemonClosed && this.record.activeSessionId !== undefined) {
      try {
        const killed = await this.request(
          asWireCommand({
            type: "kill",
            activeSessionId: this.record.activeSessionId,
          }),
        );
        if (!killed.success) {
          throw new Error(killed.error ?? "unknown daemon error");
        }
        // The push listener is gone (release), so the daemon's own
        // `session_closed` push cannot mark this: record the fact here.
        this.daemonClosed = true;
      } catch (error) {
        failures.push(
          `kill failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (this.record.sessionFile !== undefined) {
      try {
        const deleted = await this.request(
          asWireCommand({
            type: "delete_saved_session",
            sessionPath: this.record.sessionFile,
          }),
        );
        if (!deleted.success) {
          throw new Error(deleted.error ?? "unknown daemon error");
        }
      } catch (error) {
        failures.push(
          `delete_saved_session failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (failures.length > 0) {
      throw new Error(
        `could not discard the prime-agent session for thread ${this.record.threadId} (${failures.join("; ")}); the session or its transcript may remain`,
      );
    }
  }

  /**
   * Timeline deltas for a session adopted from another bridge process, built
   * from the attach snapshot this lane just took.
   */
  snapshotDeltas(): void {
    this.pushDeltas(this.translator.snapshotDeltas(this.record.snapshotMessages ?? []));
  }
}

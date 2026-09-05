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
  daemonAttachResultSchema,
  daemonCreateResultSchema,
  sessionClosedSchema,
  sessionEventEnvelopeSchema,
  type DaemonEventCursor,
  type SessionEventEnvelope,
} from "./daemon/wire.js";
import {
  buildPrimeCreateCommand,
  type PrimeDynamicToolsConfig,
} from "./session-params.js";
import { primePromptText } from "./skill-mentions.js";
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
  model?: string | undefined;
  reasoningLevel?: ReasoningLevel | undefined;
  /** Extension-picker paths to load explicitly (bbpa-ggf.12), when any. */
  enabledExtensions?: readonly string[] | undefined;
  /** Dynamic-tools channel fragment for the create (bbpa-ggf.13), when any. */
  dynamicTools?: PrimeDynamicToolsConfig | undefined;
  /** bb's configured skill roots for the create (bbpa-ggf.8), when any. */
  skillRoots?: readonly string[] | undefined;
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
  /** The turn this lane is driving, while prime streams it. */
  private openTurn:
    | { clientRequestId?: ClientTurnRequestId; settledLocally: boolean }
    | undefined;

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
      model: args.model,
      reasoningLevel: args.reasoningLevel,
      enabledExtensions: args.enabledExtensions,
      dynamicTools: args.dynamicTools,
      skillRoots: args.skillRoots,
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
    const context: TranslationContext = {
      threadId: this.record.threadId,
      cwd: this.record.cwd,
      // An interrupt settled the turn locally; prime's own `agent_end` still
      // carries the item closes but must not close the turn twice.
      suppressTurnBoundary: this.openTurn?.settledLocally === true,
      onTurnSettled: () => {
        if (this.openTurn !== undefined) {
          this.openTurn.settledLocally = true;
        }
      },
    };
    this.pushDeltas(this.translator.translate(push.event, context));
  }

  private pushDeltas(deltas: readonly ThreadDelta[]): void {
    if (deltas.length === 0) {
      return;
    }
    this.emit({ threadId: this.record.threadId, deltas });
  }

  /** bb prompt text: skill mentions in prime's command form, parts joined. */
  static promptText(input: readonly PromptInput[]): string {
    return primePromptText(input);
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
    await this.request(
      asWireCommand({
        type: "prompt",
        activeSessionId: this.record.activeSessionId,
        message: PrimeSession.promptText(args.input),
      }),
    );
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
   * Timeline deltas for a session adopted from another bridge process, built
   * from the attach snapshot this lane just took.
   */
  snapshotDeltas(): void {
    this.pushDeltas(this.translator.snapshotDeltas(this.record.snapshotMessages ?? []));
  }
}

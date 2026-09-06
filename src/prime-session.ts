import type {
  ClientTurnRequestId,
  PromptInput,
  ReasoningLevel,
  ThreadDelta,
} from "@get-bb/plugin-sdk/provider-bridge";
import type { DaemonCommandResult } from "./daemon/client.js";
import type { DaemonConnectionEvent } from "./daemon/connection.js";
import type { DaemonHello, DaemonPushMessage } from "./daemon/protocol.js";
import {
  isUnknownActiveSessionError,
  readCommandData,
} from "./daemon/answer.js";
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
  daemonSessionSummarySchema,
  primeModelSchema,
  sessionClosedSchema,
  sessionEventEnvelopeSchema,
  thinkingLevelChangedEventSchema,
  type DaemonEventCursor,
  type DaemonQueueResult,
  type PrimeConnectionState,
  type PrimeModel,
  type SessionEventEnvelope,
} from "./daemon/wire.js";
import { helloWarnings } from "./daemon/protocol.js";
import {
  PRIME_THINKING_LADDER,
  buildPrimeCreateCommand,
  canonicalPrimeModelId,
  primeThinkingLevel,
  splitPrimeModelId,
  supportedPrimeThinkingLevels,
  type PrimeDynamicToolsConfig,
  type PrimeThinkingLevel,
} from "./session-params.js";
import { primePromptText } from "./skill-mentions.js";
import {
  goalStateHasContent,
  parsePrimeGoalState,
  type PrimeGoalState,
} from "./goal-state.js";
import { primeProviderThreadId } from "./vocabulary.js";
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
  /** bb's configured skill roots for the create (bbpa-ggf.8), when any. */
  skillRoots?: readonly string[] | undefined;
}

/**
 * The session facts the lane tracks about prime's side of the wire: the model
 * and thinking level the session is actually on (so a turn's `options` are
 * reconciled against reality, not against what bb last asked for), the levels
 * that model accepts (so an unsupported level is refused instead of prime's
 * silent clamp), and the compaction flags. prime reports all of it on every
 * attach snapshot's `state`; after that the lane keeps it current.
 */
export interface PrimeSessionState {
  /** Canonical `provider/modelId`, as bb spells models. */
  model: string | undefined;
  /** prime's own spelling of the current model, when known. */
  primeModel: PrimeModel | undefined;
  thinkingLevel: PrimeThinkingLevel | undefined;
  availableThinkingLevels: readonly PrimeThinkingLevel[];
  isCompacting: boolean;
  autoCompactionEnabled: boolean | undefined;
  /**
   * Clients the daemon reports on this session (story 21's "other clients"
   * badge data; bb itself is one of them). Unknown until the first read —
   * prime has no push for other clients' attach/detach (protocol spike, wire
   * facts), so the lane only knows what it has asked or been snapshotted.
   */
  attachedClients: number | undefined;
}

/** Why the lane published a state snapshot off the timeline (`provider/raw`). */
export type PrimeSessionStateSource =
  | "attach"
  | "turn-options"
  | "daemon-event"
  | "clients-read";

export interface PrimeSessionOptions {
  record: SessionRecord;
  emit: (deltas: { threadId: string; deltas: readonly ThreadDelta[] }) => void;
  subscribePush: (listener: (message: DaemonPushMessage) => void) => () => void;
  request: (command: { type: string } & Record<string, unknown>, args?: { timeoutMs?: number }) => Promise<DaemonCommandResult>;
  ensureConnected: () => Promise<DaemonHello>;
  /**
   * Connection events of the shared daemon wire (`src/daemon/connection.ts`):
   * the lane re-attaches and re-arms its snapshot boundary off `restored`, and
   * settles a turn that died with the socket off `lost` (bbpa-ggf.11).
   */
  subscribeConnection?: (
    listener: (event: DaemonConnectionEvent) => void,
  ) => () => void;
  /**
   * Off-timeline state mirror (`provider/raw {method: "prime.session_state"}`),
   * published whenever the lane learns or changes model/thinking/compaction
   * facts. bb's delta grammar has no row for these; the raw mirror is the
   * honest carrier (and what the live lane asserts against).
   */
  onState?: (state: PrimeSessionState, source: PrimeSessionStateSource) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class PrimeSession {
  private readonly record: SessionRecord;
  private readonly emit: PrimeSessionOptions["emit"];
  private readonly request: PrimeSessionOptions["request"];
  private readonly ensureConnected: PrimeSessionOptions["ensureConnected"];
  private readonly onState: PrimeSessionOptions["onState"];
  private readonly translator: PrimeDeltaTranslator;
  private readonly unsubscribe: () => void;
  private readonly unsubscribeConnection: (() => void) | undefined;

  /** Pushes that arrived before the attach snapshot fixed the boundary. */
  private buffered: SessionEventEnvelope[] = [];
  private boundary: DaemonEventCursor | undefined;
  private lastSequence = -1;
  private attached = false;
  private closed = false;
  /**
   * Open while the shared wire is down (bbpa-ggf.11): a turn that arrives
   * before the daemon answers again parks on it instead of prompting into the
   * void, and resolves once the lane re-attached — or as soon as the recovery
   * gives up, so the turn fails legibly instead of hanging.
   */
  private connectionGap: Promise<"recovered" | "unavailable"> | undefined;
  private resolveConnectionGap:
    | ((outcome: "recovered" | "unavailable") => void)
    | undefined;
  /** What the recovery reported when it gave up, for the turn's error. */
  private unavailableCause: string | undefined;
  /**
   * Set between a lost wire and the lane's own successful re-attach: while it
   * holds, best-effort commands (`abort`, `detach`) are skipped instead of
   * parking on the recovery, and turns wait for the lane to be live again.
   */
  private wireDown = false;
  /** The drift verdict this lane already warned about (one row per hello). */
  private driftSignature: string | undefined;
  /** The daemon told us it closed this session (prime quit it, eviction, …). */
  private daemonClosed = false;
  /** The turn this lane is driving, while prime streams it. */
  private openTurn:
    | { clientRequestId?: ClientTurnRequestId; settledLocally: boolean }
    | undefined;
  /** prime's side of the session: model, thinking ladder, compaction flags. */
  private state: PrimeSessionState = {
    model: undefined,
    primeModel: undefined,
    thinkingLevel: undefined,
    availableThinkingLevels: [],
    isCompacting: false,
    autoCompactionEnabled: undefined,
    attachedClients: undefined,
  };
  /**
   * Set when prime reports a manual compaction under way, cleared when it
   * reports the end. prime answers a refused compaction with an error *and*
   * with `compaction_*` events when it did run (e.g. "nothing to compact"),
   * and the difference decides whether the bridge has to settle the turn
   * itself (`compactManually`).
   */
  private compactionStarted = false;
  /**
   * The attached-client count's polling machinery (story 21): a slow interval
   * that runs only while the lane is attached, and the clock of the last read,
   * which windows the settle-time reads to one per interval. `undefined` once
   * the lane is disposed — never a reason for the process to stay alive.
   */
  private static readonly CLIENTS_REFRESH_MS = 60_000;
  private clientsTimer: ReturnType<typeof setInterval> | undefined;
  private clientsReadAt = 0;
  /**
   * The thread goal the last attach snapshot carried (bbpa-b1m.2), when it
   * described a real goal. `undefined` for a fresh session, a cleared goal,
   * or a prime too old to report the field. Consumed by `snapshotDeltas`.
   */
  private goalSeed: PrimeGoalState | undefined;
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
    this.ensureConnected = options.ensureConnected;
    this.onState = options.onState;
    this.translator = createPrimeDeltaTranslator();
    // Every command this lane sends addresses its own session, so a refusal
    // naming that id is the daemon saying the session is gone (eviction,
    // prime-side close) even when the `session_closed` push was missed — the
    // lane was not attached when it happened, say. Marking gone here keeps the
    // bridge's recovery honest instead of letting the next prompt refuse.
    this.request = async (command, args) => {
      const answer = await options.request(command, args);
      if (
        !answer.success &&
        this.record.activeSessionId !== undefined &&
        answer.error !== undefined &&
        answer.error.includes(this.record.activeSessionId) &&
        isUnknownActiveSessionError(answer.error)
      ) {
        this.markSessionGone();
      }
      return answer;
    };
    this.unsubscribe = options.subscribePush((message) => this.handlePush(message));
    this.unsubscribeConnection = options.subscribeConnection?.((event) =>
      this.handleConnectionEvent(event),
    );
  }

  get threadId(): string {
    return this.record.threadId;
  }

  /**
   * The daemon no longer hosts this session: it said so itself, either by the
   * `session_closed` push or by refusing a command with the session's own id.
   * The transcript file survives on disk — this is the bridge's cue to reopen
   * the thread from it instead of failing.
   */
  get sessionGone(): boolean {
    return this.daemonClosed;
  }

  /** Same bookkeeping the `session_closed` push runs; idempotent. */
  private markSessionGone(): void {
    this.daemonClosed = true;
    this.closed = true;
    this.stopClientsPoll();
  }

  get hasOpenTurn(): boolean {
    return this.openTurn !== undefined && !this.openTurn.settledLocally;
  }

  /** The session facts as the lane currently believes them (tests, mirrors). */
  currentState(): PrimeSessionState {
    return { ...this.state };
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
    // The create funnel is the session's initial model/thinking state; attach
    // (right below) replaces it with prime's own report, which is the truth
    // the next turn's options are reconciled against.
    this.state = {
      ...this.state,
      model: args.model,
      primeModel: undefined,
      thinkingLevel: primeThinkingLevel(args.reasoningLevel),
      availableThinkingLevels: [],
    };
    await this.attach();
    // The provider thread id is daemon-derived, so a resumed thread points at
    // the same session no matter which bridge process created it. The bridge
    // re-indexes the record under it (`adoptProviderThreadId`).
    return {
      // The create parse above admits only answers with an activeSessionId.
      providerThreadId: primeProviderThreadId(created.activeSessionId!),
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
    // The snapshot's `state` is prime's own report of what the session runs:
    // the model, the thinking ladder that model accepts, and the compaction
    // flags. Everything the model/compaction work reconciles against.
    if (answer.snapshot?.state !== undefined) {
      this.adoptState(answer.snapshot.state);
      // The snapshot's `state.goal` is the thread goal as prime persisted it
      // (bbpa-b1m.2): remembered here so an adopted thread's replay ends with
      // the goal row already on its timeline.
      const goal = parsePrimeGoalState(answer.snapshot.state.goal);
      this.goalSeed =
        goal !== undefined && goalStateHasContent(goal) ? goal : undefined;
    }
    // The snapshot's summary is a SessionSummary read, so the attached-client
    // count (story 21) rides the attach for free — the badge's first datum.
    const clientsLearned = this.learnClientsFromSummary(answer.snapshot?.summary);
    if (answer.snapshot?.state !== undefined || clientsLearned) {
      this.publishState("attach");
    }
    this.startClientsPoll();
    // The roster of live subagents as the daemon sees it right now: the panel's
    // seed and, for an adopted session, the only record of children spawned
    // while no bridge was attached.
    this.record.snapshotChildren = answer.snapshot?.children ?? [];
    // The snapshot is the boundary: everything at or before its cursor is
    // already in it, so only strictly newer events stream.
    this.boundary = answer.lastEventCursor ?? answer.snapshot?.lastEventCursor;
    this.lastSequence =
      answer.lastEventSequence ?? answer.snapshot?.lastEventSequence ?? -1;
    const stale = this.buffered;
    this.buffered = [];
    this.attached = true;
    this.record.snapshotMessages = snapshotMessages;
    // Drift is a warning, never a block (ADR-0002): every attach reads the
    // answered hello against the calibration and says so once per verdict, on
    // the timeline where the thread's user can see it.
    this.warnAboutProtocolDrift({ warnings: await this.helloWarningsFromWire() });
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

  /** Take over the session facts prime just reported about itself. */
  private adoptState(state: PrimeConnectionState): void {
    const ladder = (state.availableThinkingLevels ?? []).filter((level): level is PrimeThinkingLevel =>
      (PRIME_THINKING_LADDER as readonly string[]).includes(level),
    );
    this.state = {
      model:
        state.model !== undefined ? canonicalPrimeModelId(state.model) : this.state.model,
      primeModel: state.model,
      thinkingLevel:
        (state.thinkingLevel ?? undefined) === undefined
          ? this.state.thinkingLevel
          : ((state.thinkingLevel ?? undefined) as PrimeThinkingLevel | undefined),
      availableThinkingLevels: ladder,
      isCompacting: state.isCompacting ?? false,
      autoCompactionEnabled: state.autoCompactionEnabled,
      // The connection state carries no client roster: the count is the poll's
      // business (story 21), so an attach snapshot keeps what was last read.
      attachedClients: this.state.attachedClients,
    };
  }

  /** Publish the session facts off the timeline (`provider/raw`, no deltas). */
  private publishState(source: PrimeSessionStateSource): void {
    this.onState?.({ ...this.state }, source);
  }

  /* --------------------- the attached-clients badge (story 21) --------------------- */

  /**
   * Adopt the attached-client count a session summary carried. Reports whether
   * it moved, so the caller knows whether the mirror is worth republishing.
   */
  private learnClientsFromSummary(summary: unknown): boolean {
    const parsed = daemonSessionSummarySchema.safeParse(summary);
    const attached = parsed.success ? parsed.data.attachedClients : undefined;
    if (typeof attached !== "number" || attached === this.state.attachedClients) {
      return false;
    }
    this.state = { ...this.state, attachedClients: attached };
    return true;
  }

  /**
   * Re-read the attached-client count (`get_state`) and mirror it when it
   * moved. Prime announces no other client's attach or detach (protocol spike,
   * wire facts: `SessionSummary.attachedClients`, no push event), so the badge
   * can only poll. Best-effort by design: a daemon that will not answer
   * `get_state` says nothing, and the previously known count stands.
   */
  private async refreshClients(): Promise<void> {
    if (
      this.closed ||
      !this.attached ||
      this.wireDown ||
      this.record.activeSessionId === undefined
    ) {
      return;
    }
    this.clientsReadAt = Date.now();
    try {
      const state = await this.request(
        asWireCommand({
          type: "get_state",
          activeSessionId: this.record.activeSessionId,
        }),
      );
      if (state.success && this.learnClientsFromSummary(state.data)) {
        this.publishState("clients-read");
      }
    } catch {
      // The badge is a mirror, never a dependency.
    }
  }

  /** The windowed settle-time read: at most one per refresh interval. */
  private refreshClientsWhenStale(): void {
    if (Date.now() - this.clientsReadAt < PrimeSession.CLIENTS_REFRESH_MS) {
      return;
    }
    void this.refreshClients();
  }

  /** Poll the count for as long as this lane is attached to the session. */
  private startClientsPoll(): void {
    if (this.clientsTimer !== undefined || this.closed) {
      return;
    }
    // The attach itself observed the session (its summary), so the window
    // starts here even when that summary carried no count.
    if (this.clientsReadAt === 0) {
      this.clientsReadAt = Date.now();
    }
    this.clientsTimer = setInterval(() => {
      void this.refreshClients();
    }, PrimeSession.CLIENTS_REFRESH_MS);
    // Never a reason for the bridge process to stay alive on its own.
    this.clientsTimer.unref?.();
  }

  private stopClientsPoll(): void {
    if (this.clientsTimer !== undefined) {
      clearInterval(this.clientsTimer);
      this.clientsTimer = undefined;
    }
  }

  /**
   * Reconcile a turn's execution options onto the running session: prime
   * switches model and thinking level in place (`set_model`/`set_thinking_level`
   * on the same resident session — no rebuild, no id-space boundary), so a
   * thread's model applies from its next turn on. A no-op change sends nothing.
   *
   * Throws honestly when bb asks for a thinking level the (target) model does
   * not support: prime would clamp silently and write the clamped level into
   * the user's global settings, which is not ours to cause.
   */
  async applyTurnOptions(args: {
    model?: string | undefined;
    reasoningLevel?: ReasoningLevel | undefined;
  }): Promise<void> {
    if (this.record.activeSessionId === undefined) {
      // The turn path checks this first; nothing to reconcile against.
      return;
    }
    // A turn submitted while the daemon restarts waits for the re-attach: it
    // must be this lane that attaches, or prime streams its events to nobody.
    await this.awaitLive();
    const target = args.model === undefined ? undefined : splitPrimeModelId(args.model);
    if (target !== undefined && this.state.model !== args.model) {
      const model = await this.setModel(target);
      // A model switch re-clamps the level on prime's side; keep the level only
      // if the new ladder still has it, "unknown" otherwise.
      const kept = this.state.thinkingLevel;
      this.state = {
        ...this.state,
        model: canonicalPrimeModelId(model),
        primeModel: model,
        availableThinkingLevels: supportedPrimeThinkingLevels(model),
        thinkingLevel: supportedPrimeThinkingLevels(model).includes(kept ?? "off")
          ? kept
          : undefined,
      };
    }
    const level = primeThinkingLevel(args.reasoningLevel);
    if (level === undefined) {
      // bb levels prime has no word for (ultracode/ultra) stay untranslated.
      return;
    }
    if (this.state.thinkingLevel === level) {
      // The session already runs it (a level prime clamped into place is
      // exactly this case) — send nothing, whatever the reported ladder says.
      return;
    }
    const ladder = this.state.availableThinkingLevels;
    if (ladder.length > 0 && !ladder.includes(level)) {
      throw new Error(
        `prime-agent model ${this.state.model ?? "(unknown)"} does not offer thinking level "${level}"${
          ladder.length > 0 ? ` (it offers: ${ladder.join(", ")})` : ""
        }; pick one of the model's supported levels`,
      );
    }
    await this.request(
      asWireCommand({
        type: "set_thinking_level",
        activeSessionId: this.record.activeSessionId,
        level,
      }),
    );
    this.state = { ...this.state, thinkingLevel: level };
    this.publishState("turn-options");
  }

  /** `set_model`, answered with the model prime switched to. */
  private async setModel(target: {
    provider: string;
    modelId: string;
  }): Promise<PrimeModel> {
    const result = readCommandData(
      await this.request(
        asWireCommand({
          type: "set_model",
          activeSessionId: this.record.activeSessionId!,
          provider: target.provider,
          modelId: target.modelId,
        }),
      ),
      "set_model",
      (data) => {
        // prime answers with the model object itself (older wires may wrap it).
        const candidate =
          isRecord(data) && isRecord(data.model) ? data.model : data;
        const parsed = primeModelSchema.safeParse(candidate);
        return parsed.success
          ? { success: true as const, data: parsed.data }
          : { success: false as const, issues: "no model in the answer" };
      },
    );
    return result;
  }

  /**
   * Manual compaction (bb's standalone builtin `/compact` prompt): prime
   * compacts the resident session in place and streams `compaction_start`/
   * `compaction_end` events, which the translator turns into the timeline —
   * a manual compaction opens its own turn and settles it, so this method
   * only has to settle the turn itself when prime never started compacting
   * (a refusal that streamed no events, e.g. the session is gone).
   */
  async compactManually(): Promise<void> {
    if (this.record.activeSessionId === undefined) {
      throw new Error("cannot compact before the session is created");
    }
    await this.awaitLive();
    this.compactionStarted = false;
    let refused: string | undefined;
    try {
      const result = await this.request(
        asWireCommand({ type: "compact", activeSessionId: this.record.activeSessionId }),
      );
      if (!result.success) {
        refused = result.error ?? "the daemon refused the compaction";
      }
    } catch (error) {
      refused = error instanceof Error ? error.message : String(error);
    }
    if (refused !== undefined && !this.compactionStarted) {
      // Prime never streamed a compaction: nothing else will settle this turn.
      this.pushDeltas(
        this.translator.failureDeltas(this.record.threadId, {
          message: "prime-agent could not compact the context",
          detail: refused,
        }),
      );
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
      // The daemon closed the session (prime quit it, update restart, idle
      // eviction, …). The session file survives on disk; the lane stops
      // streaming and reports gone so the bridge can reopen the thread.
      this.markSessionGone();
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

  /* --------------------- daemon restart resilience (bbpa-ggf.11) --------------------- */

  private handleConnectionEvent(event: DaemonConnectionEvent): void {
    if (this.closed) {
      return;
    }
    switch (event.kind) {
      case "lost":
        this.handleConnectionLost(event.cause);
        return;
      case "restored":
        void this.handleConnectionRestored(event);
        return;
      case "unavailable":
        // The reconnect budget is gone. Every parked turn wakes up now and
        // fails with this cause instead of waiting on a daemon that left.
        this.unavailableCause = event.cause;
        this.resolveConnectionGap?.("unavailable");
        return;
    }
  }

  /**
   * The shared wire dropped (daemon update, restart, crash). A turn prime was
   * streaming died with the socket: settle it here, with a legible provider
   * error, so bb's timeline closes instead of waiting on a daemon that is not
   * there. Then park until the daemon answers again.
   */
  private handleConnectionLost(cause: string): void {
    if (
      this.record.activeSessionId === undefined ||
      this.connectionGap !== undefined
    ) {
      return;
    }
    if (this.openTurn !== undefined && !this.openTurn.settledLocally) {
      this.openTurn = { ...this.openTurn, settledLocally: true };
      this.pushDeltas(
        this.translator.failureDeltas(this.record.threadId, {
          message:
            "the prime-agent daemon connection dropped mid-turn; the turn did not finish",
          detail: cause,
        }),
      );
    }
    this.wireDown = true;
    this.connectionGap = new Promise((resolve) => {
      this.resolveConnectionGap = resolve;
    });
  }

  /**
   * The daemon is back. Re-attach for a *fresh snapshot*: the boundary moves to
   * the daemon's own clock, so everything the respawned session replays that
   * this thread already counted is dropped — the timeline continues without
   * duplicating or losing a turn. Snapshot *content* is never re-rendered
   * here: bb persists this thread's timeline, and the session the daemon
   * restored is the same one (`prime_<activeSessionId>`).
   */
  private async handleConnectionRestored(event: {
    hello: DaemonHello;
    warnings: string[];
  }): Promise<void> {
    if (this.record.activeSessionId === undefined) {
      return;
    }
    try {
      await this.attach();
    } catch {
      // The daemon came back without this session (or is still warming up):
      // the gap stays open and the next turn retries the attach once, rather
      // than the lane going silently deaf.
      return;
    }
    this.wireDown = false;
    if (event.warnings.length > 0) {
      this.warnAboutProtocolDrift({ warnings: event.warnings });
    } else {
      this.pushDeltas([
        {
          kind: "provider.warning",
          category: "general",
          summary:
            "the prime-agent daemon restarted; this thread re-attached to its session",
        },
      ]);
    }
    this.settleConnectionGap("recovered");
  }

  /**
   * Hold a turn until the lane is live again. Resolves once the daemon is back
   * and the lane re-attached; throws one legible error when the daemon never
   * came back — after one honest re-attach attempt, because a daemon that
   * returned just after the recovery budget is still worth resuming.
   */
  private async awaitLive(): Promise<void> {
    while (this.connectionGap !== undefined) {
      const outcome = await this.connectionGap;
      if (this.connectionGap === undefined) {
        return;
      }
      if (outcome === "recovered") {
        continue;
      }
      try {
        await this.attach();
      } catch (error) {
        throw new Error(
          `the prime-agent daemon did not come back for thread ${this.record.threadId}: ${
            this.unavailableCause ?? (error instanceof Error ? error.message : String(error))
          }`,
        );
      }
      // The daemon was only late: this lane is live again, and the parked turn
      // (and every other one) may proceed.
      this.wireDown = false;
      this.settleConnectionGap("recovered");
    }
  }

  private settleConnectionGap(outcome: "recovered" | "unavailable"): void {
    const resolve = this.resolveConnectionGap;
    this.connectionGap = undefined;
    this.resolveConnectionGap = undefined;
    resolve?.(outcome);
  }

  /**
   * Surface a hello that differs from the calibration (generation staleness,
   * schema revision, app version, capability roster) as a timeline warning.
   * One row per distinct verdict: a resume on the same daemon says nothing
   * twice, a restart onto a different build says the new thing once.
   */
  private warnAboutProtocolDrift(args: { warnings: readonly string[] }): void {
    if (args.warnings.length === 0) {
      return;
    }
    const signature = args.warnings.join(" | ");
    if (signature === this.driftSignature) {
      return;
    }
    this.driftSignature = signature;
    this.pushDeltas([
      {
        kind: "provider.warning",
        category: "general",
        summary:
          "protocol drift between this bridge and prime-agent; the thread keeps working where the daemon's capabilities allow",
        details: args.warnings.join(" "),
      },
    ]);
  }

  /** The answered hello, when the wire can produce one (warnings are best-effort). */
  private async helloWarningsFromWire(): Promise<string[]> {
    try {
      return helloWarnings(await this.ensureConnected());
    } catch {
      // A wire that will not come back says nothing about drift.
      return [];
    }
  }

  private deliver(push: SessionEventEnvelope): void {    this.trackSessionFacts(push.event);
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
      // The active model's context window (bbpa-b1m.9): the lane owns the
      // adopted session facts (attach snapshot, model switches); the
      // translator only reads what this event's context carries.
      modelContextWindow: this.state.primeModel?.contextWindow,
      // Same discipline for the turn-throughput row (bbpa-b1m.10): the lane
      // owns the clock and the model id; the translator only records stamps.
      now: Date.now(),
      model: this.state.model,
      // An interrupt settled the turn locally; prime's own `agent_end` still
      // carries the item closes but must not close the turn twice.
      suppressTurnBoundary: this.openTurn?.settledLocally === true,
      ...(checkpointId === undefined ? {} : { providerCheckpointId: checkpointId }),
      onTurnSettled: () => {
        if (this.openTurn !== undefined) {
          this.openTurn.settledLocally = true;
        }
        // A settled turn is a natural moment to re-read the attached-client
        // count (story 21) — windowed, so a thread turning steadily costs no
        // extra commands beyond the slow poll.
        this.refreshClientsWhenStale();
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

  /**
   * Track the session facts prime announces in its event stream: the thinking
   * level (moves on `set_thinking_level` and whenever prime re-clamps after a
   * model switch) and the compaction flags. None of these has a bb timeline
   * row — the compaction *events* do, and the translator renders them — so the
   * lane only keeps them current and mirrors them off the timeline.
   */
  private trackSessionFacts(event: unknown): void {
    if (typeof event !== "object" || event === null) {
      return;
    }
    const type = (event as Record<string, unknown>).type;
    if (type === "thinking_level_changed") {
      const parsed = thinkingLevelChangedEventSchema.safeParse(event);
      if (parsed.success && typeof parsed.data.level === "string") {
        this.state = {
          ...this.state,
          thinkingLevel: parsed.data.level as PrimeThinkingLevel,
        };
        this.publishState("daemon-event");
      }
      return;
    }
    if (type === "compaction_start") {
      this.compactionStarted = true;
      this.state = { ...this.state, isCompacting: true };
      this.publishState("daemon-event");
      return;
    }
    if (type === "compaction_end") {
      this.compactionStarted = false;
      this.state = { ...this.state, isCompacting: false };
      this.publishState("daemon-event");
    }
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
    await this.awaitLive();
    this.openTurn = {
      clientRequestId: args.clientRequestId,
      settledLocally: false,
    };
    // The anchor is queued with the send: prime settles every admitted input
    // with an agent_end, which consumes it. If the prompt is refused, the
    // anchor is taken back so the FIFO stays aligned with prime's runs.
    this.queueCheckpoint(primePromptText(args.input));
    try {
      const answer = await this.request(
        asWireCommand({
          type: "prompt",
          activeSessionId: this.record.activeSessionId,
          message: primePromptText(args.input),
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
      if (!answer.success) {
        // A refused prompt admitted nothing: the caller must know (a silent
        // "ok" would strand the user's message on a session prime declined),
        // and the eviction recovery keys off exactly this refusal.
        throw new Error(
          `prime-agent refused "prompt": ${answer.error ?? "unknown daemon error"}`,
        );
      }
    } catch (error) {
      this.pendingCheckpoints.pop();
      throw error;
    }
  }

  /**
   * Steer prime with a user message — the one primitive behind bb's steer,
   * whatever the lane state. While a turn of ours is open, the steer rides
   * prime's mid-turn prompt (`prompt {streamingBehavior: "steer"}`): per the
   * protocol spike (`docs/spikes/0001-prime-daemon-protocol.md`, wire facts)
   * that message is delivered after the current tool round and before the next
   * model call — exactly bbpa-ggf.5's acceptance criterion — and
   * `queueIfBusy` keeps the streaming turn's seat. The daemon's `steer`
   * command on the calibrated 0.7.3 delivers only when the run settles, so it
   * is the idle-lane form alone: there `resumeIfIdle` starts the fresh run
   * that answers the steer, so a steer is never a silent no-op. Neither form
   * ever interrupts anything.
   */
  async steer(args: { input: readonly PromptInput[] }): Promise<void> {
    if (this.record.activeSessionId === undefined) {
      throw new Error("cannot steer before the session is created");
    }
    await this.awaitLive();
    const midTurn = this.hasOpenTurn;
    this.openTurn = { settledLocally: false };
    this.queueCheckpoint(primePromptText(args.input));
    try {
      await readCommandData(
        await this.request(
          asWireCommand(
            midTurn
              ? {
                  type: "prompt",
                  activeSessionId: this.record.activeSessionId,
                  message: primePromptText(args.input),
                  streamingBehavior: "steer",
                  queueIfBusy: true,
                }
              : {
                  type: "steer",
                  activeSessionId: this.record.activeSessionId,
                  message: primePromptText(args.input),
                },
          ),
        ),
        midTurn ? "prompt" : "steer",
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
    if (
      this.record.activeSessionId !== undefined &&
      this.hasOpenTurn &&
      // A wire that is down and recovering would park this abort for the whole
      // recovery budget; the turn is already settled locally, so there is
      // nothing left for the daemon to abort.
      !this.wireDown
    ) {
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
    if (this.record.activeSessionId === undefined || this.wireDown) {
      // A daemon that is restarting has already lost this client's seat;
      // detaching from it can wait (and the next attach supersedes it).
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

  /**
   * Release: detach, stop listening, and — unless asked not to — soft-stop
   * whatever is running. The interrupt is the *user-invoked* release's
   * semantics (`thread/stop`): bb asked to let go, so the turn it owns stops.
   * The process-close path (closing bb) releases with `interrupt: false`
   * instead: the resident session is the artifact bb's threads point at, and
   * story 18 wants long-running work to outlive the app — prime keeps
   * streaming, and the turn's output reaches whoever attaches next.
   */
  async release(args: { interrupt?: boolean } = {}): Promise<void> {
    this.settleConnectionGap("unavailable");
    this.stopClientsPoll();
    if (args.interrupt !== false) {
      await this.interrupt();
    }
    await this.detach();
    this.translator.resetThread(this.record.threadId);
    this.unsubscribe();
    this.unsubscribeConnection?.();
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
   * from the attach snapshot this lane just took: the transcript, then the
   * subagents the roster still holds (live ones stay open, finished ones
   * settle immediately).
   */
  snapshotDeltas(): void {
    this.pushDeltas(
      this.translator.snapshotDeltas(this.record.snapshotMessages ?? []),
    );
    this.pushDeltas(
      this.translator.childrenDeltas(
        this.record.snapshotChildren ?? [],
        this.record.threadId,
      ),
    );
    if (this.goalSeed !== undefined) {
      this.pushDeltas(
        this.translator.goalDeltas(this.goalSeed, this.record.threadId),
      );
      this.goalSeed = undefined;
    }
  }

  /**
   * Clear the thread goal (bbpa-b1m.2): bb's goal-clear affordance rides the
   * bridge's `thread/goal/clear` request, and prime's only way to clear a
   * goal is its own `/goal clear` session command — there is no goal RPC
   * (wire fact, probe 2026-09-06). So the request becomes that command as a
   * control prompt: admitted like any prompt (a busy session takes it on the
   * follow-up lane), producing the command rows and the `goal_update` that
   * closes the timeline row. Deliberately no turn bookkeeping: bb called this
   * as thread metadata, not as a user turn, and prime settles every admitted
   * input with its own `agent_end` regardless.
   */
  async clearGoal(): Promise<void> {
    if (this.record.activeSessionId === undefined) {
      throw new Error("cannot clear the goal before the session is created");
    }
    await this.awaitLive();
    const answer = await this.request(
      asWireCommand({
        type: "prompt",
        activeSessionId: this.record.activeSessionId,
        message: "/goal clear",
        streamingBehavior: "followUp",
      }),
    );
    if (!answer.success) {
      throw new Error(
        `prime-agent refused "prompt": ${answer.error ?? "unknown daemon error"}`,
      );
    }
  }
}

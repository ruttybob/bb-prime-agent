import {
  BRIDGE_JSON_RPC_ERRORS,
  BRIDGE_NOTIFICATION_METHODS,
  BRIDGE_REQUEST_METHODS,
  PROVIDER_BRIDGE_PROTOCOL_VERSION,
  THREAD_DELTA_GRAMMAR_V3,
  THREAD_DELTA_NOTIFICATION_METHOD,
  createBridgeIo,
  createPendingToolCallTracker,
  experimental_defineProviderBridge,
  isStandaloneBuiltinCompactCommand,
  initializeParamsSchema,
  modelListParamsSchema,
  providerMaintenanceParamsSchema,
  providerInstallationRunParamsSchema,
  providerInstallationStatusParamsSchema,
  runBridgeRequest,
  skillsConfigureParamsSchema,
  threadDiscardParamsSchema,
  threadForkParamsSchema,
  threadGoalClearParamsSchema,
  threadNameSetParamsSchema,
  threadResumeParamsSchema,
  threadStartParamsSchema,
  threadStopParamsSchema,
  threadArchiveParamsSchema,
  threadUnarchiveParamsSchema,
  turnStartParamsSchema,
  turnSteerParamsSchema,
  type ClientTurnRequestId,
  type BridgeJsonRpcResponse,
  type PromptInput,
  type ProviderBridgeContext,
  type ReasoningLevel,
  type ThreadDelta,
} from "@get-bb/plugin-sdk/provider-bridge";
import { primeProviderHealthCached } from "./health.js";
import {
  DynamicToolsRegistry,
  type DynamicToolsSessionConfig,
} from "./dynamic-tools/registry.js";
import {
  daemonRequest,
  ensureDaemonConnection,
  onDaemonConnectionEvent,
  onDaemonPush,
  resetDaemonConnectionForTests,
} from "./daemon/connection.js";
import { primeAvailableModels } from "./model-catalog.js";
import { resolveDaemonSocketPath } from "./daemon/socket.js";
import { asWireCommand } from "./daemon/transport.js";
import { daemonSessionSummarySchema } from "./daemon/wire.js";
import { primeSessionName } from "./session-params.js";
import { primePromptText } from "./skill-mentions.js";
import {
  primeActiveSessionIdFrom,
  provisionalPrimeProviderThreadId,
} from "./vocabulary.js";
import { PrimeSession } from "./prime-session.js";
import { forkPrimeSession } from "./fork-session.js";
import { enabledExtensionsFromProviderOptions } from "./user-extensions.js";
import {
  SessionTable,
  type ConfiguredSkillRoot,
  type SessionRecord,
} from "./session-table.js";
import { sessionSkillRoots } from "./session-params.js";

/**
 * The prime-agent provider bridge.
 *
 * The chat path is real: `thread/start` creates a daemon-resident prime session
 * named with the "[bb] " prefix in the bb environment's cwd
 * (`src/session-params.ts` is the only place those params are built),
 * `turn/start` prompts it and streams prime's session events into the bb
 * timeline as deltas (`src/delta-translation.ts`), and `thread/stop` soft-stops
 * (`abort`) so the session file survives. Sessions are daemon-owned: closing bb
 * (or releasing a thread) leaves the session running in the
 * daemon, and a reopen (`thread/resume` by the daemon-derived provider thread
 * id) attaches to it and rebuilds the timeline from the attach snapshot
 * (bbpa-ggf.4). Discard is the one destructive path: soft stop, then `kill` +
 * `delete_saved_session` for exactly the session the thread's record names.
 * Forking (bbpa-ggf.7) branches the source session's transcript at the
 * requested point into a NEW session for the new thread — the bracketed
 * replace-in-place dance lives in `src/fork-session.ts`, and the fork anchors
 * ride the turn boundaries as checkpoint ids (`src/fork-points.ts`). Renames
 * keep the "[bb] " prefix on prime's catalog name.
 */
type JsonRpcId = string | number;

const io = createBridgeIo();

type OutboundMessage = { jsonrpc: "2.0" } & Record<string, unknown>;

function notify(method: string, params: Record<string, unknown>): void {
  const message: OutboundMessage = { jsonrpc: "2.0", method, params };
  io.send(message);
}

function emitDeltas(threadId: string, deltas: readonly ThreadDelta[]): void {
  if (deltas.length === 0) {
    return;
  }
  notify(THREAD_DELTA_NOTIFICATION_METHOD, { threadId, deltas: [...deltas] });
}

/** Session records, one per bb thread; process-local by design (see module docs). */
const sessions = new SessionTable();

/**
 * The bb dynamic-tools channel registry (ADR-0003, bbpa-ggf.13): one channel
 * per thread that declares dynamic tools. Channels are keyed by the bb thread
 * id — stable across the daemon-id adoption and across bridge processes, so a
 * resumed session's extension reconnects to the same socket path.
 */
const dynamicTools = new DynamicToolsRegistry();

/**
 * Outbound `item/tool/call` correlation: dynamic-tool calls from the companion
 * extension ride this tracker, which mints the JSON-RPC ids, writes the
 * request lines through the bridge's own stdout, and settles on the runtime's
 * responses (`handleLine` routes them below).
 */
const toolCalls = createPendingToolCallTracker({
  sendToolCall: (request) => io.send(request),
});

/**
 * Skill roots from `skills/configure`, consumed when sessions are created.
 *
 * bb sends the catalog of *its own* skills once per process, after the
 * handshake and before the first thread command, to a bridge that declared
 * `skills: {configure: true}`. prime discovers its own skills worker-side
 * (`noSkills: false`), so the catalog informs nothing on prime's behalf — it
 * is what lets a *bb* skill resolve inside a prime session: the roots join
 * `create.config.skills` (prime's additive `--skill` form) for every session
 * created after the configure arrived.
 */
let configuredSkillRoots: readonly ConfiguredSkillRoot[] = [];

/** The configured root paths a new session loads (`create.config.skills`). */
function configuredSkillRootPaths(): string[] {
  return sessionSkillRoots(configuredSkillRoots.map((root) => root.path)) ?? [];
}

let bridgeContext: ProviderBridgeContext | undefined;

function registerSession(args: {
  threadId: string;
  providerThreadId?: string;
  cwd: string;
  dynamicTools: SessionRecord["dynamicTools"];
}): SessionRecord {
  return sessions.register({
    threadId: args.threadId,
    providerThreadId: args.providerThreadId ?? provisionalPrimeProviderThreadId(args.threadId),
    cwd: args.cwd,
    createdAt: Date.now(),
    dynamicTools: args.dynamicTools,
    turns: 0,
  });
}

/**
 * Every session construction is a provider id-space boundary: identity first,
 * then `session.reset`, then the result — in that order, on the wire.
 */
function announceSession(record: SessionRecord): void {
  notify(BRIDGE_NOTIFICATION_METHODS.threadIdentity, {
    threadId: record.threadId,
    providerThreadId: record.providerThreadId,
  });
  emitDeltas(record.threadId, [{ kind: "session.reset" }]);
}

/**
 * Start this thread's dynamic-tools channel, if it declares bb tools. Called
 * BEFORE the daemon `create` — the companion extension connects while the
 * prime worker boots, so the channel must already be listening. Returns the
 * `create.config` fragment that loads the extension, or `undefined` when the
 * thread declares no dynamic tools.
 */
async function ensureDynamicToolsChannel(
  record: SessionRecord,
): Promise<DynamicToolsSessionConfig | undefined> {
  if (record.dynamicTools.length === 0) {
    return undefined;
  }
  try {
    await dynamicTools.start({
    providerThreadId: record.threadId,
    onToolCall: async (call) => {
      try {
        const result = await toolCalls.forwardToolCall({
          // Read through the record at call time: the daemon-derived provider
          // thread id replaces the provisional one right after `create`.
          providerThreadId: record.providerThreadId,
          threadId: record.threadId,
          scope: record,
          toolName: call.name,
          arguments: call.args,
        });
        return { ok: true as const, ...result };
      } catch (error) {
        return {
          ok: false as const,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });
    return dynamicTools.sessionConfig(record.threadId);
  } catch (error) {
    // Degraded, not dead: the thread runs without bb tools rather than
    // failing, and the runtime hears about it off the timeline.
    notifyDynamicToolsDegraded(record, error);
    return undefined;
  }
}

/** Publish the thread's bb tool set to its (now connected) companion extension. */
async function publishDynamicTools(record: SessionRecord): Promise<void> {
  if (record.dynamicTools.length === 0) {
    return;
  }
  try {
    await dynamicTools.setTools(record.threadId, record.dynamicTools);
  } catch (error) {
    notifyDynamicToolsDegraded(record, error);
  }
}

/** Off-timeline diagnostics for a thread whose bb tools could not be armed. */
function notifyDynamicToolsDegraded(record: SessionRecord, error: unknown): void {
  notify(BRIDGE_NOTIFICATION_METHODS.providerRaw, {
    method: "dynamic-tools.degraded",
    params: {
      threadId: record.threadId,
      error: error instanceof Error ? error.message : String(error),
    },
  });
}

/** Stop a thread's dynamic-tools channel (record dropped: release or discard). */
function stopDynamicTools(record: SessionRecord | undefined): Promise<void> {
  if (record === undefined) {
    return Promise.resolve();
  }
  return dynamicTools.stop(record.threadId);
}

function sessionFor(record: SessionRecord): PrimeSession {
  const session = record.session;
  if (session === undefined) {
    throw new Error(
      `the prime session for thread ${record.threadId} is not attached yet`,
    );
  }
  return session;
}

/**
 * The transcript file a rename of an inactive session addresses. The record's
 * own file wins; a thread this process released (record dropped on `release`)
 * is still renamed honestly through the daemon-derived provider thread id —
 * the session either answers `get_state` or the rename fails legibly.
 */
async function sessionFileForRenaming(
  record: SessionRecord | undefined,
  providerThreadId: string,
  threadId: string,
): Promise<string> {
  if (record?.sessionFile !== undefined) {
    return record.sessionFile;
  }
  const activeSessionId = primeActiveSessionIdFrom(providerThreadId);
  if (activeSessionId !== undefined) {
    const state = await daemonRequest(
      asWireCommand({ type: "get_state", activeSessionId }),
    );
    if (state.success) {
      const summary = daemonSessionSummarySchema.safeParse(state.data);
      if (summary.success && summary.data.sessionFile !== undefined) {
        return summary.data.sessionFile;
      }
    }
  }
  throw new Error(
    `no prime-agent session is known for thread ${threadId} (${providerThreadId}); there is nothing to rename`,
  );
}

function laneFor(record: SessionRecord): PrimeSession {
  const session = new PrimeSession({
    record,
    emit: ({ threadId, deltas }) => emitDeltas(threadId, deltas),
    subscribePush: onDaemonPush,
    // Daemon-restart resilience (bbpa-ggf.11): the lane hears the shared wire's
    // drops and recoveries itself — it settles the turn that died with the
    // socket, re-attaches on a fresh snapshot, and warns about hello drift.
    subscribeConnection: onDaemonConnectionEvent,
    request: (command, args) => daemonRequest(command, args),
    ensureConnected: ensureDaemonConnection,
    // bb's delta grammar has no row for model/thinking/compaction *state*; the
    // lane mirrors it off the timeline so it stays observable (tests, debug).
    onState: (state, source) => {
      notify(BRIDGE_NOTIFICATION_METHODS.providerRaw, {
        method: "prime.session_state",
        params: {
          threadId: record.threadId,
          providerThreadId: record.providerThreadId,
          source,
          model: state.model,
          thinkingLevel: state.thinkingLevel,
          availableThinkingLevels: [...state.availableThinkingLevels],
          isCompacting: state.isCompacting,
          autoCompactionEnabled: state.autoCompactionEnabled,
          // Story 21's badge: who else is attached to this resident session.
          // Poll-sourced (prime has no push for other clients' attach/detach),
          // and `undefined` until the first read — JSON drops the keys then.
          attachedClients: state.attachedClients,
          otherClients:
            state.attachedClients === undefined
              ? undefined
              : Math.max(0, state.attachedClients - 1),
        },
      });
    },
  });
  record.session = session;
  return session;
}

/** Create the resident session, announce it, and stream its first turn. */
async function startSession(args: {
  record: SessionRecord;
  title?: string | undefined;
  /** An existing transcript to adopt (the fork branch, bbpa-ggf.7), when any. */
  sessionPath?: string | undefined;
  model?: string | undefined;
  reasoningLevel?: ReasoningLevel | undefined;
  /** The extension picker's selection, read from this command's options. */
  enabledExtensions?: readonly string[] | undefined;
  input: readonly PromptInput[] | undefined;
  /** bb's configured skill roots for the new session (bbpa-ggf.8), when any. */
  skillRoots?: readonly string[] | undefined;
  /** Runs after the session exists but before the first prompt — the window
   * where the dynamic-tools set must be published, so the model's first turn
   * already sees the bb tools. */
  beforeFirstTurn?: () => Promise<void>;
}): Promise<void> {
  const { record } = args;
  try {
    const session = laneFor(record);
    const identity = await session.start({
      threadId: record.threadId,
      cwd: record.cwd,
      title: args.title,
      sessionPath: args.sessionPath,
      model: args.model,
      reasoningLevel: args.reasoningLevel,
      enabledExtensions: args.enabledExtensions,
      dynamicTools: dynamicTools.sessionConfig(record.threadId),
      skillRoots: args.skillRoots,
    });
    sessions.adoptProviderThreadId(record, identity.providerThreadId);
  } catch (error) {
    sessions.drop(record.threadId);
    throw error;
  }
  announceSession(record);
  await args.beforeFirstTurn?.();
  if (args.input !== undefined && args.input.length > 0) {
    await runTurn({ record, input: args.input, clientRequestId: undefined });
  }
}

async function runTurn(args: {
  record: SessionRecord;
  input: readonly PromptInput[];
  clientRequestId: ClientTurnRequestId | undefined;
  model?: string | undefined;
  reasoningLevel?: ReasoningLevel | undefined;
}): Promise<void> {
  const { record } = args;
  record.turns += 1;
  if (args.clientRequestId !== undefined) {
    emitDeltas(record.threadId, [
      { kind: "input.accepted", clientRequestId: args.clientRequestId },
    ]);
  }
  const session = sessionFor(record);
  // Per-thread settings ride every turn: prime switches model and thinking
  // level in place, so they apply from this turn on (a no-op sends nothing).
  await session.applyTurnOptions({
    model: args.model,
    reasoningLevel: args.reasoningLevel,
  });
  await session.turn({
    clientRequestId: args.clientRequestId,
    input: args.input,
  });
}

/**
 * bb has no compaction request method: manual compaction is the standalone
 * builtin `/compact` prompt travelling the normal turn pipeline (protocol doc
 * §Capabilities). The bridge maps it onto prime's `compact` command instead of
 * prompting, and prime's own compaction events stream the timeline — a manual
 * compaction opens and settles its own turn.
 */
async function runManualCompaction(args: {
  record: SessionRecord;
  clientRequestId: ClientTurnRequestId | undefined;
}): Promise<void> {
  args.record.turns += 1;
  if (args.clientRequestId !== undefined) {
    emitDeltas(args.record.threadId, [
      { kind: "input.accepted", clientRequestId: args.clientRequestId },
    ]);
  }
  await sessionFor(args.record).compactManually();
}

/** The turn pipeline: a `/compact` prompt compacts, everything else prompts. */
function runTurnOrCompaction(args: {
  record: SessionRecord;
  input: readonly PromptInput[];
  clientRequestId: ClientTurnRequestId | undefined;
  model?: string | undefined;
  reasoningLevel?: ReasoningLevel | undefined;
}): Promise<void> {
  return isStandaloneBuiltinCompactCommand(args.input)
    ? runManualCompaction({
        record: args.record,
        clientRequestId: args.clientRequestId,
      })
    : runTurn(args);
}

type RequestHandler = (id: JsonRpcId, params: unknown) => void | Promise<void>;

/** Reply hygiene: invalid params answer -32602 carrying the issues, never silence. */
function invalidParams(id: JsonRpcId, method: string, issues: unknown): void {
  io.sendError(
    id,
    BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
    `Invalid params for ${method}`,
    { issues },
  );
}

/**
 * The one parse prologue every method shares: params that do not satisfy the
 * method's schema answer -32602 carrying the issues, and valid params reach
 * the handler already typed. The method name rides along because it is part
 * of the refusal text.
 */
function withParsed<T>(
  method: string,
  schema: { safeParse(params: unknown): { success: true; data: T } | { success: false; error: { issues: unknown } } },
  handler: (id: JsonRpcId, data: T) => void | Promise<void>,
): RequestHandler {
  return (id, params) => {
    const parsed = schema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, method, parsed.error.issues);
      return;
    }
    return handler(id, parsed.data);
  };
}
const handlers: Record<string, RequestHandler> = {
  [BRIDGE_REQUEST_METHODS.initialize]: withParsed(
    BRIDGE_REQUEST_METHODS.initialize,
    initializeParamsSchema,
    (id, data) => {
      io.sendResult(id, {
        protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
        capabilities: {
          // The assembler speaks v3 only; a narrower range is refused at spawn.
          grammarVersions: [THREAD_DELTA_GRAMMAR_V3, THREAD_DELTA_GRAMMAR_V3],
          // A bb thread survives its bridge process: the provider thread id is
          // daemon-derived (`prime_<activeSessionId>`), so a reopened thread
          // attaches to the same resident session and rebuilds its timeline from
          // the attach snapshot. Restore needs the daemon holding the session —
          // when the daemon itself is gone, resume answers a legible error
          // (recovery across a daemon restart is bbpa-ggf.11).
          sessionRestore: true,
          threadArchive: false,
          // Renames apply to prime's catalog name with the "[bb] " prefix kept
          // (bbpa-ggf.7): the resident session is renamed in place, and a
          // released thread's saved transcript is renamed by file.
          threadRename: true,
          threadGoalClear: false,
          // Checkpoint forks (bbpa-ggf.7): every settled prompt-carrying turn
          // mints a fork anchor on its boundary, and `thread/fork` branches the
          // source session's transcript at that anchor into a NEW session for
          // the new thread.
          fork: "checkpoint",
          // prime-agent has no approval gate; bb runs the policy it declares.
          approvalEnforcedBy: "runtime",
          // Steers are queued, not injected: `turn/steer` rides prime's steering
          // lane (delivered after the work in flight, never interrupting), and a
          // prompt landing on a busy session rides the follow-up lane
          // (bbpa-ggf.5).
          steerMode: "queue",
          // Accepted and stored (see skills/configure) so bb can hand the
          // catalog over before the first real session.
          skills: { configure: true },
        },
      });
    },
  ),

  [BRIDGE_REQUEST_METHODS.modelList]: withParsed(
    BRIDGE_REQUEST_METHODS.modelList,
    modelListParamsSchema,
    (id, data) => {
      // prime's own catalog, no curated list on our side. A daemon that cannot
      // answer (no `model_catalog` capability, no signed-in provider) is an
      // honest error for the picker, never a crash.
      return primeAvailableModels({ cwd: data.cwd }).then(
        (answer) => {
          io.sendResult(id, answer);
        },
        (error: unknown) => {
          io.sendError(
            id,
            BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR,
            error instanceof Error ? error.message : String(error),
          );
        },
      );
    },
  ),

  [BRIDGE_REQUEST_METHODS.providerHealth]: withParsed(
    BRIDGE_REQUEST_METHODS.providerHealth,
    providerMaintenanceParamsSchema,
    (id) => {
      return primeProviderHealthCached().then((result) => {
        io.sendResult(id, result);
      });
    },
  ),

  [BRIDGE_REQUEST_METHODS.providerUsage]: withParsed(
    BRIDGE_REQUEST_METHODS.providerUsage,
    providerMaintenanceParamsSchema,
    (id) => {
      io.sendResult(id, { supported: false });
    },
  ),

  [BRIDGE_REQUEST_METHODS.providerInstallationStatus]: withParsed(
    BRIDGE_REQUEST_METHODS.providerInstallationStatus,
    providerInstallationStatusParamsSchema,
    () => {
      throw new Error(
        "prime-agent installation management is not offered: install it with the official installer, bb never installs or updates it",
      );
    },
  ),

  [BRIDGE_REQUEST_METHODS.providerInstallationRun]: withParsed(
    BRIDGE_REQUEST_METHODS.providerInstallationRun,
    providerInstallationRunParamsSchema,
    () => {
      throw new Error(
        "prime-agent installation management is not offered: install it with the official installer, bb never installs or updates it",
      );
    },
  ),

  [BRIDGE_REQUEST_METHODS.threadStart]: withParsed(
    BRIDGE_REQUEST_METHODS.threadStart,
    threadStartParamsSchema,
    (id, data) => {
      const record = registerSession({
        threadId: data.threadId,
        cwd: data.cwd,
        dynamicTools: data.dynamicTools ?? [],
      });
      // The channel listens before `create` so the companion extension finds it
      // while the prime worker boots (bbpa-ggf.13).
      return ensureDynamicToolsChannel(record)
        .then(() =>
          startSession({
            record,
            title: PrimeSession.titleFromInput(data.input),
            model: data.options.model,
            reasoningLevel: data.options.reasoningLevel,
            // The provider settings' extension picker (bbpa-ggf.12) reaches the
            // session here and only here: `create` is written once per session,
            // so the selection is a new-sessions-only knob — the resume below
            // attaches to the resident worker and never re-reads it.
            enabledExtensions: enabledExtensionsFromProviderOptions(
              data.options.providerOptions,
            ),
            // The skills/configure catalog (bb's own skills), read at create
            // time like the picker's selection: a session created before the
            // configure arrived cannot have it, and a resume attaches to the
            // resident worker without re-sending anything.
            skillRoots: configuredSkillRootPaths(),
            input: data.input,
            beforeFirstTurn: () => publishDynamicTools(record),
          }),
        )
        .then(() => {
          io.sendResult(id, {
            providerThreadId: record.providerThreadId,
            sessionRestorable: true,
          });
        });
    },
  ),

  [BRIDGE_REQUEST_METHODS.threadResume]: withParsed(
    BRIDGE_REQUEST_METHODS.threadResume,
    threadResumeParamsSchema,
    (id, data) => {
      return (async () => {
        const existing = sessions.byProviderThread(data.providerThreadId);
        const adopted = existing === undefined;
        const record =
          existing ??
          registerSession({
            threadId: data.threadId,
            providerThreadId: data.providerThreadId,
            cwd: data.cwd,
            dynamicTools: data.dynamicTools ?? [],
          });
        try {
          if (record.session === undefined) {
            const activeSessionId = primeActiveSessionIdFrom(record.providerThreadId);
            if (activeSessionId === undefined) {
              throw new Error(
                `cannot resume ${record.providerThreadId}: it is not a prime-agent session id this bridge created`,
              );
            }
            record.activeSessionId = activeSessionId;
            const session = laneFor(record);
            await session.attach();
            // Every session construction is an id-space boundary, and the snapshot
            // content — when it is replayed at all — belongs to the new space.
            announceSession(record);
            // bb persists this thread's timeline, so the snapshot is not replayed
            // as content — except when the session was adopted from a previous
            // bridge process (a reopened thread, or work that continued in the
            // daemon after bb closed), where the snapshot is the only source of
            // that history the bridge ever sees.
            if (adopted) {
              session.snapshotDeltas();
            }
          } else {
            await sessionFor(record).attach();
            announceSession(record);
          }
          // The worker kept the companion extension from its create, but the
          // channel socket this process mints is new — re-listen on the same
          // path (thread-id keyed) and re-publish; the extension reconnects and
          // the protocol re-syncs its tool set (bbpa-ggf.13).
          await ensureDynamicToolsChannel(record);
          await publishDynamicTools(record);
        } catch (error) {
          if (adopted) {
            sessions.drop(record.threadId);
          }
          throw error;
        }
        io.sendResult(id, {
          providerThreadId: record.providerThreadId,
          sessionRestorable: true,
        });
      })();
    },
  ),

  [BRIDGE_REQUEST_METHODS.threadFork]: withParsed(
    BRIDGE_REQUEST_METHODS.threadFork,
    threadForkParamsSchema,
    (id, data) => {
      return (async () => {
        const sourceActiveSessionId = primeActiveSessionIdFrom(
          data.sourceProviderThreadId,
        );
        if (sourceActiveSessionId === undefined) {
          io.sendError(
            id,
            BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
            `cannot fork ${data.sourceProviderThreadId}: it is not a prime-agent session id this bridge created`,
          );
          return;
        }
        // The fork's NEW thread gets the full construction funnel: its own bb
        // thread id names its own "[bb] " session, and the channel listens
        // before `create` exactly as in thread/start (bbpa-ggf.13).
        const record = registerSession({
          threadId: data.threadId,
          cwd: data.cwd,
          dynamicTools: data.dynamicTools ?? [],
        });
        try {
          // The channel listens before `create` so the companion extension finds
          // it while the prime worker boots (bbpa-ggf.13) — mirror thread/start.
          await ensureDynamicToolsChannel(record);
          // Branch the source session's transcript at the requested fork point
          // and hand the source session back its own transcript — see
          // `forkPrimeSession` for why prime's fork is a replace-in-place that
          // has to be bracketed. bb has already copied the inherited timeline
          // into the new thread itself, so the snapshot below arms the boundary
          // without being replayed as content.
          const branched = await forkPrimeSession({
            request: (command, requestArgs) => daemonRequest(command, requestArgs),
            sourceActiveSessionId,
            checkpointId: data.sourceProviderCheckpointId,
          });
          await startSession({
            record,
            model: data.options.model,
            reasoningLevel: data.options.reasoningLevel,
            enabledExtensions: enabledExtensionsFromProviderOptions(
              data.options.providerOptions,
            ),
            // The branch file: the new resident session opens the forked
            // transcript instead of a fresh one.
            sessionPath: branched.sessionFile,
            input: undefined,
            beforeFirstTurn: () => publishDynamicTools(record),
          });
          if (
            branched.sessionFile !== undefined &&
            record.activeSessionId === sourceActiveSessionId
          ) {
            throw new Error(
              "prime-agent answered the fork's create with the source session itself; the new thread must not adopt it",
            );
          }
        } catch (error) {
          // A half-built fork leaves nothing behind: no channel, no record.
          await stopDynamicTools(record);
          if (sessions.byThread(record.threadId) === record) {
            sessions.drop(record.threadId);
          }
          throw error;
        }
        io.sendResult(id, {
          providerThreadId: record.providerThreadId,
          sessionRestorable: true,
        });
      })();
    },
  ),

  [BRIDGE_REQUEST_METHODS.threadStop]: withParsed(
    BRIDGE_REQUEST_METHODS.threadStop,
    threadStopParamsSchema,
    (id, data) => {
      return (async () => {
        const record = sessions.byThread(data.threadId);
        const session = record?.session;
        if (data.intent === "interrupt" && session !== undefined) {
          // Soft stop: prime stops streaming and the transcript keeps what it
          // already wrote. The bridge settles the turn itself so bb never waits
          // on the daemon to agree.
          emitDeltas(record!.threadId, await session.interrupt());
          io.sendResult(id, { ok: true });
          return;
        }
        // release (or an interrupt of a session we never attached): detach from
        // the resident session and drop the record. The session file survives —
        // the thread can come back through resume. No interruption is ever
        // fabricated, even if a turn is still streaming.
        if (session !== undefined) {
          await session.release();
        }
        await stopDynamicTools(record);
        if (record !== undefined) {
          sessions.drop(record.threadId);
        }
        io.sendResult(id, { ok: true });
      })();
    },
  ),

  [BRIDGE_REQUEST_METHODS.threadDiscard]: withParsed(
    BRIDGE_REQUEST_METHODS.threadDiscard,
    threadDiscardParamsSchema,
    (id, data) => {
      return (async () => {
        const record = sessions.byThread(data.threadId);
        // The bb tools channel never outlives a discard attempt: bb is tearing
        // the thread down, and a resume re-arms the channel if the discard fails.
        await stopDynamicTools(record);
        if (record?.session !== undefined) {
          // Stop + cleanup: soft-stop the open turn, then `kill` +
          // `delete_saved_session` for exactly the session id and file this
          // thread's record names — never a session this bridge did not mint.
          await record.session.destroy();
        }
        // A record without a session has no daemon identity to clean up (its
        // `create` never answered), so there is nothing to address.
        if (record !== undefined) {
          sessions.drop(record.threadId);
        }
        io.sendResult(id, { ok: true });
      })();
    },
  ),

  [BRIDGE_REQUEST_METHODS.threadNameSet]: withParsed(
    BRIDGE_REQUEST_METHODS.threadNameSet,
    threadNameSetParamsSchema,
    (id, data) => {
      return (async () => {
        const { threadId, providerThreadId, title } = data;
        // Same naming funnel as create: the "[bb] " prefix stays on (prime's
        // catalog must keep telling bb's sessions apart from its own), and the
        // bb thread id keeps agent names unique inside prime's family scope.
        const name = primeSessionName({ threadId, title });
        const record = sessions.byThread(threadId);
        if (record?.session !== undefined && record.activeSessionId !== undefined) {
          // Active: prime renames the resident session in place.
          const renamed = await daemonRequest(
            asWireCommand({
              type: "rename",
              activeSessionId: record.activeSessionId,
              name,
            }),
          );
          if (!renamed.success) {
            throw new Error(
              `prime-agent refused "rename": ${renamed.error ?? "unknown daemon error"}`,
            );
          }
          const summary = daemonSessionSummarySchema.safeParse(renamed.data);
          if (summary.success && summary.data.sessionFile !== undefined) {
            record.sessionFile = summary.data.sessionFile;
          }
          record.sessionName = summary.success
            ? (summary.data.sessionName ?? name)
            : name;
        } else {
          // Inactive (released, or resident without a lane in this process):
          // prime renames the transcript file, and finds an active session by
          // that file itself — both cases answered by one command.
          const sessionFile = await sessionFileForRenaming(
            record,
            providerThreadId,
            threadId,
          );
          const renamed = await daemonRequest(
            asWireCommand({ type: "rename_saved_session", sessionPath: sessionFile, name }),
          );
          if (!renamed.success) {
            throw new Error(
              `prime-agent refused "rename_saved_session": ${renamed.error ?? "unknown daemon error"}`,
            );
          }
          if (record !== undefined) {
            record.sessionName = name;
          }
        }
        io.sendResult(id, { ok: true });
      })();
    },
  ),

  [BRIDGE_REQUEST_METHODS.threadArchive]: withParsed(
    BRIDGE_REQUEST_METHODS.threadArchive,
    threadArchiveParamsSchema,
    () => {
      throw new Error("prime-agent keeps no thread archive of its own: the handshake declares no threadArchive");
    },
  ),

  [BRIDGE_REQUEST_METHODS.threadUnarchive]: withParsed(
    BRIDGE_REQUEST_METHODS.threadUnarchive,
    threadUnarchiveParamsSchema,
    () => {
      throw new Error("prime-agent keeps no thread archive of its own: the handshake declares no threadArchive");
    },
  ),

  [BRIDGE_REQUEST_METHODS.threadGoalClear]: withParsed(
    BRIDGE_REQUEST_METHODS.threadGoalClear,
    threadGoalClearParamsSchema,
    () => {
      throw new Error(
        "prime-agent goal clearing is not wired yet: the handshake declares no threadGoalClear",
      );
    },
  ),

  [BRIDGE_REQUEST_METHODS.turnStart]: withParsed(
    BRIDGE_REQUEST_METHODS.turnStart,
    turnStartParamsSchema,
    (id, data) => {
      const record = sessions.byThread(data.threadId);
      if (record === undefined) {
        io.sendError(
          id,
          BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
          `No session for thread ${data.threadId}; send thread/start or thread/resume first`,
        );
        return;
      }
      const settled = runTurnOrCompaction({
        record,
        input: data.input,
        clientRequestId: data.clientRequestId,
        model: data.options.model,
        reasoningLevel: data.options.reasoningLevel,
      });
      return settled.then(() => {
        io.sendResult(id, {});
      });
    },
  ),

  [BRIDGE_REQUEST_METHODS.turnSteer]: withParsed(
    BRIDGE_REQUEST_METHODS.turnSteer,
    turnSteerParamsSchema,
    (id, data) => {
      return (async () => {
        // `expectedTurnId` stays diagnostic: this bridge mints no provider turn
        // ids of its own, and staleness is the runtime's guard (it drops a steer
        // whose turn is gone before the request ever lands here).
        const record = sessions.byThread(data.threadId);
        if (record === undefined) {
          io.sendError(
            id,
            BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
            `No session for thread ${data.threadId}; send thread/start or thread/resume first`,
          );
          return;
        }
        const text = primePromptText(data.input);
        if (text.trim() === "") {
          io.sendError(
            id,
            BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
            "Missing input text to steer with",
          );
          return;
        }
        // prime admits the message either way (bbpa-ggf.5) and the lane picks
        // the form: mid-turn it is prime's steer semantic — after the work in
        // flight, before the next model call — and on an idle session the
        // daemon's resumeIfIdle starts a fresh run. The steered text shows on
        // the timeline as a provider input row; the turn in flight settles
        // itself, and a resumed run opens the turn that answers the steer.
        await sessionFor(record).steer({ input: data.input });
        emitDeltas(record.threadId, [
          { kind: "input.accepted", clientRequestId: data.clientRequestId },
          { kind: "input.provider", text },
        ]);
        io.sendResult(id, { threadId: record.threadId });
      })();
    },
  ),

  [BRIDGE_REQUEST_METHODS.skillsConfigure]: withParsed(
    BRIDGE_REQUEST_METHODS.skillsConfigure,
    skillsConfigureParamsSchema,
    (id, data) => {
      configuredSkillRoots = data.roots.map((root) => ({
        id: root.id,
        path: root.path,
        skills: root.skills.map((skill) => ({
          name: skill.name,
          description: skill.description,
        })),
      }));
      io.sendResult(id, { ok: true });
    },
  ),
};

export function handleLine(line: string): void {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    return;
  }
  const { id, method, params } = message as {
    id?: unknown;
    method?: unknown;
    params?: unknown;
  };
  if (typeof method !== "string") {
    // A response to an `item/tool/call` we sent: settle the pending dynamic
    // tool call. The tracker ignores ids it does not know (reply hygiene).
    toolCalls.handleToolCallResponse(message as BridgeJsonRpcResponse);
    return;
  }
  if (typeof id !== "string" && typeof id !== "number") {
    return;
  }
  const handler = handlers[method];
  if (handler === undefined) {
    io.sendError(
      id,
      BRIDGE_JSON_RPC_ERRORS.METHOD_NOT_FOUND,
      `Method not found: ${method}`,
    );
    return;
  }
  runBridgeRequest({
    request: { id, method, params },
    sendError: io.sendError,
    handleRequest: async (request) => handler(request.id, request.params),
  });
}

/** The skills/configure catalog, for tests and for session creation. */
export function currentConfiguredSkillRoots(): readonly ConfiguredSkillRoot[] {
  return configuredSkillRoots;
}

/** Test seam: forget the configured skill catalog (bb sends it once per process). */
export function resetConfiguredSkillRootsForTests(): void {
  configuredSkillRoots = [];
}

/** Test seam: the process-local session table. */
export function sessionTableForTests(): SessionTable {
  return sessions;
}

/** Test seam: forget the shared daemon connection (a new one is built lazily). */
export function resetDaemonForTests(): void {
  resetDaemonConnectionForTests();
}

/** Test seam: the dynamic-tools channel registry (channel paths, liveness). */
export function dynamicToolsRegistryForTests(): DynamicToolsRegistry {
  return dynamicTools;
}

/** The socket path this bridge would dial (tests and the health probe use it). */
export function daemonSocketPathForTests(): string {
  return resolveDaemonSocketPath();
}

export const experimental_providerBridge = experimental_defineProviderBridge({
  handleLine,
  start(context) {
    bridgeContext = context;
  },
  onClose() {
    for (const record of sessions.all()) {
      // Fire and forget: the daemon outlives this process, and a failed detach
      // on the way down is not an error the runtime can act on. Detach only —
      // a turn still running keeps streaming (story 18): the session is
      // resident, and its output reaches whoever attaches next, be that a
      // reopened bb or an out-of-band client.
      record.session?.release({ interrupt: false }).catch(() => {});
    }
    dynamicTools.clear().catch(() => {});
    sessions.clear();
    bridgeContext = undefined;
    resetDaemonConnectionForTests();
  },
});

/** Exposed for tests; the daemon artifact owns the real lifecycle. */
export function currentBridgeContextForTests(): ProviderBridgeContext | undefined {
  return bridgeContext;
}

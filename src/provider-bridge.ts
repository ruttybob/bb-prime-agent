import {
  BRIDGE_JSON_RPC_ERRORS,
  BRIDGE_NOTIFICATION_METHODS,
  BRIDGE_REQUEST_METHODS,
  PROVIDER_BRIDGE_PROTOCOL_VERSION,
  THREAD_DELTA_GRAMMAR_V3,
  THREAD_DELTA_NOTIFICATION_METHOD,
  createBridgeIo,
  experimental_defineProviderBridge,
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
  type PromptInput,
  type ProviderBridgeContext,
  type ReasoningLevel,
  type ThreadDelta,
} from "@get-bb/plugin-sdk/provider-bridge";
import { primeProviderHealthCached } from "./health.js";
import {
  daemonRequest,
  ensureDaemonConnection,
  onDaemonPush,
  resetDaemonConnectionForTests,
} from "./daemon/connection.js";
import { resolveDaemonSocketPath } from "./daemon/socket.js";
import { PrimeSession } from "./prime-session.js";
import {
  SessionTable,
  type ConfiguredSkillRoot,
  type SessionRecord,
} from "./session-table.js";

/**
 * The prime-agent provider bridge.
 *
 * The chat path is real: `thread/start` creates a daemon-resident prime session
 * named with the "[bb] " prefix in the bb environment's cwd
 * (`src/session-params.ts` is the only place those params are built),
 * `turn/start` prompts it and streams prime's session events into the bb
 * timeline as deltas (`src/delta-translation.ts`), and `thread/stop` soft-stops
 * (`abort`) so the session file survives. Discard still leaves the daemon
 * session in place — deleting it (`kill` + `delete_saved_session`) is
 * bbpa-ggf.4, together with cross-process session discovery.
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

/** Skill roots from `skills/configure`, consumed when sessions are created. */
let configuredSkillRoots: readonly ConfiguredSkillRoot[] = [];

let bridgeContext: ProviderBridgeContext | undefined;

function registerSession(args: {
  threadId: string;
  providerThreadId?: string;
  cwd: string;
  dynamicTools: SessionRecord["dynamicTools"];
}): SessionRecord {
  return sessions.register({
    threadId: args.threadId,
    providerThreadId: args.providerThreadId ?? `prime_pending_${args.threadId}`,
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

/** The daemon session handle behind a provider thread id this bridge minted. */
function activeSessionIdFrom(providerThreadId: string): string | undefined {
  const prefix = "prime_";
  return providerThreadId.startsWith(prefix) && providerThreadId.length > prefix.length
    ? providerThreadId.slice(prefix.length)
    : undefined;
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

function laneFor(record: SessionRecord): PrimeSession {
  const session = new PrimeSession({
    record,
    emit: ({ threadId, deltas }) => emitDeltas(threadId, deltas),
    subscribePush: onDaemonPush,
    request: (command, args) => daemonRequest(command, args),
    ensureConnected: ensureDaemonConnection,
  });
  record.session = session;
  return session;
}

/** Create the resident session, announce it, and stream its first turn. */
async function startSession(args: {
  record: SessionRecord;
  title?: string | undefined;
  model?: string | undefined;
  reasoningLevel?: ReasoningLevel | undefined;
  input: readonly PromptInput[] | undefined;
}): Promise<void> {
  const { record } = args;
  try {
    const session = laneFor(record);
    const identity = await session.start({
      threadId: record.threadId,
      cwd: record.cwd,
      title: args.title,
      model: args.model,
      reasoningLevel: args.reasoningLevel,
    });
    sessions.adoptProviderThreadId(record, identity.providerThreadId);
  } catch (error) {
    sessions.drop(record.threadId);
    throw error;
  }
  announceSession(record);
  if (args.input !== undefined && args.input.length > 0) {
    await runTurn({ record, input: args.input, clientRequestId: undefined });
  }
}

async function runTurn(args: {
  record: SessionRecord;
  input: readonly PromptInput[];
  clientRequestId: ClientTurnRequestId | undefined;
}): Promise<void> {
  const { record } = args;
  record.turns += 1;
  if (args.clientRequestId !== undefined) {
    emitDeltas(record.threadId, [
      { kind: "input.accepted", clientRequestId: args.clientRequestId },
    ]);
  }
  await sessionFor(record).turn({
    clientRequestId: args.clientRequestId,
    input: args.input,
  });
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

const handlers: Record<string, RequestHandler> = {
  [BRIDGE_REQUEST_METHODS.initialize]: (id, params) => {
    const parsed = initializeParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.initialize, parsed.error.issues);
      return;
    }
    io.sendResult(id, {
      protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
      capabilities: {
        // The assembler speaks v3 only; a narrower range is refused at spawn.
        grammarVersions: [THREAD_DELTA_GRAMMAR_V3, THREAD_DELTA_GRAMMAR_V3],
        // Sessions are daemon-resident, but restoring a provider thread across
        // bridge processes (saved-session discovery) is bbpa-ggf.4.
        sessionRestore: false,
        threadArchive: false,
        threadRename: false,
        threadGoalClear: false,
        fork: "none",
        // prime-agent has no approval gate; bb runs the policy it declares.
        approvalEnforcedBy: "runtime",
        // bbpa-ggf.5 maps prime's steer/follow-up semantics onto turn/steer.
        steerMode: "queue",
        // Accepted and stored (see skills/configure) so bb can hand the
        // catalog over before the first real session.
        skills: { configure: true },
      },
    });
  },

  [BRIDGE_REQUEST_METHODS.modelList]: (id, params) => {
    const parsed = modelListParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.modelList, parsed.error.issues);
      return;
    }
    throw new Error(
      "prime-agent model catalog is not wired yet: it is translated from the daemon's get_model_catalog with the models ticket (bbpa-ggf.6)",
    );
  },

  [BRIDGE_REQUEST_METHODS.providerHealth]: (id, params) => {
    const parsed = providerMaintenanceParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.providerHealth, parsed.error.issues);
      return;
    }
    return primeProviderHealthCached().then((result) => {
      io.sendResult(id, result);
    });
  },

  [BRIDGE_REQUEST_METHODS.providerUsage]: (id, params) => {
    const parsed = providerMaintenanceParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.providerUsage, parsed.error.issues);
      return;
    }
    io.sendResult(id, { supported: false });
  },

  [BRIDGE_REQUEST_METHODS.providerInstallationStatus]: (id, params) => {
    const parsed = providerInstallationStatusParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(
        id,
        BRIDGE_REQUEST_METHODS.providerInstallationStatus,
        parsed.error.issues,
      );
      return;
    }
    throw new Error(
      "prime-agent installation management is not offered: install it with the official installer, bb never installs or updates it",
    );
  },

  [BRIDGE_REQUEST_METHODS.providerInstallationRun]: (id, params) => {
    const parsed = providerInstallationRunParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(
        id,
        BRIDGE_REQUEST_METHODS.providerInstallationRun,
        parsed.error.issues,
      );
      return;
    }
    throw new Error(
      "prime-agent installation management is not offered: install it with the official installer, bb never installs or updates it",
    );
  },

  [BRIDGE_REQUEST_METHODS.threadStart]: (id, params) => {
    const parsed = threadStartParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.threadStart, parsed.error.issues);
      return;
    }
    const record = registerSession({
      threadId: parsed.data.threadId,
      cwd: parsed.data.cwd,
      dynamicTools: parsed.data.dynamicTools ?? [],
    });
    return startSession({
      record,
      title: PrimeSession.titleFromInput(parsed.data.input),
      model: parsed.data.options.model,
      reasoningLevel: parsed.data.options.reasoningLevel,
      input: parsed.data.input,
    }).then(() => {
      io.sendResult(id, {
        providerThreadId: record.providerThreadId,
        sessionRestorable: true,
      });
    });
  },

  [BRIDGE_REQUEST_METHODS.threadResume]: (id, params) => {
    const parsed = threadResumeParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.threadResume, parsed.error.issues);
      return;
    }
    return (async () => {
      const existing = sessions.byProviderThread(parsed.data.providerThreadId);
      const adopted = existing === undefined;
      const record =
        existing ??
        registerSession({
          threadId: parsed.data.threadId,
          providerThreadId: parsed.data.providerThreadId,
          cwd: parsed.data.cwd,
          dynamicTools: parsed.data.dynamicTools ?? [],
        });
      try {
        if (record.session === undefined) {
          const activeSessionId = activeSessionIdFrom(record.providerThreadId);
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
          // bridge process, where the snapshot is the only source the bridge
          // ever sees. bbpa-ggf.4 revisits this with saved-session discovery.
          if (adopted) {
            session.snapshotDeltas();
          }
        } else {
          await sessionFor(record).attach();
          announceSession(record);
        }
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

  [BRIDGE_REQUEST_METHODS.threadFork]: (id, params) => {
    const parsed = threadForkParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.threadFork, parsed.error.issues);
      return;
    }
    throw new Error(
      "prime-agent fork is not wired yet: the handshake declares fork \"none\" until the persistence work lands it (bbpa-ggf.4)",
    );
  },

  [BRIDGE_REQUEST_METHODS.threadStop]: (id, params) => {
    const parsed = threadStopParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.threadStop, parsed.error.issues);
      return;
    }
    return (async () => {
      const record = sessions.byThread(parsed.data.threadId);
      const session = record?.session;
      if (parsed.data.intent === "interrupt" && session !== undefined) {
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
      if (record !== undefined) {
        sessions.drop(record.threadId);
      }
      io.sendResult(id, { ok: true });
    })();
  },

  [BRIDGE_REQUEST_METHODS.threadDiscard]: (id, params) => {
    const parsed = threadDiscardParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.threadDiscard, parsed.error.issues);
      return;
    }
    return (async () => {
      const record = sessions.byThread(parsed.data.threadId);
      if (record?.session !== undefined) {
        await record.session.release();
      }
      if (record !== undefined) {
        sessions.drop(record.threadId);
      }
      // The daemon session file is deliberately left in place until bbpa-ggf.4
      // wires the daemon cleanup (`kill` + `delete_saved_session`); it stays a
      // "[bb] "-prefixed session the user can still see from prime itself.
      io.sendResult(id, { ok: true });
    })();
  },

  [BRIDGE_REQUEST_METHODS.threadNameSet]: (id, params) => {
    const parsed = threadNameSetParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.threadNameSet, parsed.error.issues);
      return;
    }
    throw new Error(
      "prime-agent thread rename is not wired yet: the handshake declares no threadRename until the persistence work lands it (bbpa-ggf.4)",
    );
  },

  [BRIDGE_REQUEST_METHODS.threadArchive]: (id, params) => {
    const parsed = threadArchiveParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.threadArchive, parsed.error.issues);
      return;
    }
    throw new Error("prime-agent keeps no thread archive of its own: the handshake declares no threadArchive");
  },

  [BRIDGE_REQUEST_METHODS.threadUnarchive]: (id, params) => {
    const parsed = threadUnarchiveParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.threadUnarchive, parsed.error.issues);
      return;
    }
    throw new Error("prime-agent keeps no thread archive of its own: the handshake declares no threadArchive");
  },

  [BRIDGE_REQUEST_METHODS.threadGoalClear]: (id, params) => {
    const parsed = threadGoalClearParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.threadGoalClear, parsed.error.issues);
      return;
    }
    throw new Error(
      "prime-agent goal clearing is not wired yet: the handshake declares no threadGoalClear",
    );
  },

  [BRIDGE_REQUEST_METHODS.turnStart]: (id, params) => {
    const parsed = turnStartParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.turnStart, parsed.error.issues);
      return;
    }
    const record = sessions.byThread(parsed.data.threadId);
    if (record === undefined) {
      io.sendError(
        id,
        BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
        `No session for thread ${parsed.data.threadId}; send thread/start or thread/resume first`,
      );
      return;
    }
    return runTurn({
      record,
      input: parsed.data.input,
      clientRequestId: parsed.data.clientRequestId,
    }).then(() => {
      io.sendResult(id, {});
    });
  },

  [BRIDGE_REQUEST_METHODS.turnSteer]: (id, params) => {
    const parsed = turnSteerParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.turnSteer, parsed.error.issues);
      return;
    }
    // Steering maps onto prime's `steer` with bbpa-ggf.5; until then a steer is
    // refused rather than silently queued behind the running turn.
    io.sendError(
      id,
      BRIDGE_JSON_RPC_ERRORS.NO_ACTIVE_TURN,
      `No active turn to steer (expected ${parsed.data.expectedTurnId})`,
    );
  },

  [BRIDGE_REQUEST_METHODS.skillsConfigure]: (id, params) => {
    const parsed = skillsConfigureParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.skillsConfigure, parsed.error.issues);
      return;
    }
    configuredSkillRoots = parsed.data.roots.map((root) => ({
      id: root.id,
      path: root.path,
      skills: root.skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
      })),
    }));
    io.sendResult(id, { ok: true });
  },
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
    // A response (to an item/tool/call we sent) — none are pending, so this is
    // a no-op kept for reply hygiene.
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

/** Test seam: the process-local session table. */
export function sessionTableForTests(): SessionTable {
  return sessions;
}

/** Test seam: forget the shared daemon connection (a new one is built lazily). */
export function resetDaemonForTests(): void {
  resetDaemonConnectionForTests();
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
      // on the way down is not an error the runtime can act on.
      record.session?.release().catch(() => {});
    }
    sessions.clear();
    bridgeContext = undefined;
    resetDaemonConnectionForTests();
  },
});

/** Exposed for tests; the daemon artifact owns the real lifecycle. */
export function currentBridgeContextForTests(): ProviderBridgeContext | undefined {
  return bridgeContext;
}

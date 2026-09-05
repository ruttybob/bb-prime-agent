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
  type DynamicTool,
  type ProviderBridgeContext,
  type ThreadDelta,
} from "@get-bb/plugin-sdk/provider-bridge";
import { randomUUID } from "node:crypto";
import { primeProviderHealthCached } from "./health.js";
import {
  SessionTable,
  type ConfiguredSkillRoot,
  type SessionRecord,
} from "./session-table.js";
import { PRIME_NO_SANDBOX_NOTICE } from "./vocabulary.js";

/**
 * The prime-agent provider bridge.
 *
 * This ticket owns the protocol surface: the canonical method map, the reply
 * hygiene the conformance kit enforces, and the session/turn grammar that a
 * runtime depends on. Turns are **skeleton turns**: they accept, open, explain
 * that no model is attached yet, and settle. Nothing here talks to the daemon
 * beyond the health probe — the resident-session wiring (`create`, attach,
 * prompt round-trips, delta translation) is bbpa-ggf.3, which fills the turn
 * and session handlers in place.
 */
type JsonRpcId = string | number;

const io = createBridgeIo();

type OutboundMessage = { jsonrpc: "2.0" } & Record<string, unknown>;

function notify(method: string, params: Record<string, unknown>): void {
  const message: OutboundMessage = { jsonrpc: "2.0", method, params };
  io.send(message);
}

function emitDeltas(threadId: string, deltas: ThreadDelta[]): void {
  notify(THREAD_DELTA_NOTIFICATION_METHOD, { threadId, deltas });
}

/**
 * What the skeleton turn tells the user. Deliberately loud: a thread that
 * silently "completed" without a model would be a lie; a warning row says
 * exactly what happened and which ticket wires it.
 */
const SKELETON_TURN_SUMMARY =
  "prime-agent bridge skeleton: the prompt was not sent to prime-agent yet";

const SKELETON_TURN_DETAILS = `${PRIME_NO_SANDBOX_NOTICE} (Live chat — resident daemon sessions, turn streaming, steering — arrives with bbpa-ggf.3.)`;

/** Session records, one per bb thread; process-local by design (see module docs). */
const sessions = new SessionTable();

/** Skill roots from `skills/configure`, consumed when sessions become real. */
let configuredSkillRoots: readonly ConfiguredSkillRoot[] = [];

let bridgeContext: ProviderBridgeContext | undefined;

/** Minted provider thread ids never collide across bridge process restarts. */
const instanceNonce = randomUUID().replaceAll("-", "").slice(0, 12);
let threadCounter = 0;

function nextProviderThreadId(): string {
  threadCounter += 1;
  return `prime_skeleton_${instanceNonce}_${threadCounter}`;
}

function registerSession(args: {
  threadId: string;
  providerThreadId: string;
  cwd: string;
  dynamicTools: readonly DynamicTool[];
}): SessionRecord {
  return sessions.register({
    threadId: args.threadId,
    providerThreadId: args.providerThreadId,
    cwd: args.cwd,
    createdAt: Date.now(),
    dynamicTools: args.dynamicTools,
    turns: 0,
  });
}

/**
 * Every session construction is a provider id-space boundary: identity first,
 * then `session.reset`, then the result. bbpa-ggf.3 keeps this order when the
 * record becomes a real resident session.
 */
function announceSession(record: SessionRecord): void {
  notify(BRIDGE_NOTIFICATION_METHODS.threadIdentity, {
    threadId: record.threadId,
    providerThreadId: record.providerThreadId,
  });
  emitDeltas(record.threadId, [{ kind: "session.reset" }]);
}

function runSkeletonTurn(args: {
  record: SessionRecord;
  clientRequestId?: ClientTurnRequestId;
}): void {
  args.record.turns += 1;
  const deltas: ThreadDelta[] = [];
  if (args.clientRequestId !== undefined) {
    deltas.push({ kind: "input.accepted", clientRequestId: args.clientRequestId });
  }
  deltas.push(
    { kind: "turn.open" },
    {
      kind: "provider.warning",
      category: "general",
      summary: SKELETON_TURN_SUMMARY,
      details: SKELETON_TURN_DETAILS,
    },
    { kind: "turn.boundary", status: "completed" },
  );
  emitDeltas(args.record.threadId, deltas);
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
        // Sessions are process-local until bbpa-ggf.3 makes them resident.
        sessionRestore: false,
        threadArchive: false,
        threadRename: false,
        threadGoalClear: false,
        fork: "none",
        // prime-agent has no approval gate; bb runs the policy it declares.
        approvalEnforcedBy: "runtime",
        // Skeleton turns never stay open, so no steer is ever delivered; the
        // conservative reading until bbpa-ggf.3 maps prime's steer semantics.
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
      "prime-agent model catalog is not wired yet: it arrives with the resident-session work (bbpa-ggf.3), translated from the daemon's get_model_catalog",
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
    const providerThreadId = nextProviderThreadId();
    const record = registerSession({
      threadId: parsed.data.threadId,
      providerThreadId,
      cwd: parsed.data.cwd,
      dynamicTools: parsed.data.dynamicTools ?? [],
    });
    announceSession(record);
    io.sendResult(id, { providerThreadId, sessionRestorable: false });
    if (parsed.data.input !== undefined && parsed.data.input.length > 0) {
      runSkeletonTurn({ record });
    }
  },

  [BRIDGE_REQUEST_METHODS.threadResume]: (id, params) => {
    const parsed = threadResumeParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.threadResume, parsed.error.issues);
      return;
    }
    const existing = sessions.byProviderThread(parsed.data.providerThreadId);
    const record =
      existing ??
      registerSession({
        threadId: parsed.data.threadId,
        providerThreadId: parsed.data.providerThreadId,
        cwd: parsed.data.cwd,
        dynamicTools: parsed.data.dynamicTools ?? [],
      });
    announceSession(record);
    io.sendResult(id, {
      providerThreadId: record.providerThreadId,
      sessionRestorable: false,
    });
  },

  [BRIDGE_REQUEST_METHODS.threadFork]: (id, params) => {
    const parsed = threadForkParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.threadFork, parsed.error.issues);
      return;
    }
    throw new Error(
      "prime-agent fork is not wired yet: the handshake declares fork \"none\" until the resident-session work (bbpa-ggf.3) lands it",
    );
  },

  [BRIDGE_REQUEST_METHODS.threadStop]: (id, params) => {
    const parsed = threadStopParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.threadStop, parsed.error.issues);
      return;
    }
    // Nothing is ever mid-turn in the skeleton, so `interrupt` has no turn to
    // settle and `release` must not fabricate one: both drop the record only.
    sessions.drop(parsed.data.threadId);
    io.sendResult(id, { ok: true });
  },

  [BRIDGE_REQUEST_METHODS.threadDiscard]: (id, params) => {
    const parsed = threadDiscardParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.threadDiscard, parsed.error.issues);
      return;
    }
    // No daemon session exists to delete, so dropping the record is the whole
    // truth; bbpa-ggf.3 adds the daemon-side cleanup (stop + delete_saved_session).
    sessions.drop(parsed.data.threadId);
    io.sendResult(id, { ok: true });
  },

  [BRIDGE_REQUEST_METHODS.threadNameSet]: (id, params) => {
    const parsed = threadNameSetParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.threadNameSet, parsed.error.issues);
      return;
    }
    throw new Error(
      "prime-agent thread rename is not wired yet: the handshake declares no threadRename until resident sessions land (bbpa-ggf.3)",
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
    io.sendResult(id, {});
    runSkeletonTurn({ record, clientRequestId: parsed.data.clientRequestId });
  },

  [BRIDGE_REQUEST_METHODS.turnSteer]: (id, params) => {
    const parsed = turnSteerParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.turnSteer, parsed.error.issues);
      return;
    }
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
    // A response (to an item/tool/call we sent) — none are pending in the
    // skeleton, so this is a no-op kept for reply hygiene.
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

/** The skills/configure catalog, for tests and for bbpa-ggf.3's session params. */
export function currentConfiguredSkillRoots(): readonly ConfiguredSkillRoot[] {
  return configuredSkillRoots;
}

/** Test seam: the process-local session table. */
export function sessionTableForTests(): SessionTable {
  return sessions;
}

export const experimental_providerBridge = experimental_defineProviderBridge({
  handleLine,
  start(context) {
    bridgeContext = context;
  },
  onClose() {
    sessions.clear();
    bridgeContext = undefined;
  },
});

/** Exposed for tests; the daemon artifact owns the real lifecycle. */
export function currentBridgeContextForTests(): ProviderBridgeContext | undefined {
  return bridgeContext;
}

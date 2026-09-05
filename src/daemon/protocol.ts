/**
 * prime-agent daemon wire protocol facts.
 *
 * The daemon protocol is not a published contract: it drifts between prime
 * releases. Everything version-sensitive lives in this module so a drift is a
 * one-file change, and every consumer goes through the calibration constants
 * and the compat gate below instead of hard-coding numbers.
 *
 * Wire facts were captured against prime-agent 0.7.3
 * (`docs/spikes/0001-prime-daemon-protocol.md`). The compat table below is
 * transcribed from prime-agent 0.7.3 `dist/modes/daemon/daemon-protocol.js`
 * (MIT, © Mario Zechner / Prime Intellect) so this client gates exactly the
 * commands prime's own client gates.
 */

export const DAEMON_PROTOCOL_NAME = "prime-agent.daemon";

/** The daemon pushes `daemon_hello` in this protocol version on connect. */
export const DAEMON_PROTOCOL_VERSION = 7;

/**
 * A daemon speaking an older protocol cannot answer our envelopes (the daemon
 * rejects envelopes below this version), so this is the one hard floor.
 */
export const DAEMON_MIN_PROTOCOL_VERSION = 7;

/**
 * Calibration: the daemon this bridge was developed and conformance-tested
 * against (prime-agent 0.7.3). Anything else drifts, which surfaces as a
 * warning — never a hard block (ADR-0002).
 */
export const CALIBRATED_SCHEMA_REVISION = 16;
export const CALIBRATED_SCHEMA_ID = "protocol-7-schema-16-1bcb9e7f1a49";
export const CALIBRATED_APP_VERSION = "0.7.3";

/** Prime's own daemon server capabilities on the calibrated release. */
export const CALIBRATED_SERVER_CAPABILITIES = 15;

/** The greeting the daemon pushes as the first JSONL line on every connection. */
export interface DaemonHello {
  type: "daemon_hello";
  socketPath?: string;
  protocol: { name: string; version: number };
  schemaId?: string;
  schemaRevision?: number;
  appVersion?: string;
  clientId: string;
  serverCapabilities?: readonly string[];
}

/** A daemon reply to a command envelope (the `command` field is the command type). */
export interface DaemonResponse {
  type: "response";
  id: string;
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
  errorInfo?: unknown;
}

/** Any top-level daemon message that is not a response (events, progress, …). */
export interface DaemonPushMessage {
  type: string;
  [key: string]: unknown;
}

export type DaemonInboundMessage = DaemonResponse | DaemonPushMessage;

/**
 * Structural validation of the first line a daemon sends. Returns `null` for
 * anything this bridge cannot address — the caller decides whether that is a
 * hard failure (`protocol.version` below the floor) or drift.
 */
export function parseDaemonHello(value: unknown): DaemonHello | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.type !== "daemon_hello") {
    return null;
  }
  const protocol = candidate.protocol;
  if (typeof protocol !== "object" || protocol === null) {
    return null;
  }
  const { name, version } = protocol as Record<string, unknown>;
  if (typeof name !== "string" || typeof version !== "number") {
    return null;
  }
  if (candidate.clientId !== undefined && typeof candidate.clientId !== "string") {
    return null;
  }
  if (candidate.socketPath !== undefined && typeof candidate.socketPath !== "string") {
    return null;
  }
  if (
    candidate.serverCapabilities !== undefined &&
    !Array.isArray(candidate.serverCapabilities)
  ) {
    return null;
  }
  const schemaId = candidate.schemaId;
  if (schemaId !== undefined && typeof schemaId !== "string") {
    return null;
  }
  const appVersion = candidate.appVersion;
  if (appVersion !== undefined && typeof appVersion !== "string") {
    return null;
  }
  const schemaRevision = candidate.schemaRevision;
  if (schemaRevision !== undefined && typeof schemaRevision !== "number") {
    return null;
  }
  const socketPath = candidate.socketPath;
  const serverCapabilities = candidate.serverCapabilities as
    | string[]
    | undefined;
  return {
    type: "daemon_hello",
    protocol: { name, version },
    clientId: typeof candidate.clientId === "string" ? candidate.clientId : "",
    ...(socketPath === undefined ? {} : { socketPath }),
    ...(schemaId === undefined ? {} : { schemaId }),
    ...(schemaRevision === undefined ? {} : { schemaRevision }),
    ...(appVersion === undefined ? {} : { appVersion }),
    ...(serverCapabilities === undefined ? {} : { serverCapabilities }),
  };
}

/** Why a hello (or the line that should have been one) was rejected. */
export type DaemonHelloRejection =
  | { kind: "not_hello"; detail: string }
  | { kind: "wrong_daemon"; detail: string; protocolName: string }
  | { kind: "protocol_too_old"; detail: string; protocolVersion: number };

/**
 * Validate a parsed hello against what this bridge can speak. The protocol
 * floor is hard (the daemon would reject our envelopes anyway); everything
 * else is calibration drift and is reported, not rejected.
 */
export function validateDaemonHello(
  hello: DaemonHello,
): DaemonHelloRejection | null {
  if (hello.protocol.name !== DAEMON_PROTOCOL_NAME) {
    return {
      kind: "wrong_daemon",
      detail: `expected protocol name "${DAEMON_PROTOCOL_NAME}", got "${hello.protocol.name}"`,
      protocolName: hello.protocol.name,
    };
  }
  if (hello.protocol.version < DAEMON_MIN_PROTOCOL_VERSION) {
    return {
      kind: "protocol_too_old",
      detail: `daemon speaks protocol ${hello.protocol.version}, this bridge needs at least ${DAEMON_MIN_PROTOCOL_VERSION}`,
      protocolVersion: hello.protocol.version,
    };
  }
  return null;
}

/**
 * Commands this bridge gates before sending, exactly like prime's own client:
 * a command runs only when the daemon's hello clears its protocol floor, its
 * schema-revision floor, and its server capability.
 *
 * Commands missing from the table are unknown to this calibration; prime's
 * client lets those through and lets the daemon answer "Unknown daemon
 * command", so the gate does too.
 */
export interface DaemonCommandCompatibility {
  minProtocol: number;
  minSchemaRevision?: number;
  capability?: string;
}

const LEGACY: DaemonCommandCompatibility = { minProtocol: 7 };
const CLIENT_OWNED: DaemonCommandCompatibility = {
  minProtocol: 7,
  capability: "client_owned_sessions",
};
const SESSION_INPUT_ADMISSION: DaemonCommandCompatibility = {
  minProtocol: 7,
  capability: "session_input_admission",
};
const PROMPT_ADMISSION_CANCELLATION: DaemonCommandCompatibility = {
  minProtocol: 7,
  minSchemaRevision: 8,
  capability: "prompt_admission_cancellation",
};
const RLM_MAX_DEPTH: DaemonCommandCompatibility = {
  minProtocol: 7,
  minSchemaRevision: 11,
};
const DELETE_RLM_SUBAGENT: DaemonCommandCompatibility = {
  minProtocol: 7,
  capability: "delete_rlm_subagent",
};
const FLAT_SESSION_TREE: DaemonCommandCompatibility = { minProtocol: 7 };
const MUTATE_QUEUED_MESSAGE: DaemonCommandCompatibility = {
  minProtocol: 7,
  minSchemaRevision: 15,
  capability: "queue_message_mutation",
};
const HEARTBEAT_CATALOG: DaemonCommandCompatibility = {
  minProtocol: 7,
  capability: "heartbeat_catalog",
};
const HEARTBEAT_MANAGEMENT: DaemonCommandCompatibility = {
  minProtocol: 7,
  capability: "heartbeat_management",
};
const CURRENT: DaemonCommandCompatibility = { minProtocol: 7 };

/**
 * Transcribed from prime-agent 0.7.3 `dist/modes/daemon/daemon-protocol.js`
 * (DAEMON_COMMAND_COMPATIBILITY). Keep in sync when recalibrating. Prime adds
 * a telemetry-policy gate to attach/create when a client sends
 * `telemetryDisabled`; this client never sends it, so that gate is omitted.
 */
export const DAEMON_COMMAND_COMPATIBILITY: Record<
  string,
  DaemonCommandCompatibility | undefined
> = {
  ack_result: LEGACY,
  list: LEGACY,
  list_saved_sessions: LEGACY,
  create: LEGACY,
  attach: LEGACY,
  reattach: LEGACY,
  detach: LEGACY,
  complete_owned_session: CLIENT_OWNED,
  promote_owned_session: CLIENT_OWNED,
  kill: LEGACY,
  rename: LEGACY,
  prompt: SESSION_INPUT_ADMISSION,
  cancel_prompt_admission: PROMPT_ADMISSION_CANCELLATION,
  prompt_and_wait: SESSION_INPUT_ADMISSION,
  steer: SESSION_INPUT_ADMISSION,
  follow_up: SESSION_INPUT_ADMISSION,
  restore_next_turn: LEGACY,
  restore_actions: LEGACY,
  append_custom_message: LEGACY,
  resume_queue: SESSION_INPUT_ADMISSION,
  send_message: LEGACY,
  agent_messages_status: LEGACY,
  agent_messages_pause: LEGACY,
  agent_messages_resume: LEGACY,
  agent_messages_clear: LEGACY,
  abort: LEGACY,
  start_side_question: LEGACY,
  abort_side_question: LEGACY,
  execute_bash: LEGACY,
  abort_bash: LEGACY,
  cancel_rlm_child: LEGACY,
  delete_rlm_subagent: DELETE_RLM_SUBAGENT,
  wait_for_idle: LEGACY,
  wait_for_headless_completion: CURRENT,
  get_session_header: CURRENT,
  get_state: LEGACY,
  get_connection_state: LEGACY,
  get_messages: LEGACY,
  get_session_stats: LEGACY,
  get_context_tree: LEGACY,
  get_commands: LEGACY,
  get_resource_snapshot: LEGACY,
  get_model_catalog: { minProtocol: 7, capability: "model_catalog" },
  get_available_models: LEGACY,
  get_queue: LEGACY,
  mutate_queued_message: MUTATE_QUEUED_MESSAGE,
  clear_queue: LEGACY,
  abort_and_clear_queue: LEGACY,
  cron_list: LEGACY,
  heartbeats_list: HEARTBEAT_CATALOG,
  heartbeat_manage: HEARTBEAT_MANAGEMENT,
  cron_add: LEGACY,
  cron_cancel: LEGACY,
  heartbeat_get: LEGACY,
  heartbeat_set: LEGACY,
  heartbeat_update: LEGACY,
  set_model: LEGACY,
  cycle_model: LEGACY,
  set_scoped_models: LEGACY,
  set_thinking_level: LEGACY,
  set_service_tier: LEGACY,
  cycle_thinking_level: LEGACY,
  set_transport: LEGACY,
  set_steering_mode: LEGACY,
  set_follow_up_mode: LEGACY,
  set_auto_compaction: LEGACY,
  set_auto_retry: CURRENT,
  compact: LEGACY,
  refine: LEGACY,
  abort_compaction: LEGACY,
  abort_branch_summary: LEGACY,
  abort_retry: LEGACY,
  execute_bash_and_wait: CURRENT,
  reload: LEGACY,
  new_session: LEGACY,
  switch_session: LEGACY,
  fork: LEGACY,
  navigate_tree: LEGACY,
  import_jsonl: LEGACY,
  export_html: LEGACY,
  export_jsonl: LEGACY,
  set_session_name: LEGACY,
  get_rlm_max_depth_status: RLM_MAX_DEPTH,
  set_rlm_max_depth: RLM_MAX_DEPTH,
  rename_saved_session: LEGACY,
  delete_saved_session: LEGACY,
  get_session_context: LEGACY,
  get_session_tree: FLAT_SESSION_TREE,
  get_user_messages_for_forking: LEGACY,
  get_last_assistant_text: LEGACY,
  get_system_prompt: LEGACY,
  get_tool_definition: LEGACY,
  set_session_entry_label: LEGACY,
  extension_ui_response: LEGACY,
  prepare_update_restart: LEGACY,
  retry_worker: LEGACY,
  restart: LEGACY,
  shutdown: LEGACY,
};

/** Why a command is unavailable on the connected daemon. */
export interface DaemonCommandUnsupported {
  command: string;
  missing:
    | { kind: "protocol"; required: number; actual: number }
    | { kind: "schema"; required: number; actual: number | undefined }
    | { kind: "capability"; capability: string };
  detail: string;
}

/**
 * Client-side compat gate, checked before every send (prime checks the same
 * three facts from the hello; there is no server round-trip to save).
 */
export function checkDaemonCommandSupport(
  hello: DaemonHello,
  command: string,
): DaemonCommandUnsupported | null {
  const compatibility = DAEMON_COMMAND_COMPATIBILITY[command];
  if (compatibility === undefined) {
    return null;
  }
  if (hello.protocol.version < compatibility.minProtocol) {
    return {
      command,
      missing: {
        kind: "protocol",
        required: compatibility.minProtocol,
        actual: hello.protocol.version,
      },
      detail: `daemon protocol ${hello.protocol.version} is older than the ${compatibility.minProtocol} "${command}" needs`,
    };
  }
  if (
    compatibility.minSchemaRevision !== undefined &&
    (hello.schemaRevision ?? 0) < compatibility.minSchemaRevision
  ) {
    return {
      command,
      missing: {
        kind: "schema",
        required: compatibility.minSchemaRevision,
        actual: hello.schemaRevision,
      },
      detail: `daemon schema revision ${hello.schemaRevision ?? "<none>"} is older than the ${compatibility.minSchemaRevision} "${command}" needs`,
    };
  }
  if (
    compatibility.capability !== undefined &&
    hello.serverCapabilities?.includes(compatibility.capability) !== true
  ) {
    return {
      command,
      missing: {
        kind: "capability",
        capability: compatibility.capability,
      },
      detail: `daemon does not advertise the "${compatibility.capability}" capability "${command}" needs`,
    };
  }
  return null;
}

/** Outgoing command envelope: the daemon rejects anything else. */
export interface DaemonCommandEnvelope {
  type: "command";
  id: string;
  protocol: { name: string; version: number };
  clientId?: string;
  command: { type: string } & Record<string, unknown>;
}

export function createDaemonCommandEnvelope(args: {
  command: { type: string } & Record<string, unknown>;
  id: string;
  clientId?: string;
  /** Answered hello caps the envelope version at what the daemon speaks. */
  hello?: DaemonHello;
}): DaemonCommandEnvelope {
  const negotiated = Math.min(
    args.hello?.protocol.version ?? DAEMON_PROTOCOL_VERSION,
    DAEMON_PROTOCOL_VERSION,
  );
  return {
    type: "command",
    id: args.id,
    protocol: { name: DAEMON_PROTOCOL_NAME, version: negotiated },
    ...(args.clientId === undefined ? {} : { clientId: args.clientId }),
    command: args.command,
  };
}

/** What a hello differs from this bridge's calibration by. */
export interface HelloDrift {
  schemaRevision:
    | { kind: "same" }
    | { kind: "older"; reported: number | undefined; calibrated: number }
    | { kind: "newer"; reported: number | undefined; calibrated: number };
  appVersion:
    | { kind: "same" }
    | { kind: "older"; reported: string; calibrated: string }
    | { kind: "newer"; reported: string; calibrated: string }
    | { kind: "unreported" };
  schemaIdChanged: boolean;
  serverCapabilities:
    | { kind: "same" }
    | { kind: "changed"; reported: number | undefined; calibrated: number };
}

function compareVersionParts(
  reported: string,
  calibrated: string,
): "older" | "newer" | "same" {
  const asTuple = (version: string): number[] =>
    version
      .split(/[.-]/u)
      .map((part) => Number.parseInt(part, 10))
      .map((part) => (Number.isFinite(part) ? part : 0));
  const left = asTuple(reported);
  const right = asTuple(calibrated);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a < b) return "older";
    if (a > b) return "newer";
  }
  return "same";
}

/** Compare a hello against the calibration; every entry is warning material. */
export function describeHelloDrift(hello: DaemonHello): HelloDrift {
  const schemaRevision = hello.schemaRevision;
  let revisionDrift: HelloDrift["schemaRevision"] = { kind: "same" };
  if (schemaRevision !== CALIBRATED_SCHEMA_REVISION) {
    revisionDrift =
      schemaRevision === undefined || schemaRevision < CALIBRATED_SCHEMA_REVISION
        ? { kind: "older", reported: schemaRevision, calibrated: CALIBRATED_SCHEMA_REVISION }
        : { kind: "newer", reported: schemaRevision, calibrated: CALIBRATED_SCHEMA_REVISION };
  }
  const appVersion = hello.appVersion;
  let versionDrift: HelloDrift["appVersion"] = { kind: "same" };
  if (appVersion === undefined) {
    versionDrift = { kind: "unreported" };
  } else {
    const comparison = compareVersionParts(appVersion, CALIBRATED_APP_VERSION);
    if (comparison !== "same") {
      versionDrift =
        comparison === "older"
          ? { kind: "older", reported: appVersion, calibrated: CALIBRATED_APP_VERSION }
          : { kind: "newer", reported: appVersion, calibrated: CALIBRATED_APP_VERSION };
    }
  }
  return {
    schemaRevision: revisionDrift,
    appVersion: versionDrift,
    schemaIdChanged:
      hello.schemaId !== undefined && hello.schemaId !== CALIBRATED_SCHEMA_ID,
    serverCapabilities:
      hello.serverCapabilities?.length === CALIBRATED_SERVER_CAPABILITIES
        ? { kind: "same" }
        : {
            kind: "changed",
            reported: hello.serverCapabilities?.length,
            calibrated: CALIBRATED_SERVER_CAPABILITIES,
          },
  };
}

/** Human-readable drift lines for the health probe's status message. */
export function driftWarnings(hello: DaemonHello): string[] {
  const drift = describeHelloDrift(hello);
  const warnings: string[] = [];
  const revision = drift.schemaRevision;
  if (revision.kind === "newer") {
    warnings.push(
      `prime-agent reports wire schema revision ${revision.reported ?? "<none>"}, newer than the revision ${revision.calibrated} this bridge was calibrated against; untested commands are gated off, everything else keeps working`,
    );
  } else if (revision.kind === "older") {
    warnings.push(
      `prime-agent reports wire schema revision ${revision.reported ?? "<none>"}, older than the revision ${revision.calibrated} this bridge was calibrated against; newer session features may be unavailable`,
    );
  }
  const version = drift.appVersion;
  if (version.kind === "newer") {
    warnings.push(
      `prime-agent ${version.reported} is newer than the ${version.calibrated} this bridge was tested with; report protocol drift if a thread misbehaves`,
    );
  } else if (version.kind === "older") {
    warnings.push(
      `prime-agent ${version.reported} is older than the ${version.calibrated} this bridge was tested with; consider updating prime-agent`,
    );
  } else if (version.kind === "unreported") {
    warnings.push(
      "the prime-agent daemon did not report its app version, so version drift cannot be checked",
    );
  }
  if (drift.schemaIdChanged) {
    warnings.push(
      `the daemon's schema id "${hello.schemaId}" differs from the calibrated "${CALIBRATED_SCHEMA_ID}"`,
    );
  }
  if (drift.serverCapabilities.kind === "changed") {
    warnings.push(
      `the daemon advertises ${drift.serverCapabilities.reported ?? "no"} server capabilities where the calibrated daemon advertised ${drift.serverCapabilities.calibrated}`,
    );
  }
  return warnings;
}

function majorOf(version: string): string {
  return version.split(/[.-]/u)[0] ?? version;
}

/**
 * Whether the greeting names a daemon from a *different generation* than the
 * one this bridge was calibrated for: a protocol version above the one this
 * bridge speaks, or an app version on another side of the first version part.
 * That is staleness, not mere drift — the daemon behind the socket was replaced
 * by an install this bridge has never been tested against.
 *
 * The answer is a warning and nothing more (ADR-0002): the compat gate still
 * gates every command against the *answered* hello, and bb never spawns,
 * replaces, or shuts down a daemon it did not start.
 */
export function staleDaemonWarnings(hello: DaemonHello): string[] {
  const warnings: string[] = [];
  if (hello.protocol.version > DAEMON_PROTOCOL_VERSION) {
    warnings.push(
      `the running daemon speaks protocol ${hello.protocol.version}, newer than the protocol ${DAEMON_PROTOCOL_VERSION} this bridge speaks; commands travel as protocol ${DAEMON_PROTOCOL_VERSION} and newer daemon behavior is untested`,
    );
  }
  const appVersion = hello.appVersion;
  if (
    appVersion !== undefined &&
    majorOf(appVersion) !== majorOf(CALIBRATED_APP_VERSION)
  ) {
    warnings.push(
      `the running daemon is prime-agent ${appVersion}, a different generation than the ${CALIBRATED_APP_VERSION} this bridge was calibrated against; bb leaves it alone — it never starts, replaces, or stops a daemon it did not start`,
    );
  }
  return warnings;
}

/** Every warning a hello earns: generation staleness plus calibration drift. */
export function helloWarnings(hello: DaemonHello): string[] {
  return [...staleDaemonWarnings(hello), ...driftWarnings(hello)];
}

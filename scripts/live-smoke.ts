/**
 * bbpa-ggf.14 — THE live smoke scenario: one command against the machine's
 * installed prime-agent that proves the whole provider end to end.
 *
 *   npm run smoke               (BB_PRIME_AGENT_DAEMON_SOCKET overrides the
 *                                daemon socket; anything else is the default)
 *
 * Four named layers, so a failure says WHERE it broke:
 *
 *   1. daemon    — the hello handshake on this machine's socket: version,
 *                  protocol and schema reported, calibration drift surfaced,
 *                  one command round trip.
 *   2. bridge    — the chat path through the real bridge, driven in-process
 *                  like the live lanes do: `thread/start` creates the
 *                  "[bb] " session, a streamed turn answers with real model
 *                  text, a long turn is steered mid-flight (bbpa-ggf.5) and
 *                  the steered answer streams without interrupting anything.
 *   3. subagents — the subagent control path end to end (bbpa-ggf.9/.10): the
 *                  parent spawns ONE subagent through its own rlm() tooling,
 *                  the panel's host entry (`src/subagents/host-entry.ts`,
 *                  driven in-process over this machine's read-only backend
 *                  connection) sees the child live in the roster, steers it,
 *                  stops it, the roster reflects "cancelled", the parent
 *                  timeline settles the child's delegation item as
 *                  interrupted, and the parent session still answers after.
 *   4. cleanup   — the bridge releases the thread, then every daemon session
 *                  in the smoke's own throwaway workspace is removed
 *                  (abort → kill → delete_saved_session, saved-session sweep
 *                  included) and the removal is verified against the daemon's
 *                  own listings, from ops clients with a fresh clientId each.
 *
 * The scenario never touches a session it did not create: it works only in a
 * fresh `mkdtemp` workspace and sweeps by that cwd, and it never spawns,
 * replaces or stops the daemon. The live spawn is model discretion, so it
 * retries once and then fails the layer honestly ("rerun the smoke") —
 * nothing is faked. The env-gated live TESTS stay the fine-grained lanes;
 * this is the umbrella over them.
 */

import "./live-smoke-bootstrap.js";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  experimental_captureBridgeJsonRpcOutput as captureBridgeJsonRpcOutput,
  type CapturedBridgeJsonRpcOutput,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import {
  experimental_createHostEntryHarness as createHostEntryHarness,
} from "@get-bb/plugin-sdk/testing/host";
import {
  handleLine,
  resetDaemonForTests,
  sessionTableForTests,
} from "../src/provider-bridge.js";
import { PrimeDaemonClient } from "../src/daemon/client.js";
import { CALIBRATED_APP_VERSION } from "../src/daemon/protocol.js";
import { probeDaemon } from "../src/daemon/probe.js";
import { resolveDaemonSocketPath } from "../src/daemon/socket.js";
import {
  BB_SESSION_NAME_PREFIX,
  primeSessionName,
} from "../src/session-params.js";
import {
  createSubagentsBackendConnection,
  type SubagentsBackendConnection,
} from "../src/subagents/backend-connection.js";
import type { PrimeChild } from "../src/subagents/children.js";
import { createPrimeSubagentsHostEntry } from "../src/subagents/host-entry.js";
import { PRIME_PROVIDER_THREAD_PREFIX } from "../src/vocabulary.js";

/** The child session name the spawn prompt asks the parent to use. */
const CHILD_NAME = "bb-smoke-child";

/**
 * What the parent is told to spawn: ONE child, named so the roster can tell it
 * from anything else, with a bounded task (compute 2+2) whose first action is
 * a real 150-second pause — the margin the steer and the stop need to arrive
 * while the child is still running.
 */
const SPAWN_PROMPT = [
  "Smoke test: in your IPython kernel run exactly one cell and nothing else:",
  "",
  'handle = await rlm("This is a smoke-test subtask. First run a shell command ' +
    "`sleep 150`" +
    ' (a real 150 second pause) as your first action. After the pause, compute 2+2 ' +
    "in your kernel. Then send the computed answer to your parent with " +
    `agent_message.send(<the answer>, receiver_role='parent').", name="${CHILD_NAME}")`,
  "print(handle.rlm_child_id)",
  "",
  "Do not spawn any other subagent. Do not investigate anything. When the print output is back, reply with exactly the child id it printed.",
].join("\n");

const LONG_TURN_PROMPT =
  "Call the bash tool right now with the command `sleep 15`. Do not run any other " +
  "tool first and do not explain. When the tool returns, reply with exactly this " +
  "word and nothing else: DONE.";

const STEER_PROMPT = "Reply with exactly this word and nothing else: STEERED";

const FULL_OPTIONS = {
  permissionMode: "full",
  permissionScope: "full",
  approvalReviewer: null,
  permissionEscalation: null,
};

/* ----------------------------------------------------------------- output */

/**
 * The report goes to stderr, and must: while the bridge is driven in-process
 * its stdout IS the JSON-RPC transport — the captured `process.stdout.write`
 * parses every line that reaches it, so a report line on stdout would break
 * the run instead of printing it.
 */
const report = (...args: unknown[]): void => {
  console.error(...args);
};

const startedAt = Date.now();

function elapsed(): string {
  const seconds = (Date.now() - startedAt) / 1000;
  return seconds < 60
    ? `${seconds.toFixed(1)}s`
    : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

function headline(text: string): void {
  report(`\n${text}`);
}

function step(text: string): void {
  report(`  ${text}`);
}

function note(text: string): void {
  report(`      ${text}`);
}

/** One layer of the scenario: its failures are reported under its name. */
class LayerFailure extends Error {
  constructor(readonly layer: string, message: string) {
    super(message);
    this.name = "LayerFailure";
  }
}

async function layer<T>(name: string, run: () => Promise<T>): Promise<T> {
  const layerStartedAt = Date.now();
  try {
    const result = await run();
    report(`\n[${name}] ok (${((Date.now() - layerStartedAt) / 1000).toFixed(1)}s)`);
    return result;
  } catch (error) {
    const seconds = ((Date.now() - layerStartedAt) / 1000).toFixed(1);
    const message = error instanceof Error ? error.message : String(error);
    report(`\n[${name}] FAILED (${seconds}s): ${message}`);
    throw error instanceof LayerFailure ? error : new LayerFailure(name, message);
  }
}

/* ---------------------------------------------------------- live helpers */

const socketPath = resolveDaemonSocketPath();

let output: CapturedBridgeJsonRpcOutput | undefined;
let collected: unknown[] = [];

function startBridgeCapture(): void {
  output = captureBridgeJsonRpcOutput();
  collected = [];
}

function stopBridgeCapture(): void {
  output?.restore();
  output = undefined;
  collected = [];
}

function messages(): unknown[] {
  for (const message of output?.takeMessages() ?? []) {
    collected.push(message);
  }
  return collected;
}

interface BridgeResponse {
  id: string;
  result?: Record<string, unknown>;
  error?: unknown;
}

function responses(): BridgeResponse[] {
  return messages().filter(
    (message): message is BridgeResponse =>
      typeof message === "object" &&
      message !== null &&
      !("method" in (message as Record<string, unknown>)),
  );
}

function deltas(threadId: string): Array<Record<string, unknown>> {
  return messages()
    .filter(
      (message): message is { method: string; params: Record<string, unknown> } =>
        typeof message === "object" &&
        message !== null &&
        (message as Record<string, unknown>).method === "thread/delta",
    )
    .filter((message) => message.params.threadId === threadId)
    .flatMap((message) => message.params.deltas as Array<Record<string, unknown>>);
}

function streamedText(list: Array<Record<string, unknown>>): string {
  return list
    .filter((delta) => delta.kind === "item.textDelta")
    .map((delta) => String(delta.text))
    .join("");
}

function sendRequest(id: string, method: string, params: unknown): void {
  handleLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
}

/**
 * bb's `clientRequestId` shape (`creq_` + 10 chars of bb's unambiguous
 * alphabet) — the bridge validates it before the session ever sees a prompt.
 */
function clientRequestId(): string {
  const alphabet = "23456789abcdefghijkmnpqrstuvwxyz";
  let suffix = "";
  for (let index = 0; index < 10; index += 1) {
    suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return `creq_${suffix}`;
}

/**
 * One bb turn through the bridge, answered: a refused turn fails the layer
 * here instead of letting a later wait time out against a turn that never was.
 */
async function startTurn(args: {
  requestId: string;
  text: string;
}): Promise<void> {
  sendRequest(args.requestId, "turn/start", {
    threadId: subject.threadId,
    providerThreadId: subject.providerThreadId,
    input: [{ type: "text", text: args.text, mentions: [] }],
    clientRequestId: clientRequestId(),
    options: FULL_OPTIONS,
  });
  await waitFor(`the ${args.requestId} turn/start response`, () =>
    responses().some((reply) => reply.id === args.requestId),
  );
  const reply = responses().find((candidate) => candidate.id === args.requestId)!;
  if (reply.error !== undefined) {
    throw new Error(`turn/start failed: ${JSON.stringify(reply.error)}`);
  }
}

/**
 * The thread a wait's diagnostic tail describes; set once the bridge layer has
 * a thread, so a timeout says what the bridge was (not) emitting.
 */
let diagnosticThreadId: string | undefined;

/** What the bridge emitted so far, compact — the tail a timeout is quoted with. */
function bridgeTail(): string {
  const errorReplies = responses()
    .filter((reply) => reply.error !== undefined)
    .map((reply) => `${reply.id}: ${JSON.stringify(reply.error)}`);
  const kinds = diagnosticThreadId
    ? deltas(diagnosticThreadId).map((delta) => String(delta.kind))
    : [];
  const lastKinds = kinds.slice(-8).join(", ");
  return `bridge tail: errors=[${errorReplies.join(" | ")}] deltas(${kinds.length})=[${lastKinds}]`;
}

async function waitFor(
  label: string,
  predicate: () => boolean,
  timeoutMs = 120_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let heartbeat = Date.now();
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for ${label} (${bridgeTail()})`,
      );
    }
    if (Date.now() - heartbeat >= 20_000) {
      note(`still waiting for ${label} (${Math.round((Date.now() - (deadline - timeoutMs)) / 1000)}s)`);
      heartbeat = Date.now();
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Same poll, for predicates that themselves talk to the daemon. */
async function waitForAsync(
  label: string,
  predicate: () => Promise<boolean>,
  timeoutMs = 90_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for ${label} (${bridgeTail()})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One ops connection to the daemon. A fresh clientId per connection: the
 * daemon journals mutating commands by (clientId, envelope id) and replays a
 * recorded response on a repeat, so a fixed id would silently turn this run's
 * cleanup into a previous run's recorded answer (spike, wire facts).
 */
async function withOpsClient<T>(
  run: (client: PrimeDaemonClient) => Promise<T>,
): Promise<T> {
  const client = new PrimeDaemonClient({
    socketPath,
    clientId: `bbpa-smoke-${Math.random().toString(36).slice(2, 10)}`,
  });
  try {
    await client.connect();
    return await run(client);
  } finally {
    client.close();
  }
}

interface DaemonSessionListing {
  activeSessionId?: string;
  sessionFile?: string;
  sessionName?: string;
  cwd?: string;
}

/** What prime's own catalog lists, verbatim. */
async function listDaemonSessions(): Promise<DaemonSessionListing[]> {
  return await withOpsClient(async (client) => {
    const listing = await client.request({ type: "list" });
    if (!listing.success) {
      throw new Error(`the daemon refused "list": ${listing.error ?? "unknown error"}`);
    }
    return (
      (listing.data as { sessions?: DaemonSessionListing[] } | undefined)?.sessions ?? []
    );
  });
}

/* ---------------------------------------------------------------- the run */

/** Everything the smoke created, for the cleanup layer to remove. */
const subject: {
  workspaceDir: string;
  threadId: string;
  sessionName: string;
  activeSessionId?: string;
  providerThreadId?: string;
} = {
  workspaceDir: "",
  threadId: "",
  sessionName: "",
};

async function main(): Promise<number> {
  headline(`bb prime-agent live smoke — socket ${socketPath}`);
  if (!existsSync(socketPath)) {
    report(
      "[daemon] FAILED: no daemon socket — prime-agent is not running (the smoke never starts it)",
    );
    note(
      "Start prime-agent once, or point BB_PRIME_AGENT_DAEMON_SOCKET at a running daemon.",
    );
    await exitWith(1);
  }

  let failed: string | undefined;
  try {
    await layer("daemon", daemonLayer);
    await layer("bridge", bridgeLayer);
    await layer("subagents", subagentsLayer);
  } catch (error) {
    failed = error instanceof LayerFailure ? error.layer : "unknown";
    const message = error instanceof Error ? error.message : String(error);
    headline(`SMOKE FAIL (${elapsed()}) — ${failed} layer: ${message}`);
    note(hintFor(failed, message));
  }

  const cleanup = await layer("cleanup", cleanupLayer);
  if (cleanup !== "clean") {
    note(cleanup);
    failed ??= "cleanup";
  }
  stopBridgeCapture();
  if (failed === undefined) {
    headline(`SMOKE PASS (${elapsed()})`);
    return 0;
  }
  return 1;
}

/**
 * Set the exit code and end the process without truncating the report: a bare
 * `process.exit` drops pending stdout writes on a pipe, which is how a
 * failure can print nothing at all. A short grace flushes them; the hard exit
 * then guarantees termination even if a socket handle leaked.
 */
async function exitWith(code: number): Promise<never> {
  process.exitCode = code;
  await delay(250);
  process.exit(code);
}

function hintFor(layer: string, message: string): string {
  switch (layer) {
    case "daemon":
      return "Nothing to talk to, or the greeting is not one this bridge can speak: check that prime-agent is running and which socket BB_PRIME_AGENT_DAEMON_SOCKET names.";
    case "bridge":
      return "The bridge ↔ daemon chat path is broken. The fine-grained lane is `BBPA_LIVE_DAEMON=1 npx vitest run provider-bridge.live.test.ts`.";
    case "subagents":
      return message.includes("did not spawn")
        ? "A live spawn is model discretion. Rerun the smoke."
        : "The subagent control path is broken (bridge roster or host entry, daemon control commands, or plugin backend). The fine-grained lanes are `BBPA_LIVE_DAEMON=1 npx vitest run src/subagents/live-roster.test.ts src/subagents/live-control.test.ts`.";
    default:
      return "Leftover sessions may linger in prime-agent's catalog; remove them from prime-agent if they do.";
  }
}

/* ------------------------------------------------------- layer 1: daemon */

async function daemonLayer(): Promise<void> {
  const probe = await probeDaemon({ socketPath });
  if (probe.status === "unreachable") {
    throw new Error(`no daemon answered at ${probe.socketPath} (${probe.reason})`);
  }
  if (probe.status === "handshake_failed") {
    const version = probe.hello?.appVersion ?? "unknown version";
    throw new Error(
      `the daemon at ${probe.socketPath} answered with a greeting this bridge cannot use (${version}): ${probe.reason}`,
    );
  }
  const { hello } = probe;
  step(
    `hello: prime-agent ${hello.appVersion ?? "?"}, protocol ${hello.protocol.name} v${hello.protocol.version}`,
  );
  step(
    `schema: ${hello.schemaId ?? "?"} (revision ${hello.schemaRevision ?? "?"}), ${hello.serverCapabilities?.length ?? 0} server capabilities`,
  );
  if (hello.appVersion !== CALIBRATED_APP_VERSION) {
    note(
      `drift: calibrated against ${CALIBRATED_APP_VERSION}; newer releases warn, they do not block`,
    );
  }
  for (const warning of probe.warnings) {
    note(`warning: ${warning}`);
  }
  // A socket that greets must also answer commands: the compat gate and the
  // response correlation are what every later layer leans on.
  const sessions = await listDaemonSessions();
  step(`command round trip: "list" answered (${sessions.length} sessions in the catalog)`);
}

/* ------------------------------------------------------- layer 2: bridge */

async function bridgeLayer(): Promise<void> {
  startBridgeCapture();
  resetDaemonForTests();
  const nonce = Math.random().toString(36).slice(2, 8);
  subject.workspaceDir = mkdtempSync(join(tmpdir(), "bb-prime-smoke-"));
  subject.threadId = `thr_smoke_${nonce}`;
  diagnosticThreadId = subject.threadId;
  const openingPrompt = "Reply with exactly: SMOKE_OK";
  subject.sessionName = primeSessionName({ threadId: subject.threadId, title: openingPrompt });
  if (!subject.sessionName.startsWith(BB_SESSION_NAME_PREFIX)) {
    throw new Error('the bridge did not name the session with the "[bb] " prefix');
  }

  // --- thread/start: the resident session is created in the bb workspace. ---
  sendRequest("start", "thread/start", {
    threadId: subject.threadId,
    cwd: subject.workspaceDir,
    instructionMode: "append",
    options: FULL_OPTIONS,
    input: [{ type: "text", text: openingPrompt, mentions: [] }],
  });
  await waitFor("the thread/start response", () =>
    responses().some((reply) => reply.id === "start"),
  );
  const startReply = responses().find((reply) => reply.id === "start")!;
  if (startReply.error !== undefined) {
    throw new Error(`thread/start failed: ${JSON.stringify(startReply.error)}`);
  }
  subject.providerThreadId = String(startReply.result?.providerThreadId);
  if (!subject.providerThreadId.startsWith(PRIME_PROVIDER_THREAD_PREFIX)) {
    throw new Error(
      `thread/start answered a non-daemon provider thread id: ${subject.providerThreadId}`,
    );
  }
  const record = sessionTableForTests().byThread(subject.threadId);
  subject.activeSessionId = record?.activeSessionId;
  if (subject.activeSessionId === undefined) {
    throw new Error("thread/start answered but no daemon session was adopted");
  }
  step(
    `created ${JSON.stringify(subject.sessionName)} → ${subject.providerThreadId} (${subject.activeSessionId})`,
  );

  // --- the streamed turn: real model text, usage, a completed boundary. ---
  await waitFor("the opening turn to settle", () =>
    deltas(subject.threadId).some(
      (delta) => delta.kind === "turn.boundary" && delta.status === "completed",
    ),
  );
  const kinds = deltas(subject.threadId).map((delta) => delta.kind);
  if (kinds[0] !== "session.reset") {
    throw new Error(`the timeline did not open with session.reset (got ${String(kinds[0])})`);
  }
  const streamed = streamedText(deltas(subject.threadId));
  if (!streamed.includes("SMOKE_OK")) {
    throw new Error(
      `the model's answer never streamed (timeline text: ${JSON.stringify(streamed.slice(0, 200))})`,
    );
  }
  if (!kinds.includes("usage")) {
    throw new Error("the streamed turn carried no usage delta");
  }
  step(
    `streamed turn answered ${JSON.stringify(streamed.trim().slice(0, 60))} (usage + completed boundary)`,
  );

  // The session is in prime's own catalog, under the [bb] name and this cwd.
  const listed = await listDaemonSessions();
  const mine = listed.filter((session) => session.sessionName === subject.sessionName);
  if (mine.length !== 1) {
    throw new Error(
      `prime's catalog lists ${mine.length} sessions named ${JSON.stringify(subject.sessionName)}`,
    );
  }
  if (mine[0]?.cwd !== subject.workspaceDir) {
    throw new Error(
      `prime's catalog entry for the smoke session has cwd ${String(mine[0]?.cwd)}, not the bb workspace`,
    );
  }
  step("prime's catalog lists the session under the [bb] name and the bb workspace cwd");

  // --- a long turn, steered mid-flight (bbpa-ggf.5). ---
  await startTurn({
    requestId: "turn2",
    text: LONG_TURN_PROMPT,
  });
  await waitFor("the long turn to open", () =>
    deltas(subject.threadId).filter((delta) => delta.kind === "turn.open").length >= 2,
  );
  const steerClientRequestId = clientRequestId();
  sendRequest("steer", "turn/steer", {
    threadId: subject.threadId,
    providerThreadId: subject.providerThreadId,
    expectedTurnId: "turn-smoke-2",
    input: [{ type: "text", text: STEER_PROMPT, mentions: [] }],
    clientRequestId: steerClientRequestId,
    options: FULL_OPTIONS,
  });
  await waitFor("the steer response", () => responses().some((reply) => reply.id === "steer"));
  const steerReply = responses().find((reply) => reply.id === "steer")!;
  if (steerReply.error !== undefined) {
    throw new Error(`turn/steer failed: ${JSON.stringify(steerReply.error)}`);
  }
  const all = deltas(subject.threadId);
  if (
    !all.some(
      (delta) =>
        delta.kind === "input.accepted" && delta.clientRequestId === steerClientRequestId,
    ) ||
    !all.some((delta) => delta.kind === "input.provider" && delta.text === STEER_PROMPT)
  ) {
    throw new Error("the steer never landed on the timeline as provider input");
  }
  await waitFor("the queue state delta", () =>
    deltas(subject.threadId).some(
      (delta) =>
        delta.kind === "extension.state" && delta.extensionKind === "prime-agent/queue",
    ),
  );
  const steerIndex = deltas(subject.threadId).findIndex(
    (delta) => delta.kind === "input.provider" && delta.text === STEER_PROMPT,
  );
  await waitFor("the steered answer to stream", () =>
    streamedText(deltas(subject.threadId).slice(steerIndex)).includes("STEERED"),
  );
  if (streamedText(deltas(subject.threadId).slice(0, steerIndex)).includes("STEERED")) {
    throw new Error(
      "STEERED streamed before the steer landed — the scenario is reading the wrong turn",
    );
  }
  if (
    deltas(subject.threadId)
      .slice(steerIndex)
      .some((delta) => delta.kind === "turn.boundary" && delta.status === "interrupted")
  ) {
    throw new Error("the steer interrupted the work in flight");
  }
  step("steered the long turn mid-flight; the steered answer streamed without an interrupt");
}

/* ---------------------------------------------------- layer 3: subagents */

/** The panel's own road in: the host entry over this machine's connection. */
async function startSubagentsRig(): Promise<{
  sent: Array<Record<string, unknown>>;
  roster(args: { activeSessionId: string }): Promise<{ children: PrimeChild[] }>;
  steer(args: {
    activeSessionId: string;
    childId: string;
    message: string;
  }): Promise<{ delivery: string }>;
  stop(args: { activeSessionId: string; childId: string }): Promise<{ cancelled: boolean }>;
  dispose(): Promise<void>;
}> {
  // The recorded wrapper is how the layer asserts what was (not) sent.
  const sent: Array<Record<string, unknown>> = [];
  const upstream = createSubagentsBackendConnection();
  const connection: SubagentsBackendConnection = new Proxy(upstream, {
    get(target, property, receiver) {
      if (property === "request") {
        return (
          command: { type: string } & Record<string, unknown>,
          args?: { timeoutMs?: number },
        ) => {
          sent.push(command);
          return target.request(command, args);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const harness = createHostEntryHarness(
    createPrimeSubagentsHostEntry({ createConnection: () => connection }),
  );
  return {
    sent,
    roster: (args) => harness.experimental_call("subagents.roster", args),
    steer: (args) => harness.experimental_call("subagents.steer", args),
    stop: (args) => harness.experimental_call("subagents.stop", args),
    dispose: async () => {
      await harness.experimental_dispose();
      upstream.dispose();
    },
  };
}

async function subagentsLayer(): Promise<void> {
  if (subject.activeSessionId === undefined || subject.providerThreadId === undefined) {
    throw new Error("the bridge layer did not leave a session to watch");
  }
  const activeSessionId = subject.activeSessionId;
  const rig = await startSubagentsRig();
  try {
    // The attach is also the readiness gate: the session is registered before
    // anything below probes it.
    await rig.roster({ activeSessionId });
    step("panel host entry attached; the roster answered for the session");

    const child = await spawnAndWatchChild(rig, activeSessionId);
    step(
      `roster sees the child live: ${child.sessionName ?? child.id} (${child.status}, session ${child.activeSessionId})`,
    );

    // --- steer the child, the way the panel does. ---
    const steer = await rig.steer({
      activeSessionId,
      childId: child.id,
      message: "Skip the remaining pause and send your parent the computed answer right now.",
    });
    step(`steered the child through the panel path (delivery: ${steer.delivery})`);

    // --- stop it while it is still running: an honest cancelled:true. ---
    let stopped: boolean;
    try {
      stopped = (await rig.stop({ activeSessionId, childId: child.id })).cancelled;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        message.includes("cancelled:false")
          ? "the subagent was not running when the stop arrived, so nothing was stopped; rerun the smoke"
          : message,
      );
    }
    step(`stopped the child through the panel path (cancelled: ${stopped})`);

    // --- the roster reflects "cancelled"; the parent timeline settles it. ---
    await waitForAsync(
      "the roster to report the child cancelled",
      async () => {
        const { children } = await rig.roster({ activeSessionId });
        return children.find((candidate) => candidate.id === child.id)?.status === "cancelled";
      },
      30_000,
    );
    step('roster reflects "cancelled"');

    const opened = deltas(subject.threadId).find(
      (delta) =>
        delta.kind === "item.open" &&
        (delta.item as { type?: string } | undefined)?.type === "delegation" &&
        ((delta.item as { childRef?: string } | undefined)?.childRef === child.id ||
          (delta.item as { childRef?: string } | undefined)?.childRef ===
            child.activeSessionId),
    );
    if (opened === undefined) {
      throw new Error("the parent timeline never opened the child's delegation item");
    }
    await waitFor("the delegation item to settle interrupted", () =>
      deltas(subject.threadId).some(
        (delta) =>
          delta.kind === "item.close" &&
          (delta.key as { channel?: string } | undefined)?.channel === "delegation" &&
          (delta.key as { providerItemId?: string } | undefined)?.providerItemId ===
            child.id &&
          delta.status === "interrupted",
      ),
    );
    step("parent timeline settled the child's delegation item as interrupted");

    // Nothing control-shaped beyond a steer and a stop crossed the wire, and
    // nothing that deletes a ledger row can be spelled from the panel.
    const sentTypes = rig.sent.map((command) => command.type);
    if (sentTypes.includes("delete_rlm_subagent")) {
      throw new Error("the panel path sent prime a ledger delete");
    }
    for (const type of ["send_message", "cancel_rlm_child"]) {
      if (!sentTypes.includes(type)) {
        throw new Error(`the panel path never sent prime "${type}"`);
      }
    }

    // --- the parent is unaffected: it still answers, on its own thread. ---
    const boundariesBefore = deltas(subject.threadId).filter(
      (delta) => delta.kind === "turn.boundary",
    ).length;
    await startTurn({
      requestId: "turn3",
      text: "Reply with exactly: PARENT_OK",
    });
    await waitFor("the parent's post-cancel turn to settle", () => {
      const list = deltas(subject.threadId);
      return (
        list.filter((delta) => delta.kind === "turn.boundary").length > boundariesBefore &&
        streamedText(list).includes("PARENT_OK")
      );
    });
    step("parent unaffected: it answered after the child was cancelled");
  } finally {
    await rig.dispose();
  }
}

/**
 * Prompt the parent to spawn ONE subagent and wait until the roster sees it
 * live and booted (its own daemon session is the selector the panel steers).
 * The spawn is model discretion: one retry, then an honest layer failure.
 */
async function spawnAndWatchChild(
  rig: Awaited<ReturnType<typeof startSubagentsRig>>,
  activeSessionId: string,
): Promise<PrimeChild> {
  const spawnStartedAt = Date.now();
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await startTurn({
      requestId: `spawn${attempt}`,
      text: SPAWN_PROMPT,
    });
    try {
      return await waitForChild(rig, activeSessionId, 90_000);
    } catch {
      step(
        `attempt ${attempt}: the model did not produce a live subagent within 90s` +
          (attempt === 1 ? " — retrying once" : ""),
      );
    }
  }
  throw new LayerFailure("subagents", "the model did not spawn a subagent; rerun the smoke");

  async function waitForChild(
    rig_: Awaited<ReturnType<typeof startSubagentsRig>>,
    session: string,
    timeoutMs: number,
  ): Promise<PrimeChild> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { children } = await rig_.roster({ activeSessionId: session });
      const mine = children.filter((candidate) => candidate.sessionName === CHILD_NAME);
      if (mine.length > 1) {
        throw new Error(
          `the model spawned ${mine.length} subagents; the scenario wants exactly one`,
        );
      }
      const child = mine[0];
      if (
        child !== undefined &&
        (child.status === "running" || child.status === "queued") &&
        child.activeSessionId !== undefined
      ) {
        note(`subagent spawned after ${((Date.now() - spawnStartedAt) / 1000).toFixed(1)}s`);
        return child;
      }
      if (Date.now() > deadline) {
        throw new Error(
          child === undefined
            ? "no subagent appeared in the roster"
            : `the subagent never booted a daemon session (status ${child.status})`,
        );
      }
      await delay(500);
    }
  }
}

/* ------------------------------------------------------- layer 4: cleanup */

/**
 * Release the thread through the bridge, then remove everything the smoke
 * created — the daemon session, its saved file, and any subagent session the
 * scenario's workspace picked up — verified against the daemon's own listings.
 * Sweeping by the throwaway cwd is what makes this safe: only sessions this
 * smoke created in its own workspace can match. Answers a problem description
 * instead of throwing, so a cleanup failure never masks the layer that broke.
 */
async function cleanupLayer(): Promise<string> {
  const problems: string[] = [];

  if (subject.threadId !== "" && subject.providerThreadId !== undefined) {
    sendRequest("release", "thread/stop", {
      threadId: subject.threadId,
      providerThreadId: subject.providerThreadId,
      intent: "release",
      activeTurnId: null,
    });
    try {
      await waitFor("the release response", () =>
        responses().some((reply) => reply.id === "release"),
      );
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (subject.workspaceDir !== "") {
    try {
      await waitForAsync(
        "every smoke session to leave the daemon",
        async () => {
          try {
            return await withOpsClient(async (client) => {
              const listing = await client.request({ type: "list" });
              const sessions =
                (listing.data as { sessions?: DaemonSessionListing[] } | undefined)
                  ?.sessions ?? [];
              const mine = sessions.filter(
                (session) => session.cwd === subject.workspaceDir,
              );
              const saved = await client.request({
                type: "list_saved_sessions",
                cwd: subject.workspaceDir,
                scope: "current",
              });
              const savedSessions =
                (saved.data as { sessions?: Array<{ path?: string }> } | undefined)
                  ?.sessions ?? [];
              if (mine.length === 0 && savedSessions.length === 0) {
                return true;
              }
              // A settled turn still leaves the worker holding the session, and
              // a shutting-down worker can re-save its file: run the round again
              // while the listings are not clean (bounded by this poll).
              for (const session of mine) {
                if (session.activeSessionId === undefined) {
                  continue;
                }
                await client
                  .request({ type: "abort", activeSessionId: session.activeSessionId })
                  .catch(() => {});
                await client
                  .request({ type: "kill", activeSessionId: session.activeSessionId })
                  .catch(() => {});
                if (session.sessionFile !== undefined) {
                  await client
                    .request({
                      type: "delete_saved_session",
                      sessionPath: session.sessionFile,
                    })
                    .catch(() => {});
                }
              }
              for (const savedSession of savedSessions) {
                if (savedSession.path !== undefined) {
                  await client
                    .request({
                      type: "delete_saved_session",
                      sessionPath: savedSession.path,
                    })
                    .catch(() => {});
                }
              }
              return false;
            });
          } catch (error) {
            if (isConnectFailure(error)) {
              // No daemon, no session.
              return true;
            }
            throw error;
          }
        },
        60_000,
      );
      step("cleanup: every session the smoke created is gone from the daemon");
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
    rmSync(subject.workspaceDir, { recursive: true, force: true });
  }

  resetDaemonForTests();
  sessionTableForTests().clear();
  return problems.length === 0 ? "clean" : `cleanup did not finish cleanly: ${problems.join("; ")}`;
}

function isConnectFailure(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  return (
    code === "ECONNREFUSED" ||
    code === "ENOENT" ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT"
  );
}

await exitWith(await main());

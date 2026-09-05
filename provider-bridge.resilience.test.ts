import { describe, expect, it } from "vitest";
import { BRIDGE_JSON_RPC_ERRORS } from "@get-bb/plugin-sdk/provider-bridge";
import { dynamicToolsRegistryForTests } from "./src/provider-bridge.js";
import { setPrimeDaemonTransportFactoryForTests } from "./src/daemon/connection.js";
import { DaemonCapabilityUnavailableError } from "./src/daemon/client.js";
import { checkDaemonCommandSupport } from "./src/daemon/protocol.js";
import type { DaemonHello } from "./src/daemon/protocol.js";
import {
  createScriptedDaemon,
  textTurnEvents,
  type ScriptedDaemonHandle,
} from "./test-support/scripted-daemon.js";
import { calibratedHello } from "./test-support/fake-daemon.js";
import { FakeExtension } from "./test-support/fake-extension.js";
import { BB_TOOLS_CHANNEL_FLAG } from "./src/dynamic-tools/protocol.js";
import {
  CLIENT_REQUEST_ID,
  FULL_OPTIONS,
  startBridgeHarness,
  type BridgeResponse,
} from "./test-support/bridge-harness.js";

/**
 * Daemon-restart resilience (bbpa-ggf.11): a socket that dies mid-turn, the
 * bounded reconnect, the re-attach on a fresh snapshot, drift as a warning —
 * and no takeover of a daemon this bridge did not start.
 */

/** The scripted daemon is created per test; beforeEach re-binds the alias. */
let daemon: ScriptedDaemonHandle;

const h = startBridgeHarness({
  session: {
    activeSessionId: "sess_1",
    sessionFile: "/tmp/prime/sessions/sess_1.jsonl",
    sessionName: "[bb] scripted thread",
    cwd: "/tmp/prime-workspace",
  },
  beforeEachExtra: (harness) => {
    daemon = harness.daemon;
  },
});

const { cwd, sendRequest, deltas, waitFor } = h;

/** Same poll as the harness, with this file's longer settle budget. */
function waitForResponse(id: string, timeoutMs = 4_000): Promise<BridgeResponse> {
  return h.waitForResponse(id, timeoutMs);
}

const TEXT_INPUT = (text: string) => [{ type: "text" as const, text, mentions: [] as never[] }];

async function startThread(
  id: string,
  threadId = "thr_1",
  promptEvents: readonly unknown[] = textTurnEvents({ text: "first answer" }),
): Promise<string> {
  daemon.enqueueCreate();
  daemon.enqueueAttach();
  daemon.enqueuePrompt({ events: promptEvents });
  sendRequest(id, "thread/start", {
    threadId,
    cwd,
    instructionMode: "append",
    options: FULL_OPTIONS,
    input: TEXT_INPUT("first question"),
  });
  const reply = await waitForResponse(id);
  expect(reply.error).toBeUndefined();
  return String(reply.result?.providerThreadId);
}

async function runTurn(
  id: string,
  threadId: string,
  providerThreadId: string,
  args: { text?: string; events?: readonly unknown[] } = {},
): Promise<BridgeResponse> {
  daemon.enqueuePrompt({ events: args.events ?? textTurnEvents({ text: "later answer" }) });
  sendRequest(id, "turn/start", {
    threadId,
    providerThreadId,
    input: TEXT_INPUT(args.text ?? "a later question"),
    clientRequestId: CLIENT_REQUEST_ID,
    options: FULL_OPTIONS,
  });
  return waitForResponse(id);
}

function boundaries(threadId: string): Array<Record<string, unknown>> {
  return deltas(threadId).filter((delta) => delta.kind === "turn.boundary");
}

function warnings(threadId: string): Array<Record<string, unknown>> {
  return deltas(threadId).filter((delta) => delta.kind === "provider.warning");
}

describe("a daemon restart mid-session (bbpa-ggf.11)", () => {
  it("settles the interrupted turn as failed, re-attaches on recovery, and keeps the timeline honest", async () => {
    const providerThreadId = await startThread("t1");
    expect(boundaries("thr_1")).toEqual([
      expect.objectContaining({ kind: "turn.boundary", status: "completed" }),
    ]);

    // The daemon admits the second prompt and dies before anything streams.
    daemon.enqueuePrompt({ events: [] });
    sendRequest("t2", "turn/start", {
      threadId: "thr_1",
      providerThreadId,
      input: TEXT_INPUT("doomed question"),
      clientRequestId: CLIENT_REQUEST_ID,
      options: FULL_OPTIONS,
    });
    await waitFor("the doomed prompt", () => {
      const prompts = daemon.commands.filter((command) => command.type === "prompt");
      return prompts.length === 2;
    });
    daemon.drop({ cause: "prime-agent updated itself and restarted the daemon" });

    await waitFor("the failed boundary", () =>
      boundaries("thr_1").some((boundary) => boundary.status === "failed"),
    );
    const failed = deltas("thr_1").filter((delta) => delta.kind === "provider.error").at(-1);
    expect(failed).toMatchObject({
      kind: "provider.error",
      message: expect.stringContaining("dropped mid-turn"),
      detail: expect.stringContaining("restarted"),
    });

    // The daemon comes back: same session id (a coordinated update restores
    // it), a new event generation, and a snapshot that already contains the
    // work the daemon counted while this bridge was offline.
    daemon.enqueueAttach({
      lastEventCursor: { generation: "gen-1", sequence: 40 },
      lastEventSequence: 40,
    });
    daemon.restore();

    await waitFor("the re-attach", () => {
      const attaches = daemon.commands.filter((command) => command.type === "attach");
      return attaches.length === 2;
    });
    await waitForResponse("t2");
    // The turn prime streamed into the void is closed exactly once, by us.
    expect(boundaries("thr_1")).toEqual([
      expect.objectContaining({ kind: "turn.boundary", status: "completed" }),
      expect.objectContaining({ kind: "turn.boundary", status: "failed" }),
    ]);

    // The thread works again.
    const reply = await runTurn("t3", "thr_1", providerThreadId, {
      text: "one more question",
      events: textTurnEvents({ text: "third answer" }),
    });
    expect(reply.error).toBeUndefined();

    const kinds = deltas("thr_1").map((delta) => delta.kind);
    // No reset, no second identity: the re-attach is the *same* session space.
    expect(kinds.filter((kind) => kind === "session.reset")).toHaveLength(1);
    // Nothing was re-rendered from the fresh snapshot, and the third answer
    // streams exactly once.
    expect(
      deltas("thr_1").filter(
        (delta) => delta.kind === "item.textClose" && delta.text === "third answer",
      ),
    ).toHaveLength(1);
    expect(boundaries("thr_1")).toEqual([
      expect.objectContaining({ kind: "turn.boundary", status: "completed" }),
      expect.objectContaining({ kind: "turn.boundary", status: "failed" }),
      expect.objectContaining({ kind: "turn.boundary", status: "completed" }),
    ]);
  });

  it("parks a turn submitted while the daemon is down and runs it after the re-attach", async () => {
    const providerThreadId = await startThread("t1");

    daemon.drop({ cause: "daemon restart" });
    const attachesBefore = daemon.commands.filter((command) => command.type === "attach").length;
    daemon.enqueueAttach({
      lastEventCursor: { generation: "gen-1", sequence: 10 },
      lastEventSequence: 10,
    });
    sendRequest("t2", "turn/start", {
      threadId: "thr_1",
      providerThreadId,
      input: TEXT_INPUT("asked during the restart"),
      clientRequestId: CLIENT_REQUEST_ID,
      options: FULL_OPTIONS,
    });

    await new Promise((resolve) => setTimeout(resolve, 40));
    // The prompt is not sent into the void: the lane waits for its re-attach,
    // because session events reach only attached clients.
    expect(daemon.commands.filter((command) => command.type === "prompt")).toHaveLength(1);

    daemon.enqueuePrompt({ events: textTurnEvents({ text: "answered after the restart" }) });
    daemon.restore();
    await waitFor("the re-attach", () => {
      const attaches = daemon.commands.filter((command) => command.type === "attach");
      return attaches.length === attachesBefore + 1;
    });

    // The prompt goes out only after the lane re-attached.
    await waitFor("the prompt", () => {
      const prompts = daemon.commands.filter((command) => command.type === "prompt");
      return prompts.length === 2;
    });
    const kinds = daemon.commands.map((command) => command.type);
    expect(kinds.lastIndexOf("attach")).toBeLessThan(kinds.lastIndexOf("prompt"));
    const reply = await waitForResponse("t2");
    expect(reply.error).toBeUndefined();
    expect(boundaries("thr_1").at(-1)).toMatchObject({ status: "completed" });
    expect(
      deltas("thr_1").filter(
        (delta) => delta.kind === "item.textClose" && delta.text === "answered after the restart",
      ),
    ).toHaveLength(1);
  });

  it("fails a turn with a legible error when the daemon never comes back", async () => {
    daemon = createScriptedDaemon({
      session: {
        activeSessionId: "sess_1",
        sessionFile: "/tmp/prime/sessions/sess_1.jsonl",
        sessionName: "[bb] scripted thread",
        cwd,
      },
      reconnectBudgetMs: 150,
    });
    setPrimeDaemonTransportFactoryForTests(() => daemon.transport);
    const providerThreadId = await startThread("t1");

    daemon.drop({ cause: "the daemon host was switched off" });
    sendRequest("t2", "turn/start", {
      threadId: "thr_1",
      providerThreadId,
      input: TEXT_INPUT("asked into a dead wire"),
      clientRequestId: CLIENT_REQUEST_ID,
      options: FULL_OPTIONS,
    });

    const reply = await waitForResponse("t2", 6_000);
    expect(reply.error?.code).toBe(BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR);
    expect(reply.error?.message).toContain("did not come back");
    expect(reply.error?.message).toContain("gave up reconnecting");
  });

  it("warns about protocol drift on the reconnect hello and keeps the thread usable", async () => {
    const providerThreadId = await startThread("t1");
    expect(warnings("thr_1")).toEqual([]);

    daemon.drop();
    daemon.enqueueAttach({
      lastEventCursor: { generation: "gen-1", sequence: 30 },
      lastEventSequence: 30,
    });
    daemon.restore({
      hello: calibratedHello({ appVersion: "0.9.0", schemaRevision: 19 }) as unknown as DaemonHello,
    });
    await waitFor("the drift warning", () => warnings("thr_1").length === 1);

    const drift = warnings("thr_1")[0]!;
    expect(drift).toMatchObject({
      kind: "provider.warning",
      category: "general",
      summary: expect.stringContaining("protocol drift"),
    });
    const details = String(drift.details);
    expect(details).toContain("0.9.0 is newer than the 0.7.3");
    expect(details).toContain("revision 19");

    // A thread on a drifted daemon still runs.
    const reply = await runTurn("t2", "thr_1", providerThreadId, {
      events: textTurnEvents({ text: "drifted but alive" }),
    });
    expect(reply.error).toBeUndefined();
    expect(boundaries("thr_1").at(-1)).toMatchObject({ status: "completed" });

    // And a second restart onto the *same* build does not nag twice: the
    // verdict is unchanged, so the lane stays quiet about it.
    daemon.enqueueAttach();
    daemon.drop();
    daemon.restore({
      hello: calibratedHello({ appVersion: "0.9.0", schemaRevision: 19 }) as unknown as DaemonHello,
    });
    await waitFor("the second re-attach", () => {
      const attaches = daemon.commands.filter((command) => command.type === "attach");
      return attaches.length === 3;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(warnings("thr_1")).toHaveLength(1);
  });

  it("answers a command the drifted daemon no longer supports with an honest per-command error", async () => {
    // The hello the client gates against, mirrored here so the wrapper can
    // play the same pre-send check the socket client runs from its own hello.
    let hello = calibratedHello() as unknown as DaemonHello;
    const gatedTransport = {
      ...daemon.transport,
      async request(command: { type: string } & Record<string, unknown>) {
        const unsupported = checkDaemonCommandSupport(hello, command.type);
        if (unsupported !== null) {
          throw new DaemonCapabilityUnavailableError(unsupported);
        }
        return daemon.transport.request(command);
      },
    };
    setPrimeDaemonTransportFactoryForTests(() => gatedTransport);
    const providerThreadId = await startThread("t1");

    // The reconnect lands on a build that dropped the capability `prompt`
    // needs: the gate refuses it before anything hits the wire.
    const drifted = calibratedHello() as unknown as DaemonHello;
    drifted.serverCapabilities = (drifted.serverCapabilities ?? []).filter(
      (capability: string) => capability !== "session_input_admission",
    );
    hello = drifted;
    daemon.drop();
    daemon.enqueueAttach({
      lastEventCursor: { generation: "gen-1", sequence: 50 },
      lastEventSequence: 50,
    });
    daemon.restore({ hello: drifted });

    await waitFor("the re-attach", () => {
      const attaches = daemon.commands.filter((command) => command.type === "attach");
      return attaches.length === 2;
    });
    sendRequest("t2", "turn/start", {
      threadId: "thr_1",
      providerThreadId,
      input: TEXT_INPUT("anything"),
      clientRequestId: CLIENT_REQUEST_ID,
      options: FULL_OPTIONS,
    });
    const reply = await waitForResponse("t2");
    expect(reply.error?.code).toBe(BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR);
    expect(reply.error?.message).toContain('cannot run "prompt"');
    expect(reply.error?.message).toContain("session_input_admission");
    // The gated command never reached the daemon (one prompt so far: the
    // thread's first turn, sent before the drift).
    expect(daemon.commands.filter((command) => command.type === "prompt")).toHaveLength(1);
  });

  it("warns about a stale foreign daemon and never sends a takeover command", async () => {
    const providerThreadId = await startThread("t1");

    daemon.drop();
    daemon.enqueueAttach();
    daemon.restore({
      hello: calibratedHello({
        appVersion: "1.0.0",
        protocol: { name: "prime-agent.daemon", version: 8 },
      }) as unknown as DaemonHello,
    });
    await waitFor("the staleness warning", () => warnings("thr_1").length === 1);

    const staleness = String(warnings("thr_1")[0]!.details);
    expect(staleness).toContain("different generation");
    expect(staleness).toContain("1.0.0");
    expect(staleness).toContain("never starts, replaces, or stops");

    // The thread keeps working where the protocol allows…
    const reply = await runTurn("t2", "thr_1", providerThreadId, {
      events: textTurnEvents({ text: "foreign daemon, still chatting" }),
    });
    expect(reply.error).toBeUndefined();

    // …and bb never touches the daemon itself: no restart, no shutdown, no
    // update restart, no reload, and nothing that closes or removes sessions.
    const takeover = daemon.commands.filter((command) =>
      ["restart", "shutdown", "prepare_update_restart", "reload", "kill", "delete_saved_session"].includes(
        String(command.type),
      ),
    );
    expect(takeover).toEqual([]);
  });

  it("keeps the dynamic-tools channel alive across the restart and re-publishes the queued set", async () => {
    const tools = [
      {
        name: "bb_echo",
        description: "Echo a message back",
        inputSchema: {
          type: "object" as const,
          properties: { message: { type: "string" as const } },
          required: ["message"],
        },
      },
    ];
    daemon.enqueueCreate();
    daemon.enqueueAttach();
    daemon.enqueuePrompt({ events: textTurnEvents({ text: "ok" }) });
    sendRequest("t1", "thread/start", {
      threadId: "thr_1",
      cwd,
      instructionMode: "append",
      options: FULL_OPTIONS,
      input: TEXT_INPUT("first question"),
      dynamicTools: tools,
    });

    const registry = dynamicToolsRegistryForTests();
    await waitFor("the channel to listen", () => registry.channel("thr_1") !== undefined);
    const channelPath = registry.sessionConfig("thr_1")?.extensionFlagValues[BB_TOOLS_CHANNEL_FLAG];
    const firstWorker = await FakeExtension.connect(channelPath!);
    await waitForResponse("t1");
    await waitFor("the tool set", () =>
      firstWorker.received.some((message) => message.type === "tools/set"),
    );

    // The daemon restarts; the worker that subscribed to the channel is gone.
    await firstWorker.close();
    daemon.enqueueAttach({
      lastEventCursor: { generation: "gen-1", sequence: 20 },
      lastEventSequence: 20,
    });
    daemon.drop();
    daemon.restore();
    await waitFor("the re-attach", () => {
      const attaches = daemon.commands.filter((command) => command.type === "attach");
      return attaches.length === 2;
    });

    // The channel survived the restart, and the respawned worker's extension
    // reconnects to the same path and is handed the queued set unprompted.
    expect(registry.channel("thr_1")).toBeDefined();
    const respawnedWorker = await FakeExtension.connect(channelPath!);
    try {
      await waitFor("the re-published set", () =>
        respawnedWorker.received.some((message) => message.type === "tools/set"),
      );
      const set = respawnedWorker.received.find((message) => message.type === "tools/set")! as {
        tools: { name: string }[];
      };
      expect(set.tools.map((tool) => tool.name)).toEqual(["bb_echo"]);
    } finally {
      await respawnedWorker.close();
    }
  });
});

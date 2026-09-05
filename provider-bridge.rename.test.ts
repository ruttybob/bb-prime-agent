import { describe, expect, it } from "vitest";
import { BRIDGE_JSON_RPC_ERRORS } from "@get-bb/plugin-sdk/provider-bridge";
import { sessionTableForTests } from "./src/provider-bridge.js";
import { primeSessionName } from "./src/session-params.js";
import { type ScriptedDaemonHandle } from "./test-support/scripted-daemon.js";
import { FULL_OPTIONS, startBridgeHarness } from "./test-support/bridge-harness.js";

/**
 * bb's `thread/name/set` (bbpa-ggf.7): a rename in bb is reflected in prime's
 * catalog name with the "[bb] " prefix preserved. The active session is
 * renamed in place (`rename`); an inactive one — released, or resident without
 * a lane in this process — is renamed by transcript file
 * (`rename_saved_session`, which finds an active session by file itself).
 */

/** The scripted daemon is created per test; beforeEach re-binds the alias. */
let daemon: ScriptedDaemonHandle;

const SOURCE_FILE = "/tmp/prime/sessions/sess_1.jsonl";

const h = startBridgeHarness({
  session: {
    activeSessionId: "sess_1",
    sessionFile: SOURCE_FILE,
    sessionName: "[bb] scripted thread (thr_1)",
    cwd: "/tmp/prime-workspace",
  },
  beforeEachExtra: (harness) => {
    daemon = harness.daemon;
  },
});

const { cwd, sendRequest, waitForResponse } = h;

/** Start a thread whose resident session is prime_sess_1, and settle it. */
async function startThread(id: string, threadId: string): Promise<string> {
  daemon.enqueueCreate();
  daemon.enqueueAttach();
  sendRequest(id, "thread/start", {
    threadId,
    cwd,
    instructionMode: "append",
    options: FULL_OPTIONS,
  });
  const reply = await waitForResponse(id);
  expect(reply.error).toBeUndefined();
  return String(reply.result?.providerThreadId);
}

describe("thread/name/set (bbpa-ggf.7)", () => {
  it("renames the resident session in place with the [bb] prefix kept", async () => {
    const providerThreadId = await startThread("s1", "thr_1");
    const summaryName = "[bb] Renamed in prime (thr_1)";
    daemon.enqueue(
    { commandType: "rename",

        data: {
        activeSessionId: "sess_1",
        sessionFile: SOURCE_FILE,
        sessionName: summaryName,
      },
    });
    sendRequest("n1", "thread/name/set", {
      threadId: "thr_1",
      providerThreadId,
      title: "Renamed in prime",
    });
    const reply = await waitForResponse("n1");
    expect(reply.error).toBeUndefined();
    expect(reply.result).toEqual({ ok: true });
    expect(daemon.commands.find((command) => command.type === "rename")).toMatchObject({
      activeSessionId: "sess_1",
      name: primeSessionName({ threadId: "thr_1", title: "Renamed in prime" }),
    });
    // The catalog name the daemon answered with is what the record keeps.
    expect(sessionTableForTests().byThread("thr_1")?.sessionName).toBe(summaryName);
  });

  it("keeps a title-less rename on the thread-id fallback, never an empty name", async () => {
    const providerThreadId = await startThread("s1", "thr_1");
    daemon.enqueue(
    { commandType: "rename",
   data: { activeSessionId: "sess_1" } });
    sendRequest("n1", "thread/name/set", {
      threadId: "thr_1",
      providerThreadId,
      title: "   ",
    });
    const reply = await waitForResponse("n1");
    expect(reply.error).toBeUndefined();
    const rename = daemon.commands.find((command) => command.type === "rename")!;
    expect(rename.name).toBe(primeSessionName({ threadId: "thr_1" }));
    expect((rename.name as string).startsWith("[bb] ")).toBe(true);
  });

  it("renames an inactive session through its transcript file", async () => {
    // A record whose lane never attached in this process (e.g. adopted by id),
    // holding only the daemon-derived identity and the transcript file.
    sessionTableForTests().register({
      threadId: "thr_idle",
      providerThreadId: "prime_sess_9",
      cwd,
      createdAt: 0,
      dynamicTools: [],
      turns: 0,
      activeSessionId: "sess_9",
      sessionFile: "/tmp/prime/sessions/sess_9.jsonl",
    });
    daemon.enqueue(
    { commandType: "rename_saved_session",
   data: { ok: true } });
    sendRequest("n1", "thread/name/set", {
      threadId: "thr_idle",
      providerThreadId: "prime_sess_9",
      title: "Idle but named",
    });
    const reply = await waitForResponse("n1");
    expect(reply.error).toBeUndefined();
    expect(daemon.commands.find((command) => command.type === "rename_saved_session")).toMatchObject({
      sessionPath: "/tmp/prime/sessions/sess_9.jsonl",
      name: primeSessionName({ threadId: "thr_idle", title: "Idle but named" }),
    });
    expect(daemon.commands.some((command) => command.type === "rename")).toBe(false);
    expect(sessionTableForTests().byThread("thr_idle")?.sessionName).toBe(
      primeSessionName({ threadId: "thr_idle", title: "Idle but named" }),
    );
  });

  it("renames a thread this process released by reading the daemon state", async () => {
    const providerThreadId = await startThread("s1", "thr_1");
    daemon.enqueueOk("detach");
    sendRequest("r1", "thread/stop", {
      threadId: "thr_1",
      providerThreadId,
      intent: "release",
      activeTurnId: null,
    });
    await waitForResponse("r1");
    expect(sessionTableForTests().byThread("thr_1")).toBeUndefined();

    // Released: no record, but the persisted provider thread id still names
    // the session, and get_state names its file.
    daemon.enqueue(
    { commandType: "get_state",

        data: { activeSessionId: "sess_1", sessionFile: SOURCE_FILE },
    });
    daemon.enqueue(
    { commandType: "rename_saved_session",
   data: { ok: true } });
    sendRequest("n1", "thread/name/set", {
      threadId: "thr_1",
      providerThreadId,
      title: "Named after release",
    });
    const reply = await waitForResponse("n1");
    expect(reply.error).toBeUndefined();
    expect(daemon.commands.find((command) => command.type === "get_state")).toMatchObject({
      activeSessionId: "sess_1",
    });
    expect(daemon.commands.find((command) => command.type === "rename_saved_session")).toMatchObject({
      sessionPath: SOURCE_FILE,
    });
  });

  it("answers an unknown thread honestly", async () => {
    sendRequest("n1", "thread/name/set", {
      threadId: "thr_unknown",
      providerThreadId: "codex_rollout_9",
      title: "Nobody home",
    });
    const reply = await waitForResponse("n1");
    expect(reply.error?.code).toBe(BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR);
    expect(reply.error?.message).toMatch(/no prime-agent session is known for thread thr_unknown/);
    expect(daemon.commands).toEqual([]);
  });

  it("surfaces prime's refusal instead of pretending the rename landed", async () => {
    const providerThreadId = await startThread("s1", "thr_1");
    daemon.enqueueFail("rename", "an agent of that name already exists");
    sendRequest("n1", "thread/name/set", {
      threadId: "thr_1",
      providerThreadId,
      title: "Collides with a foreign session",
    });
    const reply = await waitForResponse("n1");
    expect(reply.error?.code).toBe(BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR);
    expect(reply.error?.message).toMatch(/an agent of that name already exists/);
    // The record still names the session the way prime knows it.
    expect(sessionTableForTests().byThread("thr_1")?.sessionName).not.toBe(
      primeSessionName({ threadId: "thr_1", title: "Collides with a foreign session" }),
    );
  });
});

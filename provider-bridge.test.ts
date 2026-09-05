import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  experimental_captureBridgeJsonRpcOutput as captureBridgeJsonRpcOutput,
  type CapturedBridgeJsonRpcOutput,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import { BRIDGE_JSON_RPC_ERRORS } from "@get-bb/plugin-sdk/provider-bridge";
import {
  currentConfiguredSkillRoots,
  experimental_providerBridge,
  handleLine,
  resetDaemonForTests,
  sessionTableForTests,
} from "./src/provider-bridge.js";
import { setPrimeDaemonTransportFactoryForTests } from "./src/daemon/connection.js";
import { primeAgentDir } from "./src/session-params.js";
import {
  createScriptedDaemon,
  textTurnEvents,
  type ScriptedDaemonHandle,
} from "./test-support/scripted-daemon.js";

let output: CapturedBridgeJsonRpcOutput;
let collected: unknown[] = [];
let daemon: ScriptedDaemonHandle;
let cwd: string;

beforeEach(() => {
  output = captureBridgeJsonRpcOutput();
  collected = [];
  cwd = "/tmp/prime-workspace";
  daemon = createScriptedDaemon({
    session: {
      activeSessionId: "sess_1",
      sessionFile: "/tmp/prime/sessions/sess_1.jsonl",
      sessionName: "[bb] scripted thread",
      cwd,
    },
  });
  setPrimeDaemonTransportFactoryForTests(() => daemon.transport);
});

afterEach(() => {
  output.restore();
  setPrimeDaemonTransportFactoryForTests(undefined);
  resetDaemonForTests();
  sessionTableForTests().clear();
});

/**
 * Every read drains the capture and accumulates: takeMessages is destructive,
 * and several bridge answers arrive asynchronously, so tests either read at the
 * end or poll through this one accumulator.
 */
function messages(): unknown[] {
  collected.push(...output.takeMessages());
  return collected;
}

function sendRequest(id: string, method: string, params: unknown = {}): void {
  handleLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
}

interface Response {
  id: string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

function responses(): Response[] {
  return messages().filter(
    (message): message is Response =>
      typeof message === "object" &&
      message !== null &&
      !("method" in (message as Record<string, unknown>)),
  );
}

function response(id: string): Response {
  const reply = responses().find((message) => message.id === id);
  if (reply === undefined) {
    throw new Error(`no response with id ${id}`);
  }
  return reply;
}

/** Poll for an answer that lands on a later tick (async handlers). */
async function waitForResponse(id: string, timeoutMs = 2_000): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = responses().find((message) => message.id === id);
    if (found !== undefined) {
      return found;
    }
    if (Date.now() > deadline) {
      throw new Error(`no response with id ${id} within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * `onClose` releases its sessions fire-and-forget (the runtime is already
 * gone); wait until the soft-stop chain has reached the daemon.
 */
async function flushedTeardown(timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (daemon.commands.some((command) => command.type === "detach")) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`teardown never reached the daemon within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function notifications(method: string): Array<{ params: Record<string, unknown> }> {
  return messages().filter(
    (message): message is { method: string; params: Record<string, unknown> } =>
      typeof message === "object" &&
      message !== null &&
      (message as Record<string, unknown>).method === method,
  );
}

function deltas(threadId: string): Array<Record<string, unknown>> {
  return notifications("thread/delta")
    .filter((message) => message.params.threadId === threadId)
    .flatMap((message) => message.params.deltas as Array<Record<string, unknown>>);
}

const FULL_OPTIONS = {
  permissionMode: "full",
  permissionScope: "full",
  approvalReviewer: null,
  permissionEscalation: null,
};

/** The runtime mints client request ids as `creq_` + ten [2-9a-kmnp-z] characters. */
const CLIENT_REQUEST_ID = "creq_abcdefghij";

/** Start a thread, create its resident session, and settle the response. */
async function startThread(
  id: string,
  threadId: string,
  input?: Array<{ type: "text"; text: string; mentions: never[] }>,
  promptEvents: readonly unknown[] = textTurnEvents({ text: "ok" }),
): Promise<string> {
  daemon.enqueueCreate();
  daemon.enqueueAttach();
  if (input !== undefined) {
    daemon.enqueuePrompt({ events: promptEvents });
  }
  sendRequest(id, "thread/start", {
    threadId,
    cwd,
    instructionMode: "append",
    options: FULL_OPTIONS,
    ...(input === undefined ? {} : { input }),
  });
  const reply = await waitForResponse(id);
  expect(reply.error).toBeUndefined();
  return String(reply.result?.providerThreadId);
}

async function runTurn(
  id: string,
  threadId: string,
  providerThreadId: string,
  events: readonly unknown[],
  text = "hello",
): Promise<Response> {
  daemon.enqueuePrompt({ events });
  sendRequest(id, "turn/start", {
    threadId,
    providerThreadId,
    input: [{ type: "text", text, mentions: [] }],
    clientRequestId: CLIENT_REQUEST_ID,
    options: FULL_OPTIONS,
  });
  return waitForResponse(id);
}

describe("resident session construction", () => {
  it("creates a daemon-resident session with the [bb] name and the thread cwd", async () => {
    daemon.enqueuePrompt({ events: [] });
    const providerThreadId = await startThread("t1", "thr_1", [
      { type: "text", text: "count the stars", mentions: [] },
    ]);

    // The provider thread id is daemon-derived, so it survives a restart.
    expect(providerThreadId).toBe("prime_sess_1");
    const create = daemon.commands.find((command) => command.type === "create");
    // The bb thread id rides along: prime requires unique names among its
    // resident agents, so two threads with the same first message cannot collide.
    expect(create).toMatchObject({
      name: "[bb] count the stars (thr_1)",
      lifecycle: "resident",
      config: {
        cwd,
        agentDir: primeAgentDir(),
        noExtensions: true,
        noSkills: false,
      },
    });
    const attach = daemon.commands.find((command) => command.type === "attach");
    expect(attach).toMatchObject({ activeSessionId: "sess_1" });
    expect(await waitForResponse("t1")).toMatchObject({
      result: { providerThreadId: "prime_sess_1", sessionRestorable: true },
    });
  });

  it("announces thread/identity and session.reset before the answer, and streams the first turn", async () => {
    const providerThreadId = await startThread("t1", "thr_1", [
      { type: "text", text: "Reply with the single word: ok", mentions: [] },
    ]);

    const identity = notifications("thread/identity").at(-1);
    expect(identity?.params).toMatchObject({
      threadId: "thr_1",
      providerThreadId,
    });
    const kinds = deltas("thr_1").map((delta) => delta.kind);
    // The first turn rides thread/start (no client request id, so no
    // input.accepted): reset, turn open, streamed text, usage, boundary.
    expect(kinds).toEqual([
      "session.reset",
      "turn.open",
      "item.textDelta",
      "item.textClose",
      "usage",
      "turn.boundary",
    ]);
  });

  it("answers a thread/start that fails at the daemon with a legible error", async () => {
    sendRequest("t1", "thread/start", {
      threadId: "thr_1",
      cwd,
      instructionMode: "append",
      options: FULL_OPTIONS,
    });
    const reply = await waitForResponse("t1");
    expect(reply.error?.code).toBe(BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR);
    expect(reply.error?.message).toContain("no \"create\" block left");
    expect(sessionTableForTests().byThread("thr_1")).toBeUndefined();
  });
});

describe("turn streaming", () => {
  it("streams text deltas, closes the stream with the provider-final text, and settles", async () => {
    const providerThreadId = await startThread("t1", "thr_1");
    const reply = await runTurn("t2", "thr_1", providerThreadId, [
      { type: "agent_start" },
      {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "he" },
      },
      {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "llo" },
      },
      {
        type: "message_update",
        assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "hello" },
      },
      {
        type: "agent_end",
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "hello" }],
            stopReason: "stop",
            usage: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 7 },
          },
        ],
      },
    ]);

    expect(reply.result).toEqual({});
    const threadDeltas = deltas("thr_1");
    expect(threadDeltas.map((delta) => delta.kind)).toEqual([
      "session.reset",
      "input.accepted",
      "turn.open",
      "item.textDelta",
      "item.textDelta",
      "item.textClose",
      "usage",
      "turn.boundary",
    ]);
    const [first, second] = threadDeltas.filter(
      (delta) => delta.kind === "item.textDelta",
    );
    expect(first).toMatchObject({
      channel: "agentMessage",
      key: { channel: "assistant" },
      text: "he",
    });
    expect(second).toMatchObject({ text: "llo" });
    expect(threadDeltas.find((delta) => delta.kind === "item.textClose")).toMatchObject({
      channel: "agentMessage",
      text: "hello",
    });
    expect(threadDeltas.find((delta) => delta.kind === "usage")).toMatchObject({
      total: { totalTokens: 7, inputTokens: 5, outputTokens: 2 },
      last: { totalTokens: 7 },
      modelContextWindow: null,
    });
    expect(threadDeltas.at(-1)).toMatchObject({
      kind: "turn.boundary",
      status: "completed",
    });
  });

  it("opens tool items and closes them with their result", async () => {
    const providerThreadId = await startThread("t1", "thr_1");
    await runTurn("t2", "thr_1", providerThreadId, [
      { type: "agent_start" },
      { type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args: { command: "ls", cwd } },
      { type: "tool_execution_update", toolCallId: "call_1", toolName: "bash", partialResult: "a.txt" },
      { type: "tool_execution_end", toolCallId: "call_1", toolName: "bash", result: "a.txt", isError: false },
      {
        type: "agent_end",
        messages: [{ role: "assistant", content: [], stopReason: "toolUse" }],
      },
    ]);

    const threadDeltas = deltas("thr_1");
    expect(threadDeltas.find((delta) => delta.kind === "item.open")).toMatchObject({
      key: { providerItemId: "call_1" },
      item: { type: "command", command: "ls", cwd },
    });
    expect(threadDeltas.find((delta) => delta.kind === "command.outputSnapshot")).toMatchObject({
      key: { providerItemId: "call_1" },
      text: "a.txt",
    });
    expect(threadDeltas.find((delta) => delta.kind === "item.close")).toMatchObject({
      key: { providerItemId: "call_1" },
      status: "completed",
      resultText: "a.txt",
      exitCode: 0,
      aggregatedOutput: "a.txt",
    });
  });

  it("maps thinking streams onto reasoning text keyed per block", async () => {
    const providerThreadId = await startThread("t1", "thr_1");
    await runTurn("t2", "thr_1", providerThreadId, [
      { type: "agent_start" },
      {
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "hmm" },
      },
      {
        type: "message_update",
        assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "hmm" },
      },
      {
        type: "agent_end",
        messages: [{ role: "assistant", content: [], stopReason: "stop" }],
      },
    ]);

    const threadDeltas = deltas("thr_1");
    expect(threadDeltas.find((delta) => delta.kind === "item.textDelta")).toMatchObject({
      channel: "reasoningText",
      key: { channel: "thinking-0" },
      text: "hmm",
    });
    expect(threadDeltas.find((delta) => delta.kind === "item.textClose")).toMatchObject({
      channel: "reasoningText",
      text: "hmm",
    });
  });

  it("settles an aborted turn as interrupted", async () => {
    const providerThreadId = await startThread("t1", "thr_1");
    await runTurn("t2", "thr_1", providerThreadId, [
      { type: "agent_start" },
      {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "partial" },
      },
      {
        type: "agent_end",
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "partial" }],
            stopReason: "aborted",
          },
        ],
      },
    ]);
    expect(deltas("thr_1").at(-1)).toMatchObject({
      kind: "turn.boundary",
      status: "interrupted",
    });
  });

  it("reports a failed assistant message as a provider error and a failed turn", async () => {
    const providerThreadId = await startThread("t1", "thr_1");
    await runTurn("t2", "thr_1", providerThreadId, [
      { type: "agent_start" },
      {
        type: "agent_end",
        messages: [
          {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: "model overloaded",
          },
        ],
      },
    ]);
    const threadDeltas = deltas("thr_1");
    expect(threadDeltas.find((delta) => delta.kind === "provider.error")).toMatchObject({
      detail: "model overloaded",
      settlesTurn: true,
    });
    expect(threadDeltas.at(-1)).toMatchObject({ kind: "turn.boundary", status: "failed" });
  });

  it("answers a turn for a thread the bridge does not know with invalid params", async () => {
    sendRequest("t9", "turn/start", {
      threadId: "thr_missing",
      providerThreadId: "prime_x",
      input: [{ type: "text", text: "hello", mentions: [] }],
      clientRequestId: CLIENT_REQUEST_ID,
      options: FULL_OPTIONS,
    });
    expect(response("t9").error?.code).toBe(BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS);
  });
});

describe("the snapshot and live event boundary", () => {
  it("drops pushes at or before the attach cursor and streams what follows", async () => {
    daemon.enqueueCreate();
    daemon.enqueueAttach({
      lastEventSequence: 5,
      lastEventCursor: { generation: "gen-0", sequence: 5 },
    });
    sendRequest("t1", "thread/start", {
      threadId: "thr_1",
      cwd,
      instructionMode: "append",
      options: FULL_OPTIONS,
    });
    await waitForResponse("t1");
    collected = [];

    // History the snapshot already counted: dropped, even out of order.
    daemon.push({
      type: "session_event",
      activeSessionId: "sess_1",
      event: { type: "agent_start" },
      meta: { sequence: 3, cursor: { generation: "gen-0", sequence: 3 } },
    });
    daemon.push({
      type: "session_event",
      activeSessionId: "sess_1",
      event: { type: "agent_start" },
      meta: { sequence: 5, cursor: { generation: "gen-0", sequence: 5 } },
    });
    expect(deltas("thr_1")).toEqual([]);

    // Strictly after the boundary: live.
    daemon.push({
      type: "session_event",
      activeSessionId: "sess_1",
      event: { type: "agent_start" },
      meta: { sequence: 6, cursor: { generation: "gen-0", sequence: 6 } },
    });
    expect(deltas("thr_1").map((delta) => delta.kind)).toEqual(["turn.open"]);
  });

  it("streams only the session it holds, ignoring every other session's events", async () => {
    daemon.enqueueCreate();
    daemon.enqueueAttach({
      lastEventSequence: 5,
      lastEventCursor: { generation: "gen-0", sequence: 5 },
    });
    sendRequest("t1", "thread/start", {
      threadId: "thr_1",
      cwd,
      instructionMode: "append",
      options: FULL_OPTIONS,
    });
    await waitForResponse("t1");
    collected = [];

    // Another bb thread's session (or a pre-attach push) on the shared socket.
    daemon.push({
      type: "session_event",
      activeSessionId: "sess_other",
      event: { type: "agent_start" },
      meta: { sequence: 6, cursor: { generation: "gen-0", sequence: 6 } },
    });
    expect(deltas("thr_1")).toEqual([]);

    daemon.push({
      type: "session_event",
      activeSessionId: "sess_1",
      event: { type: "agent_start" },
      meta: { sequence: 7, cursor: { generation: "gen-0", sequence: 7 } },
    });
    expect(deltas("thr_1").map((delta) => delta.kind)).toEqual(["turn.open"]);
  });

  it("fills the timeline from the snapshot when adopting a session from another bridge process", async () => {
    daemon.enqueueAttach({
      messages: [
        { role: "user", content: "what changed?" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "let me look" },
            { type: "text", text: "the login flow" },
          ],
          stopReason: "stop",
        },
      ],
    });
    sendRequest("t1", "thread/resume", {
      threadId: "thr_adopted",
      providerThreadId: "prime_sess_1",
      cwd,
      instructionMode: "append",
      options: FULL_OPTIONS,
    });
    const reply = await waitForResponse("t1");
    expect(reply.result).toMatchObject({ providerThreadId: "prime_sess_1" });

    const threadDeltas = deltas("thr_adopted");
    expect(threadDeltas.map((delta) => delta.kind)).toEqual([
      "session.reset",
      "input.provider",
      "item.open",
      "item.open",
    ]);
    expect(threadDeltas[1]).toMatchObject({
      kind: "input.provider",
      text: "what changed?",
    });
    expect(threadDeltas[2]).toMatchObject({
      item: { type: "reasoning", content: ["let me look"] },
    });
    expect(threadDeltas[3]).toMatchObject({
      item: { type: "agentMessage", text: "the login flow" },
    });
  });

  it("a reopened thread shows the work that continued in the daemon after bb closed", async () => {
    // bb starts the thread, then closes before prompting it: the bridge process
    // goes away with an empty timeline for the thread.
    const providerThreadId = await startThread("t1", "thr_1");
    resetDaemonForTests();
    sessionTableForTests().clear();

    // While bb is gone the resident session keeps working for an out-of-band
    // client: two full exchanges land in the transcript, including bb's own
    // first prompt, which bb itself never saw answered.
    daemon.enqueueAttach({
      messages: [
        { role: "user", content: "summarise the tree" },
        {
          role: "assistant",
          content: [{ type: "text", text: "the oak is tallest" }],
          stopReason: "stop",
        },
        { role: "user", content: "now count the birds" },
        {
          role: "assistant",
          content: [{ type: "text", text: "three birds" }],
          stopReason: "stop",
        },
      ],
      lastEventSequence: 12,
      lastEventCursor: { generation: "gen-0", sequence: 12 },
    });
    // Reopening: a NEW bridge process (empty table) attaches to the same
    // resident session by its daemon-derived provider thread id.
    sendRequest("t2", "thread/resume", {
      threadId: "thr_1",
      providerThreadId,
      cwd,
      instructionMode: "append",
      options: FULL_OPTIONS,
    });
    expect(await waitForResponse("t2")).toMatchObject({
      result: { providerThreadId, sessionRestorable: true },
    });
    expect(notifications("thread/identity").at(-1)?.params).toMatchObject({
      threadId: "thr_1",
      providerThreadId,
    });

    // The whole history — including the out-of-band exchange — comes from the
    // snapshot, in order, exactly once. (The first `session.reset` is the
    // original process's construction, the second the reopen's boundary.)
    const threadDeltas = deltas("thr_1");
    expect(threadDeltas.map((delta) => delta.kind)).toEqual([
      "session.reset",
      "session.reset",
      "input.provider",
      "item.open",
      "input.provider",
      "item.open",
    ]);
    expect(threadDeltas[4]).toMatchObject({
      kind: "input.provider",
      text: "now count the birds",
    });
    expect(threadDeltas[5]).toMatchObject({
      item: { type: "agentMessage", text: "three birds" },
    });

    // The snapshot is the boundary: what the daemon already counted stays
    // history, and what comes next streams into the reopened thread.
    collected = [];
    daemon.push({
      type: "session_event",
      activeSessionId: "sess_1",
      event: { type: "agent_start" },
      meta: { sequence: 12, cursor: { generation: "gen-0", sequence: 12 } },
    });
    expect(deltas("thr_1")).toEqual([]);
    daemon.enqueuePrompt({ events: textTurnEvents({ text: "three" }) });
    sendRequest("t3", "turn/start", {
      threadId: "thr_1",
      providerThreadId,
      input: [{ type: "text", text: "and again", mentions: [] }],
      clientRequestId: CLIENT_REQUEST_ID,
      options: FULL_OPTIONS,
    });
    await waitForResponse("t3");
    const afterReopen = deltas("thr_1").map((delta) => delta.kind);
    expect(afterReopen).toEqual([
      "input.accepted",
      "turn.open",
      "item.textDelta",
      "item.textClose",
      "usage",
      "turn.boundary",
    ]);
    expect(deltas("thr_1").find((delta) => delta.kind === "item.textClose")).toMatchObject({
      text: "three",
    });
  });

  it("does not replay snapshot content for a session this process already knows", async () => {
    const providerThreadId = await startThread("t1", "thr_1");
    daemon.enqueueAttach({
      messages: [{ role: "user", content: "already persisted by bb" }],
    });
    sendRequest("t2", "thread/resume", {
      threadId: "thr_1",
      providerThreadId,
      cwd,
      instructionMode: "append",
      options: FULL_OPTIONS,
    });
    await waitForResponse("t2");
    const kinds = deltas("thr_1").map((delta) => delta.kind);
    expect(kinds).not.toContain("input.provider");
  });

  it("refuses to resume a provider thread another provider minted", async () => {
    sendRequest("t1", "thread/resume", {
      threadId: "thr_1",
      providerThreadId: "provider_x_session",
      cwd,
      instructionMode: "append",
      options: FULL_OPTIONS,
    });
    const reply = await waitForResponse("t1");
    expect(reply.error?.code).toBe(BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR);
    expect(reply.error?.message).toContain("not a prime-agent session id");
    expect(sessionTableForTests().byThread("thr_1")).toBeUndefined();
  });

  it("reports a daemon that no longer holds the session legibly", async () => {
    daemon.enqueueFail("attach", "no resident session sess_evicted");
    sendRequest("t1", "thread/resume", {
      threadId: "thr_1",
      providerThreadId: "prime_sess_evicted",
      cwd,
      instructionMode: "append",
      options: FULL_OPTIONS,
    });
    const reply = await waitForResponse("t1");
    expect(reply.error?.code).toBe(BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR);
    expect(reply.error?.message).toContain('refused "attach"');
  });
});

describe("stop, release and discard", () => {
  it("interrupt soft-stops the turn, settles it, and keeps the session", async () => {
    const providerThreadId = await startThread("t1", "thr_1");
    daemon.enqueuePrompt({ events: [{ type: "agent_start" }] });
    sendRequest("t2", "turn/start", {
      threadId: "thr_1",
      providerThreadId,
      input: [{ type: "text", text: "count to 40", mentions: [] }],
      clientRequestId: CLIENT_REQUEST_ID,
      options: FULL_OPTIONS,
    });
    await waitForResponse("t2");
    collected = [];

    daemon.enqueueOk("abort");
    sendRequest("t3", "thread/stop", {
      threadId: "thr_1",
      providerThreadId,
      intent: "interrupt",
      activeTurnId: "turn-1",
    });
    await waitForResponse("t3");

    expect(daemon.commands.map((command) => command.type)).toContain("abort");
    // The bridge settled the turn itself: interrupted, streams closed.
    expect(deltas("thr_1").at(-1)).toMatchObject({
      kind: "turn.boundary",
      status: "interrupted",
    });
    // The resident session survives the soft stop.
    expect(daemon.commands).not.toContainEqual(expect.objectContaining({ type: "kill" }));
    expect(sessionTableForTests().byThread("thr_1")).toBeDefined();
  });

  it("ignores prime's own boundary after a local interrupt (no double settle)", async () => {
    const providerThreadId = await startThread("t1", "thr_1");
    daemon.enqueuePrompt({ events: [{ type: "agent_start" }] });
    sendRequest("t2", "turn/start", {
      threadId: "thr_1",
      providerThreadId,
      input: [{ type: "text", text: "count to 40", mentions: [] }],
      clientRequestId: CLIENT_REQUEST_ID,
      options: FULL_OPTIONS,
    });
    await waitForResponse("t2");
    daemon.enqueueOk("abort");
    sendRequest("t3", "thread/stop", {
      threadId: "thr_1",
      providerThreadId,
      intent: "interrupt",
      activeTurnId: "turn-1",
    });
    await waitForResponse("t3");
    expect(deltas("thr_1").filter((delta) => delta.kind === "turn.boundary")).toEqual([
      { kind: "turn.boundary", status: "interrupted" },
    ]);

    // Prime's own agent_end for the aborted turn arrives afterwards: item
    // closes still land, the boundary must not.
    daemon.push({
      type: "session_event",
      activeSessionId: "sess_1",
      event: {
        type: "agent_end",
        messages: [{ role: "assistant", content: [], stopReason: "aborted" }],
      },
      meta: { sequence: 50, cursor: { generation: "gen-0", sequence: 50 } },
    });
    expect(deltas("thr_1").filter((delta) => delta.kind === "turn.boundary")).toEqual([
      { kind: "turn.boundary", status: "interrupted" },
    ]);
  });

  it("release detaches an idle session without fabricating an interruption", async () => {
    const providerThreadId = await startThread("t1", "thr_1");
    daemon.enqueueOk("detach");
    sendRequest("t2", "thread/stop", {
      threadId: "thr_1",
      providerThreadId,
      intent: "release",
      activeTurnId: null,
    });
    const reply = await waitForResponse("t2");
    expect(reply.result).toEqual({ ok: true });
    // Nothing was running, so there is no turn to abort — only the queue read
    // at attach and the detach.
    expect(daemon.commands.map((command) => command.type)).toEqual([
      "create",
      "attach",
      "get_queue",
      "detach",
    ]);
    expect(deltas("thr_1").map((delta) => delta.kind)).not.toContain("turn.boundary");
    expect(sessionTableForTests().byThread("thr_1")).toBeUndefined();
  });

  it("release during a running turn soft-stops it and keeps the resident session", async () => {
    const providerThreadId = await startThread("t1", "thr_1");
    daemon.enqueuePrompt({ events: [{ type: "agent_start" }] });
    sendRequest("t2", "turn/start", {
      threadId: "thr_1",
      providerThreadId,
      input: [{ type: "text", text: "count to 40", mentions: [] }],
      clientRequestId: CLIENT_REQUEST_ID,
      options: FULL_OPTIONS,
    });
    await waitForResponse("t2");

    daemon.enqueueOk("abort");
    daemon.enqueueOk("detach");
    sendRequest("t3", "thread/stop", {
      threadId: "thr_1",
      providerThreadId,
      intent: "release",
      activeTurnId: null,
    });
    const reply = await waitForResponse("t3");
    expect(reply.result).toEqual({ ok: true });
    // Release is the soft path end to end: the open turn is aborted so prime
    // stops streaming, and neither the daemon state nor the session file is
    // touched — discard is the only path that removes them.
    expect(daemon.commands.map((command) => command.type)).toEqual([
      "create",
      "attach",
      "prompt",
      "abort",
      "detach",
    ]);
    expect(daemon.commands).not.toContainEqual(expect.objectContaining({ type: "kill" }));
    expect(daemon.commands).not.toContainEqual(
      expect.objectContaining({ type: "delete_saved_session" }),
    );
    expect(sessionTableForTests().byThread("thr_1")).toBeUndefined();
  });

  it("discard removes the session for good: abort, kill, then the record's own sessionFile", async () => {
    const providerThreadId = await startThread("t1", "thr_1");
    daemon.enqueueOk("detach");
    daemon.enqueueOk("kill");
    daemon.enqueueOk("delete_saved_session");
    sendRequest("t2", "thread/discard", {
      threadId: "thr_1",
      providerThreadId,
    });
    const reply = await waitForResponse("t2");
    expect(reply.result).toEqual({ ok: true });
    // The session this thread's record names — and nothing else — is addressed.
    expect(daemon.commands.map((command) => command.type)).toEqual([
      "create",
      "attach",
      "detach",
      "kill",
      "delete_saved_session",
    ]);
    expect(daemon.commands.find((command) => command.type === "kill")).toMatchObject({
      activeSessionId: "sess_1",
    });
    expect(
      daemon.commands.find((command) => command.type === "delete_saved_session"),
    ).toMatchObject({ sessionPath: "/tmp/prime/sessions/sess_1.jsonl" });
    expect(sessionTableForTests().byThread("thr_1")).toBeUndefined();
  });

  it("discard soft-stops an open turn before removing the session", async () => {
    const providerThreadId = await startThread("t1", "thr_1");
    daemon.enqueuePrompt({ events: [{ type: "agent_start" }] });
    sendRequest("t2", "turn/start", {
      threadId: "thr_1",
      providerThreadId,
      input: [{ type: "text", text: "count to 40", mentions: [] }],
      clientRequestId: CLIENT_REQUEST_ID,
      options: FULL_OPTIONS,
    });
    await waitForResponse("t2");

    daemon.enqueueOk("abort");
    daemon.enqueueOk("detach");
    daemon.enqueueOk("kill");
    daemon.enqueueOk("delete_saved_session");
    sendRequest("t3", "thread/discard", {
      threadId: "thr_1",
      providerThreadId,
    });
    const reply = await waitForResponse("t3");
    expect(reply.result).toEqual({ ok: true });
    const types = daemon.commands.map((command) => command.type);
    // Soft stop (abort) first: prime stops streaming and the transcript is
    // closed on disk before the daemon state and the file are removed.
    expect(types.indexOf("abort")).toBeGreaterThan(-1);
    expect(types.indexOf("abort")).toBeLessThan(types.indexOf("kill"));
    expect(types.indexOf("kill")).toBeLessThan(types.indexOf("delete_saved_session"));
  });

  it("discard skips the kill when the daemon already closed the session", async () => {
    const providerThreadId = await startThread("t1", "thr_1");
    daemon.push({
      type: "session_closed",
      activeSessionId: "sess_1",
      reason: "killed",
    });
    daemon.enqueueOk("delete_saved_session");
    sendRequest("t2", "thread/discard", {
      threadId: "thr_1",
      providerThreadId,
    });
    const reply = await waitForResponse("t2");
    expect(reply.result).toEqual({ ok: true });
    // Nothing live to stop or kill: the transcript file is all that is left.
    expect(daemon.commands.map((command) => command.type)).toEqual([
      "create",
      "attach",
      "detach",
      "delete_saved_session",
    ]);
    expect(sessionTableForTests().byThread("thr_1")).toBeUndefined();
  });

  it("discard of a session whose create never answered cleans up nothing on the daemon", async () => {
    sendRequest("t1", "thread/start", {
      threadId: "thr_1",
      cwd,
      instructionMode: "append",
      options: FULL_OPTIONS,
    });
    // No `create` block: the construction fails and drops the record.
    await waitForResponse("t1");
    expect(sessionTableForTests().byThread("thr_1")).toBeUndefined();
    // A late discard for the same thread finds no daemon identity to address.
    sendRequest("t2", "thread/discard", {
      threadId: "thr_1",
      providerThreadId: "prime_sess_1",
    });
    const reply = await waitForResponse("t2");
    expect(reply.result).toEqual({ ok: true });
    // The only daemon traffic is the failed create from the start above.
    expect(daemon.commands.map((command) => command.type)).toEqual(["create"]);
  });

  it("a failed discard surfaces a legible error and keeps the record so a retry converges", async () => {
    const providerThreadId = await startThread("t1", "thr_1");
    daemon.enqueueOk("detach");
    daemon.enqueueOk("kill");
    daemon.enqueueFail("delete_saved_session", "Cannot delete the currently active session");
    sendRequest("t2", "thread/discard", {
      threadId: "thr_1",
      providerThreadId,
    });
    const reply = await waitForResponse("t2");
    expect(reply.error?.code).toBe(BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR);
    expect(reply.error?.message).toContain("could not discard the prime-agent session");
    expect(reply.error?.message).toContain("delete_saved_session failed:");
    // bb still owns the thread: the record stays so a retry can finish.
    expect(sessionTableForTests().byThread("thr_1")).toBeDefined();

    // The retry: the daemon state is already closed, so the kill is not
    // repeated — only the remaining file removal runs, and the discard lands.
    daemon.enqueueOk("delete_saved_session");
    sendRequest("t3", "thread/discard", {
      threadId: "thr_1",
      providerThreadId,
    });
    expect((await waitForResponse("t3")).result).toEqual({ ok: true });
    expect(daemon.commands.filter((command) => command.type === "kill")).toHaveLength(1);
    expect(
      daemon.commands.filter((command) => command.type === "delete_saved_session"),
    ).toHaveLength(2);
    expect(sessionTableForTests().byThread("thr_1")).toBeUndefined();
  });

  it("discard of a thread the bridge holds no record for answers ok without touching the daemon", async () => {
    sendRequest("t1", "thread/discard", {
      threadId: "thr_unknown",
      providerThreadId: "prime_sess_other",
    });
    const reply = await waitForResponse("t1");
    expect(reply.result).toEqual({ ok: true });
    // Only the session identity recorded on this bridge's own records is ever
    // addressed — an unknown provider thread id names nothing to clean.
    expect(daemon.commands).toEqual([]);
  });
});

describe("session bookkeeping", () => {
  it("keeps a thread's provider identity stable across resumes", async () => {
    const first = await startThread("a", "thr_a");
    daemon.enqueueAttach();
    sendRequest("c", "thread/resume", {
      threadId: "thr_a",
      providerThreadId: first,
      cwd,
      instructionMode: "append",
      options: FULL_OPTIONS,
    });
    expect((await waitForResponse("c")).result).toEqual({
      providerThreadId: first,
      sessionRestorable: true,
    });
  });

  it("declares and stores the skills/configure catalog", () => {
    sendRequest("k", "skills/configure", {
      roots: [
        {
          id: "workspace",
          path: "/tmp/skills",
          skills: [{ name: "review", description: "Review" }],
        },
      ],
    });
    expect(response("k").result).toEqual({ ok: true });
    expect(currentConfiguredSkillRoots()).toEqual([
      {
        id: "workspace",
        path: "/tmp/skills",
        skills: [{ name: "review", description: "Review" }],
      },
    ]);
  });
});

describe("methods that need work the later tickets own", () => {
  it("answers with a legible not-yet error, never silence", async () => {
    const notYet: Array<[string, unknown]> = [
      ["model/list", {}],
      ["provider/installation/status", { providerId: "prime-agent" }],
      ["provider/installation/run", { providerId: "prime-agent", action: "install" }],
      [
        "thread/fork",
        {
          threadId: "t",
          sourceProviderThreadId: "p",
          cwd,
          instructionMode: "append",
          options: FULL_OPTIONS,
        },
      ],
      ["thread/name/set", { threadId: "t", providerThreadId: "p", title: "x" }],
      ["thread/archive", { threadId: "t", providerThreadId: "p" }],
      ["thread/unarchive", { threadId: "t", providerThreadId: "p" }],
      ["thread/goal/clear", { threadId: "t", providerThreadId: "p" }],
    ];
    notYet.forEach(([method, params], index) => {
      sendRequest(`ny-${index}`, method, params);
    });
    // Handlers throw, so `runBridgeRequest` answers on a later tick.
    const replies = await Promise.all(
      notYet.map(([method, params], index) => waitForResponse(`ny-${index}`)),
    );
    expect(replies).toHaveLength(notYet.length);
    for (const reply of replies) {
      expect(reply.error?.code).toBe(BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR);
      expect(reply.error?.message).toMatch(
        /not wired yet|not offered|keeps no thread archive/,
      );
    }
  });

  it("reports usage as unsupported (the declaration does not offer it)", () => {
    sendRequest("u", "provider/usage", { providerId: "prime-agent" });
    expect(response("u").result).toEqual({ supported: false });
  });

  it("keeps provider/health talking to the daemon probe", async () => {
    sendRequest("h", "provider/health", { providerId: "prime-agent" });
    const reply = await waitForResponse("h");
    // Whatever the machine's prime state is, the answer is a health result.
    expect(reply.result).toMatchObject({
      supported: true,
      health: {
        status: expect.stringMatching(
          /^(?:ready|not_installed|unknown|unsupported_version)$/,
        ),
        minimumSupportedVersion: expect.any(String),
        canInstall: false,
      },
    });
  });
});

describe("process teardown (closing bb)", () => {
  /**
   * The sessions are daemon-resident on purpose: the daemon outlives this
   * bridge process, so closing bb must let go of the sessions — never remove
   * them. A released thread comes back through `thread/resume`.
   */
  it("closing bb releases the sessions and keeps them resident: no kill on close", async () => {
    await startThread("t1", "thr_1");
    daemon.enqueueOk("detach");
    experimental_providerBridge.onClose?.();
    await flushedTeardown();
    expect(daemon.commands.map((command) => command.type)).toEqual([
      "create",
      "attach",
      "detach",
    ]);
    expect(daemon.commands).not.toContainEqual(expect.objectContaining({ type: "kill" }));
    expect(daemon.commands).not.toContainEqual(
      expect.objectContaining({ type: "delete_saved_session" }),
    );
    expect(sessionTableForTests().all()).toEqual([]);
  });

  it("closing bb mid-turn soft-stops the turn and still keeps the session", async () => {
    const providerThreadId = await startThread("t1", "thr_1");
    daemon.enqueuePrompt({ events: [{ type: "agent_start" }] });
    sendRequest("t2", "turn/start", {
      threadId: "thr_1",
      providerThreadId,
      input: [{ type: "text", text: "count to 40", mentions: [] }],
      clientRequestId: CLIENT_REQUEST_ID,
      options: FULL_OPTIONS,
    });
    await waitForResponse("t2");

    daemon.enqueueOk("abort");
    daemon.enqueueOk("detach");
    experimental_providerBridge.onClose?.();
    await flushedTeardown();
    // Even a running turn only gets the soft stop: the daemon session and its
    // file survive the close, and the turn can continue for another client.
    expect(daemon.commands.map((command) => command.type)).toEqual([
      "create",
      "attach",
      "prompt",
      "abort",
      "detach",
    ]);
    expect(daemon.commands).not.toContainEqual(expect.objectContaining({ type: "kill" }));
    expect(daemon.commands).not.toContainEqual(
      expect.objectContaining({ type: "delete_saved_session" }),
    );
  });
});

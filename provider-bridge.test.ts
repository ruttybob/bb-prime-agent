import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  experimental_captureBridgeJsonRpcOutput as captureBridgeJsonRpcOutput,
  type CapturedBridgeJsonRpcOutput,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import { BRIDGE_JSON_RPC_ERRORS } from "@get-bb/plugin-sdk/provider-bridge";
import {
  currentConfiguredSkillRoots,
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

  it("discard drops the record; the daemon session file is left for bbpa-ggf.4", async () => {
    const providerThreadId = await startThread("t1", "thr_1");
    daemon.enqueueOk("abort");
    daemon.enqueueOk("detach");
    sendRequest("t2", "thread/discard", {
      threadId: "thr_1",
      providerThreadId,
    });
    const reply = await waitForResponse("t2");
    expect(reply.result).toEqual({ ok: true });
    expect(daemon.commands).not.toContainEqual(expect.objectContaining({ type: "kill" }));
    expect(daemon.commands).not.toContainEqual(
      expect.objectContaining({ type: "delete_saved_session" }),
    );
    expect(sessionTableForTests().byThread("thr_1")).toBeUndefined();
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

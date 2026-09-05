import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  experimental_assembleCapturedThreadEvents as assembleCapturedThreadEvents,
  experimental_captureBridgeJsonRpcOutput as captureBridgeJsonRpcOutput,
  type CapturedBridgeJsonRpcOutput,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import { handleLine, resetDaemonForTests, sessionTableForTests } from "./src/provider-bridge.js";
import { setPrimeDaemonTransportFactoryForTests } from "./src/daemon/connection.js";
import {
  createScriptedDaemon,
  textTurnEvents,
  type ScriptedDaemonHandle,
} from "./test-support/scripted-daemon.js";

/**
 * The streamed feed, assembled by the runtime's real assembler.
 *
 * The bridge tests assert the deltas this bridge emits; this one asserts what
 * those deltas *become* on a bb timeline — turn/item id minting and uniqueness,
 * item lifecycle (opened before streamed, closed once), usage accumulation, and
 * the interrupt settlement — over a scripted prime event feed, in-process.
 */

let output: CapturedBridgeJsonRpcOutput;
let daemon: ScriptedDaemonHandle;
const collected: unknown[] = [];
const cwd = "/tmp/prime-workspace";

beforeEach(() => {
  output = captureBridgeJsonRpcOutput();
  collected.length = 0;
  daemon = createScriptedDaemon({
    session: {
      activeSessionId: "sess_stream",
      sessionFile: "/tmp/prime/sessions/sess_stream.jsonl",
      sessionName: "[bb] stream",
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

function sendRequest(id: string, method: string, params: unknown): void {
  handleLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
}

function drain(): unknown[] {
  collected.push(...output.takeMessages());
  return collected;
}

function assembled(threadId: string): ReturnType<typeof assembleCapturedThreadEvents> {
  return assembleCapturedThreadEvents(
    drain().filter(
      (message): message is { method: string; params: Record<string, unknown> } =>
        typeof message === "object" &&
        message !== null &&
        (message as { method?: unknown }).method === "thread/delta" &&
        (message as { params?: Record<string, unknown> }).params?.threadId === threadId,
    ),
    "prime-agent",
  );
}

async function waitFor(
  label: string,
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const FULL_OPTIONS = {
  permissionMode: "full",
  permissionScope: "full",
  approvalReviewer: null,
  permissionEscalation: null,
};

describe("a scripted prime feed, assembled", () => {
  it("builds a timeline: streamed answer, reasoning, usage, completed turn", async () => {
    daemon.enqueueCreate();
    daemon.enqueueAttach();
    daemon.enqueuePrompt({
      events: [
        { type: "agent_start" },
        {
          type: "message_update",
          assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "let me " },
        },
        {
          type: "message_update",
          assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "think" },
        },
        {
          type: "message_update",
          assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "let me think" },
        },
        {
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "he" },
        },
        {
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "llo" },
        },
        {
          type: "message_update",
          assistantMessageEvent: { type: "text_end", contentIndex: 1, content: "hello" },
        },
        {
          type: "agent_end",
          messages: [
            {
              role: "assistant",
              content: [
                { type: "thinking", thinking: "let me think" },
                { type: "text", text: "hello" },
              ],
              stopReason: "stop",
              usage: { input: 20, output: 4, cacheRead: 2, cacheWrite: 0, totalTokens: 26 },
            },
          ],
        },
      ],
    });
    sendRequest("a", "thread/start", {
      threadId: "thr_stream",
      cwd,
      instructionMode: "append",
      options: FULL_OPTIONS,
      input: [{ type: "text", text: "say hello", mentions: [] }],
    });
    await waitFor("the turn to settle", () =>
      assembled("thr_stream").some((event) => event.type === "turn/completed"),
    );

    const events = assembled("thr_stream");
    const types = events.map((event) => event.type);
    expect(types[0]).toBe("turn/started");
    // prime's thinking block becomes a reasoning item, the answer an agent message.
    expect(types).toContain("item/reasoning/textDelta");
    expect(types).toContain("item/agentMessage/delta");
    expect(types).toContain("thread/tokenUsage/updated");
    expect(types.at(-1)).toBe("turn/completed");

    const usage = events.find((event) => event.type === "thread/tokenUsage/updated");
    expect(usage).toMatchObject({
      tokenUsage: {
        total: {
          totalTokens: 26,
          inputTokens: 20,
          cachedInputTokens: 2,
          outputTokens: 4,
        },
        last: { totalTokens: 26 },
      },
    });

    const completed = events.find(
      (event) => event.type === "item/completed" && event.item.type === "agentMessage",
    );
    expect(completed).toMatchObject({ item: { type: "agentMessage", text: "hello" } });
    const reasoning = events.find(
      (event) => event.type === "item/completed" && event.item.type === "reasoning",
    );
    expect(reasoning).toMatchObject({
      item: { type: "reasoning", content: ["let me think"] },
    });
  });

  it("keeps prime's tool calls whole: command output, exit code, one close", async () => {
    daemon.enqueueCreate();
    daemon.enqueueAttach();
    daemon.enqueuePrompt({
      events: [
        { type: "agent_start" },
        {
          type: "tool_execution_start",
          toolCallId: "call_7",
          toolName: "bash",
          args: { command: "git status --short", cwd },
        },
        {
          type: "tool_execution_update",
          toolCallId: "call_7",
          toolName: "bash",
          partialResult: " M src/provider-bridge.ts",
        },
        {
          type: "tool_execution_end",
          toolCallId: "call_7",
          toolName: "bash",
          result: " M src/provider-bridge.ts",
          isError: false,
        },
        {
          type: "agent_end",
          messages: [{ role: "assistant", content: [], stopReason: "toolUse" }],
        },
      ],
    });
    sendRequest("a", "thread/start", {
      threadId: "thr_stream",
      cwd,
      instructionMode: "append",
      options: FULL_OPTIONS,
      input: [{ type: "text", text: "what changed?", mentions: [] }],
    });
    await waitFor("the turn to settle", () =>
      assembled("thr_stream").some((event) => event.type === "turn/completed"),
    );

    const events = assembled("thr_stream");
    const started = events.filter((event) => event.type === "item/started");
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({
      item: { type: "commandExecution", command: "git status --short", cwd },
    });
    expect(events.map((event) => event.type)).toContain(
      "item/commandExecution/outputDelta",
    );
    const completions = events.filter((event) => event.type === "item/completed");
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({
      item: {
        type: "commandExecution",
        aggregatedOutput: " M src/provider-bridge.ts",
        exitCode: 0,
        status: "completed",
      },
    });
  });

  it("mints unique turn and item ids across a resume and settles an interrupted turn", async () => {
    daemon.enqueueCreate();
    daemon.enqueueAttach();
    daemon.enqueuePrompt({ events: textTurnEvents({ text: "first", usage: { input: 5, output: 2, totalTokens: 7 } }) });
    sendRequest("a", "thread/start", {
      threadId: "thr_stream",
      cwd,
      instructionMode: "append",
      options: FULL_OPTIONS,
      input: [{ type: "text", text: "first prompt", mentions: [] }],
    });
    await waitFor("the first turn to settle", () =>
      assembled("thr_stream").filter((event) => event.type === "turn/completed").length >= 1,
    );

    daemon.enqueueAttach();
    sendRequest("b", "thread/resume", {
      threadId: "thr_stream",
      providerThreadId: "prime_sess_stream",
      cwd,
      instructionMode: "append",
      options: FULL_OPTIONS,
    });
    await waitFor("the resume response", () =>
      drain().some(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          (message as Record<string, unknown>).id === "b",
      ),
    );

    daemon.enqueuePrompt({
      events: [
        { type: "agent_start" },
        {
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "partial " },
        },
        // The soft stop settles the turn; prime's aborted agent_end follows.
        {
          type: "agent_end",
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "partial " }],
              stopReason: "aborted",
            },
          ],
        },
      ],
    });
    sendRequest("c", "turn/start", {
      threadId: "thr_stream",
      providerThreadId: "prime_sess_stream",
      input: [{ type: "text", text: "count to 40", mentions: [] }],
      clientRequestId: "creq_abcdefghij",
      options: FULL_OPTIONS,
    });
    await waitFor("the turn/start response", () =>
      drain().some(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          (message as Record<string, unknown>).id === "c",
      ),
    );
    daemon.enqueueOk("abort");
    sendRequest("d", "thread/stop", {
      threadId: "thr_stream",
      providerThreadId: "prime_sess_stream",
      intent: "interrupt",
      activeTurnId: "turn-2",
    });
    await waitFor("the interrupt to settle", () =>
      assembled("thr_stream").filter((event) => event.type === "turn/completed").length >= 2,
    );

    const events = assembled("thr_stream");
    // Ids never repeat, across the resume included.
    const turnIds = events
      .filter((event) => event.type === "turn/started")
      .map((event) => (event.scope.kind === "turn" ? event.scope.turnId : null))
      .filter((turnId): turnId is string => turnId !== null);
    expect(new Set(turnIds).size).toBe(turnIds.length);
    const itemIds = events
      .filter((event) => event.type === "item/started")
      .map((event) => event.item.id);
    expect(new Set(itemIds).size).toBe(itemIds.length);

    // Second turn: interrupted, and the streamed partial text survived.
    const second = events.filter((event) => event.type === "turn/completed").at(-1);
    expect(second).toMatchObject({ status: "interrupted" });
    const partial = events
      .filter((event) => event.type === "item/agentMessage/delta")
      .at(-1);
    expect(partial).toMatchObject({ delta: "partial " });

    // Usage accumulated across the resume: 7 (first turn) + 0 (aborted turn has no usage).
    const usage = events
      .filter((event) => event.type === "thread/tokenUsage/updated")
      .at(-1);
    expect(usage).toMatchObject({ tokenUsage: { total: { totalTokens: 7 } } });
  });
});

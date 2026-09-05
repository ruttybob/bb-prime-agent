import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  experimental_captureBridgeJsonRpcOutput as captureBridgeJsonRpcOutput,
  type CapturedBridgeJsonRpcOutput,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import { BRIDGE_JSON_RPC_ERRORS } from "@get-bb/plugin-sdk/provider-bridge";
import {
  handleLine,
  resetDaemonForTests,
  sessionTableForTests,
} from "./src/provider-bridge.js";
import { PRIME_QUEUE_EXTENSION_KIND } from "./src/queue-state.js";
import { setPrimeDaemonTransportFactoryForTests } from "./src/daemon/connection.js";
import {
  createScriptedDaemon,
  type ScriptedDaemonHandle,
} from "./test-support/scripted-daemon.js";

/**
 * The steering surface (bbpa-ggf.5): `turn/steer` onto prime's steering lane,
 * busy-lane prompts onto prime's follow-up lane, and the waiting-message
 * queue surfaced as the thread's queue state.
 */

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

function deltas(threadId: string): Array<Record<string, unknown>> {
  return notifications("thread/delta")
    .filter((message) => message.params.threadId === threadId)
    .flatMap((message) => message.params.deltas as Array<Record<string, unknown>>);
}

function notifications(method: string): Array<{ params: Record<string, unknown> }> {
  return messages().filter(
    (message): message is { method: string; params: Record<string, unknown> } =>
      typeof message === "object" &&
      message !== null &&
      (message as Record<string, unknown>).method === method,
  );
}

const FULL_OPTIONS = {
  permissionMode: "full",
  permissionScope: "full",
  approvalReviewer: null,
  permissionEscalation: null,
};

const CLIENT_REQUEST_ID = "creq_abcdefghij";

interface StartThreadArgs {
  id: string;
  threadId: string;
}

/** Start the thread with no first turn; tests open turns explicitly. */
async function startThread(args: StartThreadArgs): Promise<string> {
  daemon.enqueueCreate();
  daemon.enqueueAttach();
  sendRequest(args.id, "thread/start", {
    threadId: args.threadId,
    cwd,
    instructionMode: "append",
    options: FULL_OPTIONS,
  });
  const reply = await waitForResponse(args.id);
  expect(reply.error).toBeUndefined();
  return String(reply.result?.providerThreadId);
}

async function runTurn(args: {
  id: string;
  threadId: string;
  providerThreadId: string;
  events?: readonly unknown[];
  text?: string;
  clientRequestId?: string;
}): Promise<Response> {
  daemon.enqueuePrompt({ events: args.events ?? [] });
  sendRequest(args.id, "turn/start", {
    threadId: args.threadId,
    providerThreadId: args.providerThreadId,
    input: [{ type: "text", text: args.text ?? "count to 40", mentions: [] }],
    clientRequestId: args.clientRequestId ?? CLIENT_REQUEST_ID,
    options: FULL_OPTIONS,
  });
  return waitForResponse(args.id);
}

async function steer(args: {
  id: string;
  threadId: string;
  providerThreadId?: string;
  text?: string;
  clientRequestId?: string;
}): Promise<Response> {
  sendRequest(args.id, "turn/steer", {
    threadId: args.threadId,
    providerThreadId: args.providerThreadId ?? "prime_sess_1",
    expectedTurnId: "turn-1",
    input: [{ type: "text", text: args.text ?? "Also check the failing test", mentions: [] }],
    clientRequestId: args.clientRequestId ?? "creq_steerabcxy",
    options: FULL_OPTIONS,
  });
  return waitForResponse(args.id);
}

function pushEvent(event: unknown, sequence: number): void {
  daemon.push({
    type: "session_event",
    activeSessionId: "sess_1",
    event,
    meta: { sequence, cursor: { generation: "gen-0", sequence } },
  });
}

describe("turn/steer onto prime's steering lane", () => {
  it("delivers a mid-turn steer and shows it inside the still-open turn", async () => {
    const providerThreadId = await startThread({ id: "t1", threadId: "thr_1" });
    // A turn that opens and keeps streaming: the steer lands mid-flight.
    await runTurn({
      id: "t2",
      threadId: "thr_1",
      providerThreadId,
      events: [{ type: "agent_start" }],
    });
    collected = [];

    daemon.enqueueOk("prompt");
    const reply = await steer({ id: "t3", threadId: "thr_1", providerThreadId });
    expect(reply.error).toBeUndefined();
    expect(reply.result).toEqual({ threadId: "thr_1" });

    // The daemon got prime's mid-turn prompt carrying the steer semantic:
    // delivered after the current tool round, before the next model call
    // (spike, wire facts) — and queued, so the running turn keeps its seat.
    const prompts = daemon.commands.filter((command) => command.type === "prompt");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toMatchObject({
      activeSessionId: "sess_1",
      message: "Also check the failing test",
      streamingBehavior: "steer",
      queueIfBusy: true,
    });
    // Not the daemon's `steer` command: on the calibrated daemon it delivers
    // when the run settles, which is not a mid-turn delivery.
    expect(daemon.commands).not.toContainEqual(expect.objectContaining({ type: "steer" }));

    const threadDeltas = deltas("thr_1");
    // Correlated acceptance and the steered text as a provider input row.
    expect(threadDeltas).toContainEqual({
      kind: "input.accepted",
      clientRequestId: "creq_steerabcxy",
    });
    expect(threadDeltas).toContainEqual({
      kind: "input.provider",
      text: "Also check the failing test",
    });
    // A steer never settles or opens a turn of its own.
    expect(threadDeltas.filter((delta) => delta.kind === "turn.boundary")).toEqual([]);
    expect(threadDeltas.filter((delta) => delta.kind === "turn.open")).toEqual([]);
    expect(daemon.commands).not.toContainEqual(expect.objectContaining({ type: "abort" }));

    // The running turn settles exactly once, after the steer.
    pushEvent(
      {
        type: "agent_end",
        messages: [{ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" }],
      },
      100,
    );
    const threadDeltasAfter = deltas("thr_1");
    expect(
      threadDeltasAfter.filter((delta) => delta.kind === "turn.boundary"),
    ).toEqual([
      {
        kind: "turn.boundary",
        status: "completed",
        // The steer's own fork anchor rides the boundary that settles its run
        // (bbpa-ggf.7).
        providerCheckpointId: expect.any(String),
        claimIfIdle: true,
      },
    ]);
    const acceptedAt = threadDeltasAfter.findIndex(
      (delta) => delta.kind === "input.accepted" && delta.clientRequestId === "creq_steerabcxy",
    );
    const boundaryAt = threadDeltasAfter.findIndex((delta) => delta.kind === "turn.boundary");
    expect(acceptedAt).toBeGreaterThanOrEqual(0);
    expect(boundaryAt).toBeGreaterThan(acceptedAt);
  });

  it("steers an idle lane through prime's resumeIfIdle instead of refusing", async () => {
    const providerThreadId = await startThread({ id: "t1", threadId: "thr_1" });
    expect(sessionTableForTests().byThread("thr_1")?.session).toBeDefined();
    collected = [];

    daemon.enqueueOk("steer");
    const reply = await steer({ id: "t2", threadId: "thr_1", providerThreadId });
    expect(reply.error).toBeUndefined();
    // The message reaches prime even with no open turn: the daemon's steer
    // carries resumeIfIdle, so it starts a fresh run rather than vanishing.
    expect(daemon.commands).toContainEqual(
      expect.objectContaining({ type: "steer", activeSessionId: "sess_1" }),
    );
    expect(
      deltas("thr_1").filter((delta) => delta.kind === "input.accepted"),
    ).toEqual([{ kind: "input.accepted", clientRequestId: "creq_steerabcxy" }]);

    // Prime's resumed run opens the turn that owns the accepted steer and
    // settles it at agent_end — one turn, one boundary.
    pushEvent({ type: "agent_start" }, 100);
    pushEvent(
      {
        type: "agent_end",
        messages: [{ role: "assistant", content: [], stopReason: "stop" }],
      },
      101,
    );
    const kinds = deltas("thr_1").map((delta) => delta.kind);
    expect(kinds.indexOf("input.accepted")).toBeLessThan(kinds.indexOf("turn.open"));
    expect(kinds.filter((kind) => kind === "turn.open")).toHaveLength(1);
    expect(kinds.filter((kind) => kind === "turn.boundary")).toHaveLength(1);
  });

  it("reports a daemon-side steer refusal as a bridge error", async () => {
    const providerThreadId = await startThread({ id: "t1", threadId: "thr_1" });
    daemon.enqueueFail("steer", "extension commands cannot be steered");
    const reply = await steer({ id: "t2", threadId: "thr_1", providerThreadId });
    expect(reply.error?.code).toBe(BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR);
    expect(reply.error?.message).toContain('refused "steer"');
    expect(reply.error?.message).toContain("extension commands cannot be steered");
    // A refused steer accepted nothing.
    expect(
      deltas("thr_1").filter((delta) => delta.kind === "input.accepted"),
    ).toEqual([]);
  });
});

describe("busy lanes and follow-up", () => {
  it("queues a prompt that lands on a busy lane instead of interrupting", async () => {
    const providerThreadId = await startThread({ id: "t1", threadId: "thr_1" });
    await runTurn({
      id: "t2",
      threadId: "thr_1",
      providerThreadId,
      events: [{ type: "agent_start" }],
    });
    const firstPrompt = daemon.commands.find((command) => command.type === "prompt");

    // A second turn while prime is still running the first: queued on the
    // follow-up lane (delivered only after the agent finishes), never aborting.
    collected = [];
    const reply = await runTurn({
      id: "t3",
      threadId: "thr_1",
      providerThreadId,
      text: "then update the docs",
      clientRequestId: "creq_turn2abcde",
    });
    expect(reply.error).toBeUndefined();
    const promptCommands = daemon.commands.filter((command) => command.type === "prompt");
    expect(promptCommands).toHaveLength(2);
    for (const prompt of promptCommands) {
      expect(prompt).toMatchObject({ streamingBehavior: "followUp" });
    }
    expect(firstPrompt).toBeDefined();
    expect(daemon.commands).not.toContainEqual(expect.objectContaining({ type: "abort" }));
    // The busy lane settles only when prime's run ends.
    expect(deltas("thr_1").filter((delta) => delta.kind === "turn.boundary")).toEqual([]);
  });
});

describe("queue state surfacing", () => {
  it("surfaces prime's waiting lanes as queue state while messages wait", async () => {
    await startThread({ id: "t1", threadId: "thr_1" });
    collected = [];

    pushEvent(
      {
        type: "session_action_update",
        actions: {
          queuedCount: 2,
          steering: ["Also check the failing test"],
          followUps: ["Then update the docs"],
        },
      },
      10,
    );
    expect(deltas("thr_1")).toContainEqual({
      kind: "extension.state",
      extensionKind: PRIME_QUEUE_EXTENSION_KIND,
      payload: {
        steering: ["Also check the failing test"],
        followUps: ["Then update the docs"],
      },
    });

    // Drained lanes clear the state…
    pushEvent({ type: "session_action_update", actions: { queuedCount: 0, steering: [], followUps: [] } }, 11);
    expect(deltas("thr_1")).toContainEqual({
      kind: "extension.state",
      extensionKind: PRIME_QUEUE_EXTENSION_KIND,
      payload: null,
    });

    // …and an unchanged queue re-emits nothing.
    collected = [];
    pushEvent({ type: "session_action_update", actions: { queuedCount: 0, steering: [], followUps: [] } }, 12);
    expect(deltas("thr_1")).toEqual([]);
  });

  it("surfaces a queue that is already waiting when a session is adopted", async () => {
    daemon.enqueueAttach({
      messages: [{ role: "user", content: "queued elsewhere" }],
    });
    daemon.enqueue({
      commandType: "get_queue",
      // prime's get_queue spells the lane `followUp`; the push spells it
      // `followUps` — both map onto the same queue state.
      data: { steering: ["queued in prime's TUI"], followUp: ["and a follow-up"] },
    });
    sendRequest("t1", "thread/resume", {
      threadId: "thr_adopted",
      providerThreadId: "prime_sess_1",
      cwd,
      instructionMode: "append",
      options: FULL_OPTIONS,
    });
    const reply = await waitForResponse("t1");
    expect(reply.error).toBeUndefined();
    expect(deltas("thr_adopted")).toContainEqual({
      kind: "extension.state",
      extensionKind: PRIME_QUEUE_EXTENSION_KIND,
      payload: {
        steering: ["queued in prime's TUI"],
        followUps: ["and a follow-up"],
      },
    });
  });

  it("declares the queue extension kind so bb accepts the payloads", async () => {
    const { primeProviderDeclaration } = await import("./src/declaration.js");
    const declaration = primeProviderDeclaration();
    expect(declaration.extensionKinds?.queue).toBeDefined();
    // The state schema accepts exactly what the bridge emits — the waiting
    // lanes and the cleared null.
    expect(declaration.extensionKinds?.queue?.state).toBeDefined();
  });
});

describe("steer reply hygiene", () => {
  it("answers an invalid steer with invalid params carrying the issues", async () => {
    sendRequest("t1", "turn/steer", {
      threadId: "thr_1",
      providerThreadId: "prime_sess_1",
      expectedTurnId: "turn-1",
      input: [{ type: "text", text: "no client request id", mentions: [] }],
      options: FULL_OPTIONS,
    });
    const reply = await waitForResponse("t1");
    expect(reply.error?.code).toBe(BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS);
    expect(reply.error?.data).toBeDefined();
  });

  it("answers a steer for an unknown thread with invalid params", async () => {
    const reply = await steer({ id: "t1", threadId: "thr_missing" });
    expect(reply.error?.code).toBe(BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS);
    expect(reply.error?.message).toContain("No session for thread thr_missing");
  });

  it("answers an empty-text steer with invalid params", async () => {
    await startThread({ id: "t1", threadId: "thr_1" });
    const reply = await steer({
      id: "t2",
      threadId: "thr_1",
      text: "   ",
    });
    expect(reply.error?.code).toBe(BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS);
    expect(reply.error?.message).toContain("Missing input text");
    expect(daemon.commands).not.toContainEqual(expect.objectContaining({ type: "steer" }));
  });
});

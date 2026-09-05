import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  experimental_captureBridgeJsonRpcOutput as captureBridgeJsonRpcOutput,
  type CapturedBridgeJsonRpcOutput,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import { BRIDGE_JSON_RPC_ERRORS } from "@get-bb/plugin-sdk/provider-bridge";
import {
  currentConfiguredSkillRoots,
  handleLine,
  sessionTableForTests,
} from "./src/provider-bridge.js";

let output: CapturedBridgeJsonRpcOutput;
let collected: unknown[] = [];

beforeEach(() => {
  output = captureBridgeJsonRpcOutput();
  collected = [];
});

afterEach(() => {
  output.restore();
  sessionTableForTests().clear();
});

/**
 * Every read drains the capture and accumulates: takeMessages is destructive,
 * and one bridge answer (`provider/health`) arrives asynchronously, so tests
 * either read at the end or poll through this one accumulator.
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

/** Poll for an answer that lands on a later tick (async handlers, throws). */
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
    await new Promise((resolve) => setTimeout(resolve, 10));
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

function startThread(id: string, threadId: string): void {
  sendRequest(id, "thread/start", {
    threadId,
    cwd: "/tmp",
    instructionMode: "append",
    options: FULL_OPTIONS,
  });
}

describe("the skeleton turn grammar", () => {
  it("opens, warns that no model is attached, and settles", () => {
    startThread("t1", "thr_1");
    const providerThreadId = String(response("t1").result?.providerThreadId);
    sendRequest("t2", "turn/start", {
      threadId: "thr_1",
      providerThreadId,
      input: [{ type: "text", text: "hello", mentions: [] }],
      clientRequestId: CLIENT_REQUEST_ID,
      options: FULL_OPTIONS,
    });

    const kinds = deltas("thr_1").map((delta) => delta.kind);
    expect(kinds).toContain("session.reset");
    expect(kinds.indexOf("session.reset")).toBeLessThan(kinds.indexOf("turn.open"));
    expect(kinds).toContain("input.accepted");
    const warning = deltas("thr_1").find((delta) => delta.kind === "provider.warning");
    expect(warning).toMatchObject({ kind: "provider.warning", category: "general" });
    expect(String(warning?.summary)).toContain("not sent to prime-agent yet");
    expect(kinds.lastIndexOf("turn.boundary")).toBeGreaterThan(
      kinds.indexOf("turn.open"),
    );

    expect(deltas("thr_1").find((delta) => delta.kind === "input.accepted")).toMatchObject({
      clientRequestId: CLIENT_REQUEST_ID,
    });
  });

  it("announces thread/identity before any delta for the session", () => {
    startThread("t1", "thr_1");
    const identity = notifications("thread/identity").at(-1);
    expect(identity?.params).toMatchObject({
      threadId: "thr_1",
      providerThreadId: response("t1").result?.providerThreadId,
    });
    const methodOrder = messages().map(
      (message) => (message as Record<string, unknown>).method,
    );
    expect(methodOrder.indexOf("thread/identity")).toBeLessThan(
      methodOrder.indexOf("thread/delta"),
    );
  });

  it("answers turn/steer with NO_ACTIVE_TURN (no turn ever stays open)", () => {
    sendRequest("s1", "turn/steer", {
      threadId: "thr_x",
      providerThreadId: "prime_x",
      clientRequestId: CLIENT_REQUEST_ID,
      expectedTurnId: "turn-1",
      input: [{ type: "text", text: "stop", mentions: [] }],
      options: FULL_OPTIONS,
    });
    expect(response("s1").error).toMatchObject({
      code: BRIDGE_JSON_RPC_ERRORS.NO_ACTIVE_TURN,
    });
  });

  it("rejects a turn for a thread the bridge does not know", () => {
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

describe("session bookkeeping", () => {
  it("mints a fresh provider thread id per start and keeps resume stable", () => {
    startThread("a", "thr_a");
    startThread("b", "thr_b");
    const first = String(response("a").result?.providerThreadId);
    const second = String(response("b").result?.providerThreadId);
    expect(first).not.toBe(second);
    expect(response("a").result).toEqual({
      providerThreadId: first,
      sessionRestorable: false,
    });

    sendRequest("c", "thread/resume", {
      threadId: "thr_a",
      providerThreadId: first,
      cwd: "/tmp",
      instructionMode: "append",
      options: FULL_OPTIONS,
    });
    expect(response("c").result).toEqual({
      providerThreadId: first,
      sessionRestorable: false,
    });

    // A resume of an unknown provider thread id still answers identity — the
    // resident attach (bbpa-ggf.3) is what makes it real.
    sendRequest("d", "thread/resume", {
      threadId: "thr_c",
      providerThreadId: "prime_from_another_process",
      cwd: "/tmp",
      instructionMode: "append",
      options: FULL_OPTIONS,
    });
    expect(response("d").result?.providerThreadId).toBe("prime_from_another_process");
  });

  it("drops the record on stop and discard without touching any daemon", () => {
    startThread("a", "thr_a");
    expect(sessionTableForTests().byThread("thr_a")).toBeDefined();
    sendRequest("b", "thread/stop", {
      threadId: "thr_a",
      providerThreadId: "prime_x",
      intent: "release",
      activeTurnId: null,
    });
    sendRequest("c", "thread/discard", {
      threadId: "thr_a",
      providerThreadId: "prime_x",
    });
    expect(response("b").result).toEqual({ ok: true });
    expect(response("c").result).toEqual({ ok: true });
    expect(sessionTableForTests().byThread("thr_a")).toBeUndefined();
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

describe("methods that need a live prime session", () => {
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
          cwd: "/tmp",
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
    // The probe connects to a socket, so the answer may land a tick later.
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

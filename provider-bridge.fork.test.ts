import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  experimental_captureBridgeJsonRpcOutput as captureBridgeJsonRpcOutput,
  type CapturedBridgeJsonRpcOutput,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import {
  BRIDGE_NOTIFICATION_METHODS,
  BRIDGE_JSON_RPC_ERRORS,
} from "@get-bb/plugin-sdk/provider-bridge";
import {
  dynamicToolsRegistryForTests,
  handleLine,
  resetDaemonForTests,
  sessionTableForTests,
} from "./src/provider-bridge.js";
import { setPrimeDaemonTransportFactoryForTests } from "./src/daemon/connection.js";
import { BB_TOOLS_CHANNEL_FLAG } from "./src/dynamic-tools/protocol.js";
import { FakeExtension } from "./test-support/fake-extension.js";
import { primeAgentDir, primeSessionName } from "./src/session-params.js";
import {
  createScriptedDaemon,
  textTurnEvents,
  type ScriptedDaemonHandle,
} from "./test-support/scripted-daemon.js";

/**
 * bb's `thread/fork` (bbpa-ggf.7): forking from an earlier message creates a
 * NEW bb thread on a NEW prime session holding history up to the fork point.
 *
 * The scripted daemon answers the fork bracket command by command, so a bridge
 * that drifts from what prime actually requires — fork the source first, hand
 * it its own transcript back, and only then `create` the new session from the
 * branch file — fails loudly against a script that no longer matches.
 */

let output: CapturedBridgeJsonRpcOutput;
let collected: unknown[] = [];
let daemon: ScriptedDaemonHandle;
let cwd: string;
let liveExtension: FakeExtension | undefined;

const SOURCE_FILE = "/tmp/prime/sessions/sess_1.jsonl";
const BRANCH_FILE = "/tmp/prime/sessions/sess_branch.jsonl";

beforeEach(() => {
  output = captureBridgeJsonRpcOutput();
  collected = [];
  cwd = "/tmp/prime-workspace";
  daemon = createScriptedDaemon({
    session: {
      activeSessionId: "sess_1",
      sessionFile: SOURCE_FILE,
      sessionName: "[bb] source thread (thr_1)",
      cwd,
    },
  });
  setPrimeDaemonTransportFactoryForTests(() => daemon.transport);
});

afterEach(async () => {
  output.restore();
  setPrimeDaemonTransportFactoryForTests(undefined);
  resetDaemonForTests();
  sessionTableForTests().clear();
  await liveExtension?.close();
  liveExtension = undefined;
  await dynamicToolsRegistryForTests().clear();
});

async function waitFor(label: string, predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

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
  error?: { code: number; message: string };
}

async function waitForResponse(id: string, timeoutMs = 2_000): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = messages().find(
      (message) =>
        (message as { id?: unknown }).id === id &&
        (message as { method?: unknown }).method === undefined,
    );
    if (found !== undefined) {
      return found as Response;
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

/** Start the source thread and settle one completed turn on it. */
async function startSourceThread(
  id: string,
  threadId: string,
  prompt: string,
): Promise<{ providerThreadId: string; checkpointId: string }> {
  daemon.enqueueCreate();
  daemon.enqueueAttach();
  daemon.enqueuePrompt({ events: textTurnEvents({ text: "source answer" }) });
  sendRequest(id, "thread/start", {
    threadId,
    cwd,
    instructionMode: "append",
    options: FULL_OPTIONS,
    input: [{ type: "text", text: prompt, mentions: [] }],
  });
  const reply = await waitForResponse(id);
  expect(reply.error).toBeUndefined();
  const checkpoint = deltas(threadId).find(
    (delta) => delta.kind === "turn.boundary",
  )?.providerCheckpointId;
  expect(typeof checkpoint).toBe("string");
  return {
    providerThreadId: String(reply.result?.providerThreadId),
    checkpointId: String(checkpoint),
  };
}

/**
 * The fork bracket as prime requires it, with a two-turn source history
 * (u1 → a1 → u2 → a2) whose leaf is e_a2.
 */
function enqueueForkBracket(
  args: { checkpointFork?: boolean; switchCancelled?: boolean } = {},
): void {
  daemon.enqueueData("get_state", {
    data: { activeSessionId: "sess_1", sessionFile: SOURCE_FILE, sessionName: "[bb] source thread (thr_1)" },
  });
  daemon.enqueueData("get_session_tree", {
    data: {
      flatNodes: [
        { entry: { id: "e_u1", parentId: null, type: "message", message: { role: "user" } } },
        { entry: { id: "e_a1", parentId: "e_u1", type: "message", message: { role: "assistant" } } },
        { entry: { id: "e_u2", parentId: "e_a1", type: "message", message: { role: "user" } } },
        { entry: { id: "e_a2", parentId: "e_u2", type: "message", message: { role: "assistant" } } },
      ],
      leafId: "e_a2",
    },
  });
  if (args.checkpointFork !== false) {
    daemon.enqueueData("get_user_messages_for_forking", {
      data: {
        messages: [
          { entryId: "e_u1", text: "first prompt" },
          { entryId: "e_u2", text: "second prompt" },
        ],
      },
    });
  }
  daemon.enqueueData("fork", { data: { cancelled: false } });
  daemon.enqueueData("get_state", {
    data: { activeSessionId: "sess_1", sessionFile: BRANCH_FILE },
  });
  daemon.enqueueData("switch_session", {
    data: { cancelled: args.switchCancelled === true },
  });
  // The bridge verifies the restore landed before it creates: the source
  // session must observably be back on its own transcript.
  daemon.enqueueData("get_state", {
    data: { activeSessionId: "sess_1", sessionFile: SOURCE_FILE },
  });
  daemon.enqueueCreate({
    activeSessionId: "sess_forked",
    sessionFile: BRANCH_FILE,
    sessionName: "[bb] thr_fork",
  });
  daemon.enqueueAttach();
}

function commandTypesAfterLastPrompt(): string[] {
  const lastPrompt = daemon.commands.map((command) => command.type).lastIndexOf("prompt");
  return daemon.commands
    .slice(lastPrompt + 1)
    .map((command) => String(command.type));
}

describe("thread/fork (bbpa-ggf.7)", () => {
  it("forks at the anchored turn's end and creates the new session from the branch", async () => {
    const { providerThreadId, checkpointId } = await startSourceThread(
      "s1",
      "thr_1",
      "first prompt",
    );
    enqueueForkBracket();
    sendRequest("f1", "thread/fork", {
      threadId: "thr_fork",
      cwd,
      sourceProviderThreadId: providerThreadId,
      sourceProviderCheckpointId: checkpointId,
      instructionMode: "append",
      options: FULL_OPTIONS,
    });
    const reply = await waitForResponse("f1");
    expect(reply.error).toBeUndefined();
    expect(reply.result).toEqual({
      providerThreadId: "prime_sess_forked",
      sessionRestorable: true,
    });

    // The command order prime actually requires: read the source, resolve the
    // fork point, fork it, read the branch, hand the source its own transcript
    // back, and only then create (a create for a loaded file would join the
    // live source session).
    expect(commandTypesAfterLastPrompt()).toEqual([
      "get_state",
      "get_session_tree",
      "get_user_messages_for_forking",
      "fork",
      "get_state",
      "switch_session",
      "get_state",
      "create",
      "attach",
      "get_queue",
    ]);

    // The branch point is the END of the anchored turn — the answer e_a1, not
    // the prompt e_u1 — so the branched transcript carries what bb copied.
    const fork = daemon.commands.find((command) => command.type === "fork")!;
    expect(fork).toMatchObject({
      activeSessionId: "sess_1",
      entryId: "e_a1",
      position: "at",
    });
    // The source session got its own transcript back.
    expect(daemon.commands.find((command) => command.type === "switch_session")).toMatchObject({
      activeSessionId: "sess_1",
      sessionPath: SOURCE_FILE,
    });
    // The new session opened the branch, named through the ordinary funnel.
    const create = daemon.commands.filter((command) => command.type === "create").at(-1)!;
    expect(create.sessionPath).toBe(BRANCH_FILE);
    expect(create.name).toBe(primeSessionName({ threadId: "thr_fork" }));
    expect(create.lifecycle).toBe("resident");
    expect(create.config).toMatchObject({ cwd, agentDir: primeAgentDir() });

    // The new thread's construction was announced (id-space boundary first).
    const identity = notifications(BRIDGE_NOTIFICATION_METHODS.threadIdentity).at(-1)?.params;
    expect(identity).toMatchObject({
      threadId: "thr_fork",
      providerThreadId: "prime_sess_forked",
    });
    expect(deltas("thr_fork")[0]).toMatchObject({ kind: "session.reset" });
    // bb copied the inherited timeline into the new thread itself, so the
    // snapshot arms the boundary — it is not replayed as content.
    expect(deltas("thr_fork").filter((delta) => delta.kind !== "session.reset")).toEqual([]);

    const record = sessionTableForTests().byThread("thr_fork");
    expect(record).toMatchObject({
      providerThreadId: "prime_sess_forked",
      activeSessionId: "sess_forked",
      sessionFile: BRANCH_FILE,
    });
  });

  it("forks at the leaf when bb sends no checkpoint (tip fork)", async () => {
    const { providerThreadId } = await startSourceThread("s1", "thr_1", "first prompt");
    enqueueForkBracket({ checkpointFork: false });
    sendRequest("f1", "thread/fork", {
      threadId: "thr_fork",
      cwd,
      sourceProviderThreadId: providerThreadId,
      instructionMode: "append",
      options: FULL_OPTIONS,
    });
    const reply = await waitForResponse("f1");
    expect(reply.error).toBeUndefined();
    // No fork-point discovery for a tip fork, and the leaf is the branch point.
    expect(daemon.commands.some((command) => command.type === "get_user_messages_for_forking")).toBe(false);
    expect(daemon.commands.find((command) => command.type === "fork")).toMatchObject({
      entryId: "e_a2",
      position: "at",
    });
  });

  it("creates a fresh session when the source has no history to fork", async () => {
    const { providerThreadId } = await startSourceThread("s1", "thr_1", "first prompt");
    daemon.enqueueData("get_state", {
      data: { activeSessionId: "sess_1", sessionFile: SOURCE_FILE },
    });
    daemon.enqueueData("get_session_tree", { data: { flatNodes: [], leafId: null } });
    daemon.enqueueCreate({
      activeSessionId: "sess_forked",
      sessionFile: BRANCH_FILE,
      sessionName: "[bb] thr_fork",
    });
    daemon.enqueueAttach();
    sendRequest("f1", "thread/fork", {
      threadId: "thr_fork",
      cwd,
      sourceProviderThreadId: providerThreadId,
      instructionMode: "append",
      options: FULL_OPTIONS,
    });
    const reply = await waitForResponse("f1");
    expect(reply.result).toEqual({
      providerThreadId: "prime_sess_forked",
      sessionRestorable: true,
    });
    expect(daemon.commands.some((command) => command.type === "fork")).toBe(false);
    const create = daemon.commands.filter((command) => command.type === "create").at(-1)!;
    expect(create.sessionPath).toBeUndefined();
  });

  it("answers an unresolvable checkpoint honestly and builds nothing", async () => {
    const { providerThreadId } = await startSourceThread("s1", "thr_1", "first prompt");
    enqueueForkBracket();
    sendRequest("f1", "thread/fork", {
      threadId: "thr_fork",
      cwd,
      sourceProviderThreadId: providerThreadId,
      sourceProviderCheckpointId: "bbpa-ck-9-0123456789abcdef",
      instructionMode: "append",
      options: FULL_OPTIONS,
    });
    const reply = await waitForResponse("f1");
    expect(reply.error?.code).toBe(BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR);
    expect(reply.error?.message).toMatch(/no longer matches the session's fork points/);
    // Nothing was forked, nothing was created, nothing was left registered.
    expect(commandTypesAfterLastPrompt()).toEqual([
      "get_state",
      "get_session_tree",
      "get_user_messages_for_forking",
    ]);
    expect(sessionTableForTests().byThread("thr_fork")).toBeUndefined();
  });

  it("refuses a source thread id it did not mint", async () => {
    sendRequest("f1", "thread/fork", {
      threadId: "thr_fork",
      cwd,
      sourceProviderThreadId: "claude_session_7",
      instructionMode: "append",
      options: FULL_OPTIONS,
    });
    const reply = await waitForResponse("f1");
    expect(reply.error?.code).toBe(BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS);
    expect(reply.error?.message).toMatch(/not a prime-agent session id/);
    expect(daemon.commands).toEqual([]);
    expect(sessionTableForTests().byThread("thr_fork")).toBeUndefined();
  });

  it("fails loudly when prime cancels handing the source session back", async () => {
    const { providerThreadId, checkpointId } = await startSourceThread(
      "s1",
      "thr_1",
      "first prompt",
    );
    enqueueForkBracket({ switchCancelled: true });
    sendRequest("f1", "thread/fork", {
      threadId: "thr_fork",
      cwd,
      sourceProviderThreadId: providerThreadId,
      sourceProviderCheckpointId: checkpointId,
      instructionMode: "append",
      options: FULL_OPTIONS,
    });
    const reply = await waitForResponse("f1");
    expect(reply.error?.message).toMatch(/left running the branched transcript/);
    // The half-built fork never reached bb: no create, no record.
    expect(commandTypesAfterLastPrompt()).not.toContain("create");
    expect(sessionTableForTests().byThread("thr_fork")).toBeUndefined();
  });

  it("arms the dynamic-tools channel before the create and publishes after it", async () => {
    const { providerThreadId } = await startSourceThread("s1", "thr_1", "first prompt");
    enqueueForkBracket({ checkpointFork: false });
    sendRequest("f1", "thread/fork", {
      threadId: "thr_fork",
      cwd,
      sourceProviderThreadId: providerThreadId,
      instructionMode: "append",
      options: FULL_OPTIONS,
      dynamicTools: [
        {
          name: "bb_echo",
          description: "Echo a message back",
          inputSchema: { type: "object", properties: {}, required: [] },
        },
      ],
    });
    // The companion extension connects while the prime worker boots; it acks
    // the tool set, which lets the publish (and with it the reply) through.
    const registry = dynamicToolsRegistryForTests();
    await waitFor("the channel to listen", () => registry.channel("thr_fork") !== undefined);
    const channelPath = registry.sessionConfig("thr_fork")?.extensionFlagValues[BB_TOOLS_CHANNEL_FLAG];
    expect(channelPath).toBeTruthy();
    liveExtension = await FakeExtension.connect(channelPath!);

    const reply = await waitForResponse("f1", 15_000);
    expect(reply.error).toBeUndefined();
    const create = daemon.commands.filter((command) => command.type === "create").at(-1)!;
    const config = create.config as Record<string, unknown>;
    expect(Array.isArray(config.extensions)).toBe(true);
    expect((config.extensionFlagValues as Record<string, string>)[BB_TOOLS_CHANNEL_FLAG]).toBe(
      channelPath,
    );
    // The bb tool set reached the channel after the session existed.
    await waitFor("the tools/set to reach the extension", () =>
      liveExtension!.received.some((message) => message.type === "tools/set"),
    );
  }, 30_000);
});

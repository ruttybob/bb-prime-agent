import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { afterEach, describe, expect, it } from "vitest";
import { DynamicToolsChannel, mintChannelSocketPath } from "./channel-server.js";
import { FakeExtension } from "../../test-support/fake-extension.js";
import { rejectionOf } from "../../test-support/rejections.js";

/** Drives a channel the way the chat path will, and records its hook calls. */
class ScriptedExecutor {
  readonly calls: { callId: string; name: string; args: Record<string, unknown> }[] = [];
  answer:
    | ((call: { name: string; args: Record<string, unknown> }) => Promise<{
        ok: true;
        content: string;
      }>)
    | { ok: false; error: string } = async (call) => ({ ok: true, content: `ran ${call.name}` });

  handler = (call: { callId: string; name: string; args: Record<string, unknown> }) => {
    this.calls.push(call);
    const answer = this.answer;
    return typeof answer === "function" ? answer(call) : Promise.resolve(answer);
  };
}

const directories: string[] = [];
const sockets: Server[] = [];
const channels: DynamicToolsChannel[] = [];

afterEach(async () => {
  for (const channel of channels.splice(0)) {
    await channel.close();
  }
  for (const server of sockets.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "bbpa-channel-"));
  directories.push(directory);
  return directory;
}

const TOOLS = [
  {
    name: "bb_echo",
    description: "Echo the message back.",
    parameters: {
      type: "object",
      properties: { message: { type: "string", description: "Text to echo" } },
      required: ["message"],
    },
  },
];

function startChannel(args: {
  providerThreadId: string;
  executor: ScriptedExecutor;
  ackTimeoutMs?: number;
}): DynamicToolsChannel {
  const channel = new DynamicToolsChannel({
    providerThreadId: args.providerThreadId,
    onToolCall: args.executor.handler,
    socketDir: tempDir(),
    ackTimeoutMs: args.ackTimeoutMs,
  });
  channels.push(channel);
  return channel;
}

describe("a dynamic-tools channel", () => {
  it("publishes the tool set once the extension connects and reports the ack", async () => {
    const executor = new ScriptedExecutor();
    const channel = startChannel({ providerThreadId: "prime_test_1", executor });
    await channel.listen();

    // Publishing before the extension exists queues the set; it resolves when
    // the extension appears (the prime worker boots after `create`).
    const pending = channel.setTools(TOOLS);
    expect(channel.connected).toBe(false);

    await FakeExtension.connect(channel.path);
    const ack = await pending;
    expect(ack.ok).toBe(true);
    expect(ack.registered).toEqual(["bb_echo"]);
    expect(ack.active).toContain("bb_echo");
    expect(channel.connected).toBe(true);
  });

  it("answers a tool/call through the onToolCall hook and delivers the result", async () => {
    const executor = new ScriptedExecutor();
    executor.answer = async (call) => ({ ok: true, content: `[bb] ${String(call.args.message)}` });
    const channel = startChannel({ providerThreadId: "prime_test_2", executor });
    await channel.listen();
    const pendingSet = channel.setTools(TOOLS);
    const extension = await FakeExtension.connect(channel.path);
    await pendingSet;

    extension.call("bb_echo", { message: "ping" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(executor.calls).toEqual([
      { callId: "bb-tc-1", name: "bb_echo", args: { message: "ping" } },
    ]);
    // The queued set arrived on connect; the answer to the forwarded call is
    // the channel's last word.
    expect(extension.received.at(-1)).toEqual({
      type: "tool/result",
      callId: "bb-tc-1",
      ok: true,
      result: { content: "[bb] ping" },
    });
  });

  it("reports a failed tool execution as ok:false with the hook's error", async () => {
    const executor = new ScriptedExecutor();
    executor.answer = { ok: false, error: "bb refused the tool" };
    const channel = startChannel({ providerThreadId: "prime_test_3", executor });
    await channel.listen();
    const extension = await FakeExtension.connect(channel.path);
    await channel.setTools(TOOLS);

    extension.call("bb_echo", { message: "ping" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(extension.received.at(-1)).toMatchObject({
      type: "tool/result",
      callId: "bb-tc-1",
      ok: false,
      error: "bb refused the tool",
    });
  });

  it("turns a thrown hook error into a failed result instead of a crash", async () => {
    const channel = new DynamicToolsChannel({
      providerThreadId: "prime_test_4",
      onToolCall: async () => {
        throw new Error("the outbound request exploded");
      },
      socketDir: tempDir(),
    });
    channels.push(channel);
    await channel.listen();
    const extension = await FakeExtension.connect(channel.path);
    await channel.setTools([]);

    extension.call("bb_echo", {}, "bb-tc-9");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(extension.received.at(-1)).toMatchObject({
      type: "tool/result",
      callId: "bb-tc-9",
      ok: false,
      error: "the outbound request exploded",
    });
  });

  it("re-publishes the desired set when a replacement extension connects", async () => {
    const executor = new ScriptedExecutor();
    const channel = startChannel({ providerThreadId: "prime_test_5", executor });
    await channel.listen();
    const first = await FakeExtension.connect(channel.path);
    await channel.setTools(TOOLS);
    await channel.setTools([
      ...TOOLS,
      { name: "bb_search", description: "Search bb." },
    ]);
    await first.close();

    // A prime worker replacement connects afresh and must converge on the
    // current set without bb re-publishing anything.
    const second = await FakeExtension.connect(channel.path);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(second.received).toEqual([
      {
        type: "tools/set",
        tools: [
          {
            name: "bb_echo",
            description: "Echo the message back.",
            parameters: TOOLS[0].parameters,
          },
          { name: "bb_search", description: "Search bb." },
        ],
      },
    ]);
  });

  it("times out when the extension never acknowledges the set", async () => {
    const executor = new ScriptedExecutor();
    const channel = startChannel({ providerThreadId: "prime_test_6", executor });
    await channel.listen();
    const extension = await FakeExtension.connect(channel.path);
    extension.mode = "silent";
    const error = await rejectionOf(channel.setTools(TOOLS, { timeoutMs: 120 }));
    expect(error.message).toContain("did not acknowledge the tool set within 120ms");
  });

  it("rejects setTools when the extension never connects at all", async () => {
    const executor = new ScriptedExecutor();
    const channel = startChannel({ providerThreadId: "prime_test_7", executor });
    await channel.listen();
    const error = await rejectionOf(channel.setTools(TOOLS, { timeoutMs: 100 }));
    expect(error.message).toContain("never connected");
  });

  it("reports an extension nack as a failed setTools", async () => {
    const channel = new DynamicToolsChannel({
      providerThreadId: "prime_test_8",
      onToolCall: async () => ({ ok: true, content: "" }),
      socketDir: tempDir(),
    });
    channels.push(channel);
    await channel.listen();
    const extension = await FakeExtension.connect(channel.path);
    extension.mode = "nack";
    const error = await rejectionOf(channel.setTools(TOOLS));
    expect(error.message).toContain("registerTool: runtime is stale");
  });

  it("rejects a setTools publish that is still open when the channel closes", async () => {
    const executor = new ScriptedExecutor();
    const channel = startChannel({
      providerThreadId: "prime_test_9",
      executor,
      ackTimeoutMs: 5_000,
    });
    await channel.listen();
    const pending = channel.setTools(TOOLS);
    await channel.close();
    const error = await rejectionOf(pending);
    expect(error.message).toContain("closed");
  });

  it("removes the socket file on close and frees the name", async () => {
    const executor = new ScriptedExecutor();
    const channel = startChannel({ providerThreadId: "prime_test_10", executor });
    await channel.listen();
    await channel.close();
    // The freed name is bindable again: the next session's channel can take it.
    await new Promise<void>((resolve, reject) => {
      const server = createServer();
      sockets.push(server);
      server.once("error", reject);
      server.listen(channel.path, () => resolve());
    });
  });

  it("mints unique socket paths under the per-user channel dir", () => {
    const first = mintChannelSocketPath("prime_skeleton_abc/1:x");
    const second = mintChannelSocketPath("prime_skeleton_abc/1:x");
    expect(first).not.toEqual(second);
    expect(first).toContain("bb-prime-agent-");
    const file = first.split("/").at(-1) ?? "";
    expect(file).toMatch(/^prime_skeleton_abc_1_x-[0-9a-f]+\.sock$/u);
  });
});

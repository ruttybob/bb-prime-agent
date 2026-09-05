import { describe, expect, it } from "vitest";
import { handleLine, dynamicToolsRegistryForTests } from "./src/provider-bridge.js";
import { companionExtensionPath } from "./src/dynamic-tools/registry.js";
import { BB_TOOLS_CHANNEL_FLAG } from "./src/dynamic-tools/protocol.js";
import { textTurnEvents, type ScriptedDaemonHandle } from "./test-support/scripted-daemon.js";
import { FakeExtension } from "./test-support/fake-extension.js";
import { FULL_OPTIONS, startBridgeHarness } from "./test-support/bridge-harness.js";

/** The scripted daemon is created per test; beforeEach re-binds the alias. */
let daemon: ScriptedDaemonHandle;

const h = startBridgeHarness({
  session: {
    activeSessionId: "sess_dt",
    sessionFile: "/tmp/prime/sessions/sess_dt.jsonl",
    sessionName: "[bb] dynamic tools thread",
    cwd: "/tmp/prime-workspace",
  },
  beforeEachExtra: (harness) => {
    daemon = harness.daemon;
  },
});

const { sendRequest, waitForAnyResponse, waitFor, messages } = h;

const DYNAMIC_TOOLS = [
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

function startThread(id: string): void {
  sendRequest(id, "thread/start", {
    threadId: "thr_dt",
    cwd: "/tmp/prime-workspace",
    instructionMode: "append",
    input: [{ type: "text", text: "hi", mentions: [] }],
    options: FULL_OPTIONS,
    dynamicTools: DYNAMIC_TOOLS,
  });
}

describe("the dynamic-tools wiring (bbpa-ggf.13)", () => {
  it("loads the companion extension for the session, publishes the tool set, and forwards calls as item/tool/call", async () => {
    daemon.enqueueCreate();
    daemon.enqueueAttach();
    daemon.enqueuePrompt({ events: textTurnEvents({ text: "ok" }) });
    daemon.enqueueOk("abort");
    daemon.enqueueOk("detach");

    startThread("req-1");

    // The channel listens before `create` goes out.
    const registry = dynamicToolsRegistryForTests();
    await waitFor("the channel to listen", () => registry.channel("thr_dt") !== undefined);
    const channelPath = registry.sessionConfig("thr_dt")?.extensionFlagValues[BB_TOOLS_CHANNEL_FLAG];

    await waitFor("the create command", () =>
      daemon.commands.some((command) => command.type === "create"),
    );
    const create = daemon.commands.find((command) => command.type === "create")!;
    const config = create.config as Record<string, unknown>;
    expect(config.extensions).toEqual([companionExtensionPath()]);
    expect(config.noExtensions).toBe(true);
    expect((config.extensionFlagValues as Record<string, string>)[BB_TOOLS_CHANNEL_FLAG]).toBe(
      channelPath,
    );

    // The extension connects while the "worker boots"; its ack lets the
    // thread/start answer through.
    const extension = await FakeExtension.connect(channelPath!);
    try {
      const reply = await waitForAnyResponse("req-1");
      expect(reply.error).toBeUndefined();
      await waitFor("the tools/set", () =>
        extension.received.some((message) => message.type === "tools/set"),
      );
      const toolsSet = extension.received.find((message) => message.type === "tools/set")! as {
        tools: { name: string }[];
      };
      expect(toolsSet.tools.map((tool) => tool.name)).toEqual(["bb_echo"]);

      // The model calls the bb tool; the bridge forwards it to the runtime as
      // its outbound item/tool/call and returns the runtime's answer.
      extension.call("bb_echo", { message: "ping" });
      await waitFor("the item/tool/call", () =>
        messages().some((message) => (message as { method?: string }).method === "item/tool/call"),
      );
      const call = messages().find(
        (message) => (message as { method?: string }).method === "item/tool/call",
      ) as { id: string; params: { tool: string; arguments: Record<string, unknown> } };
      expect(call.params.tool).toBe("bb_echo");
      expect(call.params.arguments).toEqual({ message: "ping" });

      handleLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: call.id,
          result: {
            success: true,
            contentItems: [{ type: "inputText", text: "[bb-echo] ping" }],
          },
        }),
      );
      await waitFor("the tool/result", () =>
        extension.received.some((message) => message.type === "tool/result"),
      );
      const result = extension.received.find((message) => message.type === "tool/result") as {
        callId: string;
        ok: boolean;
        result: { content: string };
      };
      expect(result.callId).toBe("bb-tc-1");
      expect(result.ok).toBe(true);
      expect(result.result.content).toBe("[bb-echo] ping");
    } finally {
      await extension.close();
    }

    // Releasing the thread takes its channel down with the record.
    sendRequest("req-2", "thread/stop", {
      threadId: "thr_dt",
      providerThreadId: "prime_sess_dt",
      intent: "release",
      activeTurnId: null,
    });
    const release = await waitForAnyResponse("req-2");
    expect(release.error).toBeUndefined();
    await waitFor("the channel map to drain", () => registry.channel("thr_dt") === undefined);
  });

  it("creates plain sessions when the thread declares no dynamic tools", async () => {
    daemon.enqueueCreate();
    daemon.enqueueAttach();
    daemon.enqueuePrompt({ events: textTurnEvents({ text: "ok" }) });
    daemon.enqueueOk("abort");

    sendRequest("req-3", "thread/start", {
      threadId: "thr_plain",
      cwd: "/tmp/prime-workspace",
      instructionMode: "append",
      input: [{ type: "text", text: "hi", mentions: [] }],
      options: FULL_OPTIONS,
    });
    const reply = await waitForAnyResponse("req-3");
    expect(reply.error).toBeUndefined();
    const create = daemon.commands.find((command) => command.type === "create")!;
    const config = create.config as Record<string, unknown>;
    expect(config.extensions).toBeUndefined();
    expect(config.extensionFlagValues).toBeUndefined();
    expect(dynamicToolsRegistryForTests().channel("thr_plain")).toBeUndefined();
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import bbToolsExtension, {
  applyBbToolSet,
  BB_TOOLS_CHANNEL_FLAG,
  createBbExtensionState,
  type BbExtensionApi,
  type BbExtensionTool,
} from "./bb-tools-extension.js";
import {
  DynamicToolsChannel,
  type BbToolCallHandler,
} from "../src/dynamic-tools/channel-server.js";
import { rejectionOf } from "../test-support/rejections.js";

/**
 * A prime ExtensionAPI stand-in that records registrations exactly the way
 * prime's own loader does (`extension.tools.set(name, definition)`) and lets
 * tests fire session events. No prime code involved — the mapping under test
 * is this extension's, against the API surface prime documents.
 */
class FakePi implements BbExtensionApi {
  readonly tools = new Map<string, { name: string; label: string; description: string; parameters: unknown }>();
  readonly flags = new Map<string, { type: "boolean" | "string"; default?: boolean | string }>();
  readonly flagValues = new Map<string, boolean | string>();
  readonly handlers = new Map<string, ((event: unknown, ctx: unknown) => void)[]>();
  activeTools: string[] = ["read", "bash"];
  activeToolSets: string[][] = [];
  throwOnRegister = false;

  registerFlag(name: string, options: { type: "boolean" | "string"; default?: boolean | string }): void {
    this.flags.set(name, options);
    if (options.default !== undefined && !this.flagValues.has(name)) {
      this.flagValues.set(name, options.default);
    }
  }

  getFlag(name: string): boolean | string | undefined {
    if (!this.flags.has(name)) {
      return undefined;
    }
    return this.flagValues.get(name);
  }

  registerTool(tool: { name: string; label: string; description: string; parameters: unknown }): void {
    if (this.throwOnRegister) {
      throw new Error("runtime is stale after session replacement");
    }
    this.tools.set(tool.name, tool);
  }

  getActiveTools(): string[] {
    return [...this.activeTools];
  }

  setActiveTools(toolNames: string[]): void {
    this.activeTools = [...toolNames];
    this.activeToolSets.push([...toolNames]);
  }

  on(event: string, handler: (event: unknown, ctx: unknown) => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  emit(event: string): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler({ type: event }, {});
    }
  }
}

const directories: string[] = [];
const channels: DynamicToolsChannel[] = [];

afterEach(async () => {
  for (const channel of channels.splice(0)) {
    await channel.close();
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function startChannel(args: { onToolCall: BbToolCallHandler }): DynamicToolsChannel {
  const directory = mkdtempSync(join(tmpdir(), "bbpa-ext-"));
  directories.push(directory);
  const channel = new DynamicToolsChannel({
    providerThreadId: "prime_extension_test",
    onToolCall: args.onToolCall,
    socketDir: directory,
  });
  channels.push(channel);
  return channel;
}

const ECHO: BbExtensionTool = {
  name: "bb_echo",
  description: "Echo the message back.",
  parameters: {
    type: "object",
    properties: { message: { type: "string", description: "Text to echo" } },
    required: ["message"],
  },
};

describe("the tools/set → registerTool mapping", () => {
  it("registers every requested tool and leaves prime's active set alone when it already matches", () => {
    const pi = new FakePi();
    const state = createBbExtensionState();
    const applied = applyBbToolSet(pi, state, [ECHO]);
    expect([...pi.tools.keys()]).toEqual(["bb_echo"]);
    expect(applied).toEqual({ registered: ["bb_echo"], active: ["read", "bash", "bb_echo"] });
    // The active set is reconciled explicitly (prime auto-activates new tools
    // too, but only a `setActiveTools` keeps bb's own bookkeeping true).
    expect(pi.activeToolSets).toEqual([["read", "bash", "bb_echo"]]);
  });

  it("re-registers on every set so description changes stay in sync", () => {
    const pi = new FakePi();
    const state = createBbExtensionState();
    applyBbToolSet(pi, state, [ECHO]);
    const updated = applyBbToolSet(pi, state, [
      { ...ECHO, description: "Echo it louder." },
    ]);
    expect(pi.tools.get("bb_echo")?.description).toBe("Echo it louder.");
    expect(updated.registered).toEqual(["bb_echo"]);
    // The second set changes nothing about availability: no further write.
    expect(pi.activeToolSets).toEqual([["read", "bash", "bb_echo"]]);
  });

  it("deactivates bb tools that left the set, keeping prime's own tools", () => {
    const pi = new FakePi();
    const state = createBbExtensionState();
    applyBbToolSet(pi, state, [ECHO, { name: "bb_search", description: "Search." }]);
    expect(pi.getActiveTools()).toEqual(["read", "bash", "bb_echo", "bb_search"]);

    const applied = applyBbToolSet(pi, state, [ECHO]);
    expect(applied.active).toEqual(["read", "bash", "bb_echo"]);
    expect(pi.activeToolSets).toEqual([
      ["read", "bash", "bb_echo", "bb_search"],
      ["read", "bash", "bb_echo"],
    ]);
    // ...but the definition stays registered: prime has no unregisterTool.
    expect([...pi.tools.keys()]).toEqual(["bb_echo", "bb_search"]);
  });

  it("re-activates a bb tool that returns to the set", () => {
    const pi = new FakePi();
    const state = createBbExtensionState();
    applyBbToolSet(pi, state, [ECHO, { name: "bb_search", description: "Search." }]);
    applyBbToolSet(pi, state, [ECHO]);
    const applied = applyBbToolSet(pi, state, [ECHO, { name: "bb_search", description: "Search." }]);
    expect(applied.active).toEqual(["read", "bash", "bb_echo", "bb_search"]);
  });

  it("fills in a defaults-only schema and label for bare tool entries", () => {
    const pi = new FakePi();
    const state = createBbExtensionState();
    applyBbToolSet(pi, state, [{ name: "bb_bare", description: "" }]);
    const tool = pi.tools.get("bb_bare");
    expect(tool?.label).toBe("bb_bare");
    expect(tool?.parameters).toEqual({ type: "object", properties: {}, required: [] });
  });
});

describe("the companion extension", () => {
  it("registers its channel flag so prime accepts the create-time value", () => {
    const pi = new FakePi();
    bbToolsExtension(pi);
    expect(pi.flags.get(BB_TOOLS_CHANNEL_FLAG)).toMatchObject({ type: "string" });
  });

  it("does nothing when the flag carries no channel", () => {
    const pi = new FakePi();
    bbToolsExtension(pi);
    pi.emit("session_start");
    expect(pi.tools.size).toBe(0);
  });

  it("applies a published set on the live pi and acknowledges it", async () => {
    const pi = new FakePi();
    const channel = startChannel({
      onToolCall: async (call) => ({ ok: true, content: `[bb] ${String(call.args.message)}` }),
    });
    await channel.listen();
    pi.flagValues.set(BB_TOOLS_CHANNEL_FLAG, channel.path);
    bbToolsExtension(pi);
    pi.emit("session_start");

    const pending = channel.setTools([ECHO]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const ack = await pending;
    expect(ack).toEqual({
      type: "tools/ack",
      ok: true,
      registered: ["bb_echo"],
      active: ["read", "bash", "bb_echo"],
    });
    expect([...pi.tools.keys()]).toEqual(["bb_echo"]);
  });

  it("round-trips a model tool call: execute → tool/call → result → content", async () => {
    const pi = new FakePi();
    const channel = startChannel({
      onToolCall: async (call) => ({ ok: true, content: `[bb] ${String(call.args.message)}` }),
    });
    await channel.listen();
    pi.flagValues.set(BB_TOOLS_CHANNEL_FLAG, channel.path);
    bbToolsExtension(pi);
    pi.emit("session_start");
    await channel.setTools([ECHO]);

    const definition = pi.tools.get("bb_echo");
    expect(definition).toBeDefined();
    const execution = definition!.parameters !== undefined ? runTool(pi, "bb_echo", { message: "ping" }) : null;
    expect(execution).not.toBeNull();
    expect(await execution).toEqual({
      content: [{ type: "text", text: "[bb] ping" }],
      details: { bb: true },
    });
  });

  it("maps image blocks and extra content blocks through to prime", async () => {
    const pi = new FakePi();
    const channel = startChannel({
      onToolCall: async () => ({
        ok: true,
        content: "caption",
        contentBlocks: [{ type: "image", data: "QUJD", mimeType: "image/png" }],
      }),
    });
    await channel.listen();
    pi.flagValues.set(BB_TOOLS_CHANNEL_FLAG, channel.path);
    bbToolsExtension(pi);
    pi.emit("session_start");
    await channel.setTools([ECHO]);

    const result = await runTool(pi, "bb_echo", { message: "ping" });
    expect(result.content).toEqual([
      { type: "text", text: "caption" },
      { type: "image", data: "QUJD", mimeType: "image/png" },
    ]);
  });

  it("fails the tool call when the bridge reports an error", async () => {
    const pi = new FakePi();
    const channel = startChannel({
      onToolCall: async () => ({ ok: false, error: "bb thread is gone" }),
    });
    await channel.listen();
    pi.flagValues.set(BB_TOOLS_CHANNEL_FLAG, channel.path);
    bbToolsExtension(pi);
    pi.emit("session_start");
    await channel.setTools([ECHO]);

    const error = await rejectionOf(runTool(pi, "bb_echo", { message: "ping" }));
    expect(error.message).toBe("bb thread is gone");
  });

  it("rejects an in-flight call when the run is aborted", async () => {
    const pi = new FakePi();
    const channel = startChannel({
      onToolCall: async () => {
        // The bridge never answers: the model's turn was aborted instead.
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        return { ok: true, content: "too late" };
      },
    });
    await channel.listen();
    pi.flagValues.set(BB_TOOLS_CHANNEL_FLAG, channel.path);
    bbToolsExtension(pi);
    pi.emit("session_start");
    await channel.setTools([ECHO]);

    const controller = new AbortController();
    const execution = runTool(pi, "bb_echo", { message: "ping" }, controller.signal);
    controller.abort();
    const error = await rejectionOf(execution);
    expect(error.message).toContain("was aborted before the bridge answered");
  }, 10_000);

  it("ignores a late result for an abandoned call", async () => {
    const pi = new FakePi();
    const channel = startChannel({ onToolCall: async () => ({ ok: true, content: "x" }) });
    await channel.listen();
    pi.flagValues.set(BB_TOOLS_CHANNEL_FLAG, channel.path);
    bbToolsExtension(pi);
    pi.emit("session_start");
    await channel.setTools([ECHO]);

    const controller = new AbortController();
    const execution = runTool(pi, "bb_echo", { message: "ping" }, controller.signal);
    controller.abort();
    await rejectionOf(execution);
    // The bridge's answer lands afterwards; nothing throws, nothing resolves.
    await channel.setTools([ECHO]);
    expect(pi.tools.get("bb_echo")).toBeDefined();
  });

  it("reports a prime-side registration failure as a nack", async () => {
    const pi = new FakePi();
    const channel = startChannel({ onToolCall: async () => ({ ok: true, content: "x" }) });
    await channel.listen();
    pi.flagValues.set(BB_TOOLS_CHANNEL_FLAG, channel.path);
    bbToolsExtension(pi);
    pi.emit("session_start");
    pi.throwOnRegister = true;
    const error = await rejectionOf(channel.setTools([ECHO]));
    expect(error.message).toContain("runtime is stale");
  });

  it("keeps the channel across a session_start that fires again", async () => {
    const pi = new FakePi();
    const channel = startChannel({ onToolCall: async () => ({ ok: true, content: "x" }) });
    await channel.listen();
    pi.flagValues.set(BB_TOOLS_CHANNEL_FLAG, channel.path);
    bbToolsExtension(pi);
    pi.emit("session_start");
    await channel.setTools([ECHO]);
    // prime re-fires session_start on reload; the live socket must survive.
    pi.emit("session_start");
    const ack = await channel.setTools([{ ...ECHO, description: "again" }]);
    expect(ack.ok).toBe(true);
  });
});

/** Drives a registered tool the way prime does, from the fake registry. */
function runTool(
  pi: FakePi,
  name: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ content: unknown[]; details: unknown }> {
  const definition = pi.tools.get(name);
  if (definition === undefined) {
    return Promise.reject(new Error(`no registered tool ${name}`));
  }
  return (definition as unknown as {
    execute: (
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal | undefined,
    ) => Promise<{ content: unknown[]; details: unknown }>;
  }).execute("call_1", params, signal);
}

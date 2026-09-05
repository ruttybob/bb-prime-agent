import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DynamicTool } from "@get-bb/plugin-sdk/provider-bridge";
import { BB_TOOLS_CHANNEL_FLAG } from "./protocol.js";
import {
  DynamicToolsRegistry,
  companionExtensionPath,
  toChannelTools,
} from "./registry.js";
import { FakeExtension } from "../../test-support/fake-extension.js";
import { rejectionOf } from "../../test-support/rejections.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function newRegistry(): DynamicToolsRegistry {
  return new DynamicToolsRegistry({ socketDir: mkdtempSync(tmpdir()) });
}

const TOOLS: readonly DynamicTool[] = [
  {
    name: "bb_echo",
    description: "Echo the message back.",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
    },
    presentation: {
      icon: { glyph: "echo" },
      label: { pending: "Echoing…", completed: "Echoed" },
      title: "bb echo",
    },
  },
];

describe("the dynamic-tools registry", () => {
  it("starts a listening channel per session and reports it", async () => {
    const registry = newRegistry();
    const channel = await registry.start({
      providerThreadId: "prime_s1",
      onToolCall: async () => ({ ok: true, content: "" }),
    });
    directories.push(dirname(channel.path));
    expect(registry.size).toBe(1);
    expect(registry.channel("prime_s1")?.path).toBe(channel.path);
    await registry.stop("prime_s1");
    expect(registry.size).toBe(0);
  });

  it("publishes bb dynamic tools and resolves with the extension's ack", async () => {
    const registry = newRegistry();
    const channel = await registry.start({
      providerThreadId: "prime_s2",
      onToolCall: async () => ({ ok: true, content: "" }),
    });
    const extension = await FakeExtension.connect(channel.path);
    const ack = await registry.setTools("prime_s2", TOOLS, { timeoutMs: 2_000 });
    expect(ack.ok).toBe(true);
    expect(ack.registered).toEqual(["bb_echo"]);
    // bb's presentation metadata stays bb-side: only name/description/schema
    // and the label cross the channel.
    expect(extension.received[0]).toMatchObject({
      type: "tools/set",
      tools: [
        {
          name: "bb_echo",
          description: "Echo the message back.",
          label: "bb echo",
          parameters: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
        },
      ],
    });
    await registry.stop("prime_s2");
  });

  it("rejects setTools for a session that has no channel", async () => {
    const registry = newRegistry();
    const error = await rejectionOf(registry.setTools("prime_missing", []));
    expect(error.message).toContain("no dynamic-tools channel is running for prime_missing");
  });

  it("hands the create config that loads the extension and points it at the channel", async () => {
    const registry = newRegistry();
    expect(registry.sessionConfig("prime_absent")).toBeUndefined();

    const channel = await registry.start({
      providerThreadId: "prime_s3",
      onToolCall: async () => ({ ok: true, content: "" }),
    });
    expect(registry.sessionConfig("prime_s3")).toEqual({
      noExtensions: true,
      extensions: [companionExtensionPath()],
      extensionFlagValues: { [BB_TOOLS_CHANNEL_FLAG]: channel.path },
    });
    await registry.stop("prime_s3");
    expect(registry.sessionConfig("prime_s3")).toBeUndefined();
  });

  it("stops a session's channel before starting a replacement", async () => {
    const registry = newRegistry();
    const first = await registry.start({
      providerThreadId: "prime_s4",
      onToolCall: async () => ({ ok: true, content: "" }),
    });
    const second = await registry.start({
      providerThreadId: "prime_s4",
      onToolCall: async () => ({ ok: true, content: "" }),
    });
    expect(registry.size).toBe(1);
    expect(second.path).not.toEqual(first.path);
    await registry.stop("prime_s4");
  });

  it("clears every channel", async () => {
    const registry = newRegistry();
    await registry.start({ providerThreadId: "prime_s5", onToolCall: async () => ({ ok: true, content: "" }) });
    await registry.start({ providerThreadId: "prime_s6", onToolCall: async () => ({ ok: true, content: "" }) });
    await registry.clear();
    expect(registry.size).toBe(0);
  });
});

describe("toChannelTools", () => {
  it("keeps a non-object schema from reaching the wire", () => {
    const tools = toChannelTools([
      { name: "a", description: "A.", inputSchema: "not-a-schema" },
      { name: "b", description: "B.", inputSchema: undefined },
    ]);
    expect(tools).toEqual([
      { name: "a", description: "A." },
      { name: "b", description: "B." },
    ]);
  });
});

describe("companionExtensionPath", () => {
  it("resolves the shipped extension artifact next to the bridge", () => {
    const path = companionExtensionPath();
    expect(path.endsWith("extension/bb-tools-extension.ts")).toBe(true);
  });
});

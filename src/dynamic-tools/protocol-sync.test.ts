import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BB_TOOLS_CHANNEL_FLAG, BB_TOOLS_PROTOCOL_VERSION } from "./protocol.js";

/**
 * The channel has two independent implementations — the bridge
 * (`src/dynamic-tools/`) and the companion extension
 * (`extension/bb-tools-extension.ts`, loaded by prime with no imports from
 * this repo). They cannot share a module, so this test is the sync point: the
 * wire vocabulary, the flag name, and the PROTOCOL.md reference must stay
 * identical on both sides.
 */
const BRIDGE_PROTOCOL = fileURLToPath(new URL("./protocol.ts", import.meta.url));
const EXTENSION = fileURLToPath(new URL("../../extension/bb-tools-extension.ts", import.meta.url));
const PROTOCOL_DOC = fileURLToPath(new URL("../../extension/PROTOCOL.md", import.meta.url));

const MESSAGE_TYPES = ["tools/set", "tools/ack", "tool/call", "tool/result"] as const;

function read(path: string): string {
  return readFileSync(path, "utf8");
}

describe("the channel protocol sync", () => {
  it("uses the same flag name on both sides", () => {
    const extension = read(EXTENSION);
    expect(extension).toContain(`export const BB_TOOLS_CHANNEL_FLAG = "${BB_TOOLS_CHANNEL_FLAG}"`);
  });

  it("uses the same message vocabulary on both sides", () => {
    const bridge = read(BRIDGE_PROTOCOL);
    const extension = read(EXTENSION);
    for (const type of MESSAGE_TYPES) {
      expect(bridge).toContain(`"${type}"`);
      expect(extension).toContain(`"${type}"`);
    }
  });

  it("documents every message in PROTOCOL.md", () => {
    const doc = read(PROTOCOL_DOC);
    for (const type of MESSAGE_TYPES) {
      expect(doc).toContain(type);
    }
    expect(doc).toContain(BB_TOOLS_CHANNEL_FLAG);
  });

  it("keeps the bridge's protocol version pinned to the documented one", () => {
    const doc = read(PROTOCOL_DOC);
    expect(doc).toMatch(new RegExp(`^Version ${BB_TOOLS_PROTOCOL_VERSION}\\.`, "mu"));
    expect(read(EXTENSION)).toContain(
      `export const BB_TOOLS_PROTOCOL_VERSION = ${BB_TOOLS_PROTOCOL_VERSION}`,
    );
  });
});

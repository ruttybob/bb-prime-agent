import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { BB_TOOLS_EXTENSION_SOURCE } from "./embedded-extension-source.js";
import { materializedExtensionPath } from "./registry.js";

/**
 * The embedded copy of the companion extension (bbpa-9ah): the bb.host
 * artifact is a single file, so the source travels inside the bundle and is
 * materialized to a scratch file when the bridge runs from the daemon's
 * artifact cache. Two things must hold: the embedded copy never drifts from
 * the real file, and the materialized file is exactly the embedded source.
 */

const EXTENSION = fileURLToPath(new URL("../../extension/bb-tools-extension.ts", import.meta.url));

let scratchDir: string | undefined;

afterEach(() => {
  if (scratchDir !== undefined) {
    rmSync(scratchDir, { recursive: true, force: true });
    scratchDir = undefined;
  }
});

describe("the embedded companion extension source", () => {
  it("is byte-identical to extension/bb-tools-extension.ts", () => {
    expect(BB_TOOLS_EXTENSION_SOURCE).toBe(readFileSync(EXTENSION, "utf8"));
  });

  it("materializes to a scratch file with exactly the embedded content", () => {
    scratchDir = mkdtempSync(join(tmpdir(), "bbpa-embedded-"));
    const path = materializedExtensionPath(scratchDir);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(BB_TOOLS_EXTENSION_SOURCE);
  });

  it("replaces a stale or corrupted scratch file on the next materialization", () => {
    scratchDir = mkdtempSync(join(tmpdir(), "bbpa-embedded-"));
    const path = materializedExtensionPath(scratchDir);
    writeFileSync(path, "// stale content from an older plugin version\n");
    expect(materializedExtensionPath(scratchDir)).toBe(path);
    expect(readFileSync(path, "utf8")).toBe(BB_TOOLS_EXTENSION_SOURCE);
  });

  it("reuses the file untouched when the content already matches", () => {
    scratchDir = mkdtempSync(join(tmpdir(), "bbpa-embedded-"));
    const path = materializedExtensionPath(scratchDir);
    const before = readFileSync(path, "utf8");
    const bytesBefore = readFileSync(path).byteLength;
    expect(materializedExtensionPath(scratchDir)).toBe(path);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(readFileSync(path).byteLength).toBe(bytesBefore);
  });
});

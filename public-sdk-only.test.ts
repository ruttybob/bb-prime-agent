import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { experimental_scanPublicSdkOnly as scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";

const scan = scanPublicSdkOnly(dirname(fileURLToPath(import.meta.url)), {
  // vitest.config.ts imports the runner's own module — test tooling, not
  // plugin runtime surface. scripts/package-recording.mjs imports the SDK's
  // public provider-bridge TESTING subpath — dev tooling for re-pinning the
  // recorded parity lane, published as part of the SDK surface.
  allow: [/^vitest\/config$/u, /^@get-bb\/plugin-sdk\/provider-bridge\/testing$/u],
});

describe("the prime-agent plugin imports only the public SDK", () => {
  it("scans the plugin's source files", () => {
    expect(scan.files).toContain("server.ts");
    expect(scan.files).toContain("host.ts");
    expect(scan.files).toContain(join("src", "provider-bridge.ts"));
    expect(scan.files).toContain(join("src", "declaration.ts"));
    expect(scan.files).toContain(join("src", "daemon", "client.ts"));
    expect(scan.files).toContain(join("src", "daemon", "protocol.ts"));
    expect(scan.files).toContain(join("src", "daemon", "probe.ts"));
  });

  it("has no @bb/* import and stays inside the allowlist", () => {
    expect(scan.violations).toEqual([]);
  });

  it("declares no @bb/* dependency in package.json", () => {
    expect(scan.privateDependencies).toEqual([]);
  });
});

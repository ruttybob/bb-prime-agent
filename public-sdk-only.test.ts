import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { experimental_scanPublicSdkOnly as scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";

const scan = scanPublicSdkOnly(dirname(fileURLToPath(import.meta.url)), {
  // vitest.config.ts imports the runner's own module — test tooling, not
  // plugin runtime surface. scripts/package-recording.mjs and
  // scripts/live-smoke.ts import the SDK's public TESTING subpaths — dev
  // tooling (re-pinning the recorded parity lane; the bbpa-ggf.14 live smoke),
  // published as part of the SDK surface. React is the host's own runtime slot
  // (shimmed by `bb plugin build`, never bundled); the testing library and
  // jsdom are test-only.
  allow: [
    /^vitest\/config$/u,
    /^@get-bb\/plugin-sdk\/provider-bridge\/testing$/u,
    /^@get-bb\/plugin-sdk\/testing(\/|$)/u,
    /^react(\/|$)/u,
    /^react-dom(\/|$)/u,
    /^@testing-library\//u,
    /^jsdom$/u,
  ],
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
    // Agent worktrees under .claude/ are session infrastructure of the
    // development workflow, not plugin source; the scanner itself has no
    // directory filter (it excludes only node_modules and dist).
    const violations = scan.violations.filter(
      (violation) => !violation.file.startsWith(".claude/"),
    );
    expect(violations).toEqual([]);
  });

  it("declares no @bb/* dependency in package.json", () => {
    expect(scan.privateDependencies).toEqual([]);
  });
});

import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin from "./server.js";
import { primeProviderDeclaration } from "./src/declaration.js";
import { PRIME_NO_SANDBOX_NOTICE, PRIME_PROVIDER_ID } from "./src/vocabulary.js";

function registeredDeclaration() {
  const host = createFakePluginHost({ pluginId: PRIME_PROVIDER_ID });
  plugin(host.bb);
  const declaration = host.harness.registrations.providerRegistrations.find(
    (entry) => entry.id === PRIME_PROVIDER_ID,
  );
  if (declaration === undefined) {
    throw new Error(`provider "${PRIME_PROVIDER_ID}" was not registered`);
  }
  return declaration;
}

describe("the prime-agent provider declaration", () => {
  it("registers under the plugin-derived id with the display name", () => {
    const declaration = registeredDeclaration();
    expect(declaration.id).toBe("prime-agent");
    expect(declaration.displayName).toBe("Prime Agent");
    expect(declaration.icon).toBe("./icons/prime-agent.svg");
  });

  it("is visible only when the health probe finds a daemon, and declares health", () => {
    const declaration = registeredDeclaration();
    expect(declaration.experimental_visibility).toBe("installed");
    expect(declaration.maintenance).toEqual({
      health: true,
      usage: false,
      installation: false,
    });
  });

  it("runs full-access only and carries the no-sandbox notice in its copy", () => {
    const declaration = registeredDeclaration();
    expect(declaration.capabilities.permissionModes).toEqual(["full"]);
    expect(declaration.strings?.planModeCopy).toBe(PRIME_NO_SANDBOX_NOTICE);
    expect(PRIME_NO_SANDBOX_NOTICE).toContain("without a sandbox");
  });

  it("points at the official installer and the prime sign-in flow", () => {
    const declaration = registeredDeclaration();
    expect(declaration.strings?.installUrl).toBe(
      "https://app.primeintellect.ai/prime-agent/install.sh",
    );
    expect(declaration.strings?.signInHint).toContain("`prime-agent`");
    expect(declaration.strings?.signInHint).toContain("/login");
  });

  it("declares no composer actions and prime's reasoning ladder", () => {
    const declaration = registeredDeclaration();
    expect(declaration.composerActions).toEqual([]);
    expect(declaration.reasoningLevels?.map((level) => level.id)).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(declaration.capabilities.reasoningLevels).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(declaration.capabilities.fork).toBe("none");
  });

  it("forwards the daemon socket override into the bridge process", () => {
    const declaration = registeredDeclaration();
    expect(declaration.env).toEqual({
      passthrough: ["BB_PRIME_AGENT_DAEMON_SOCKET"],
    });
  });

  it("registers our declaration with only the host's defaulting on top", () => {
    const declaration = registeredDeclaration();
    const ours = primeProviderDeclaration();
    expect(declaration.strings).toEqual(ours.strings);
    expect(declaration.capabilities).toEqual(ours.capabilities);
    expect(declaration.reasoningLevels).toEqual(ours.reasoningLevels);
    // The host fills these two defaults; neither opts us into extra surfaces.
    expect(declaration.experimental_resolvesNativeRoots).toBe(false);
    expect(declaration.models).toEqual({ scope: "workspace" });
  });
});

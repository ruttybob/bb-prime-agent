import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin from "./server.js";
import { primeProviderDeclaration } from "./src/declaration.js";
import {
  enabledExtensionsFromProviderOptions,
  EXTRA_EXTENSION_PATHS_KEY,
} from "./src/user-extensions.js";
import { PRIME_NO_SANDBOX_NOTICE, PRIME_PROVIDER_ID } from "./src/vocabulary.js";

function registeredDeclaration() {
  const declaration = registeredPlugin().provider;
  return declaration;
}

/** The fake host this plugin loaded into, with its registered provider. */
function registeredPlugin() {
  const host = createFakePluginHost({ pluginId: PRIME_PROVIDER_ID });
  plugin(host.bb);
  const provider = host.harness.registrations.providerRegistrations.find(
    (entry) => entry.id === PRIME_PROVIDER_ID,
  );
  if (provider === undefined) {
    throw new Error(`provider "${PRIME_PROVIDER_ID}" was not registered`);
  }
  return { host, provider };
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
    // bbpa-ggf.7: fork from an earlier message and rename in prime's catalog.
    expect(declaration.capabilities.fork).toBe("checkpoint");
    expect(declaration.capabilities.supportsThreadRename).toBe(true);
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

describe("the provider settings page (the extension picker)", () => {
  /** The descriptors this plugin defines, beyond the host's own. */
  function settingsDescriptors(): Record<string, { type: string } & Record<string, unknown>> {
    return registeredPlugin().host.harness.registrations.settingsDescriptors as Record<
      string,
      { type: string } & Record<string, unknown>
    >;
  }

  it("always offers the free-text escape hatch, even with nothing discovered", () => {
    const descriptors = settingsDescriptors();
    // The picker is a load-time snapshot; this field is how an extension
    // installed afterwards still makes it into new sessions.
    expect(descriptors[EXTRA_EXTENSION_PATHS_KEY]).toMatchObject({
      type: "string",
      default: "",
      experimental_multiline: true,
    });
    expect(descriptors[EXTRA_EXTENSION_PATHS_KEY]!.description).toContain(
      "Absolute paths",
    );
  });

  it("renders every discovered extension as a boolean toggle defaulting to off", () => {
    const toggles = Object.entries(settingsDescriptors()).filter(
      ([key]) => key !== EXTRA_EXTENSION_PATHS_KEY,
    );
    // This machine's own extension list; the shape is what the test pins, not
    // the count — the discovery rules are covered against fixtures elsewhere.
    for (const [key, descriptor] of toggles) {
      expect(key).toMatch(/^ext_[a-z0-9_]+_[0-9a-f]{8}$/u);
      expect(descriptor.type).toBe("boolean");
      expect(descriptor.default).toBe(false);
      expect(typeof descriptor.label).toBe("string");
      expect((descriptor.description as string).length).toBeGreaterThan(0);
    }
  });

  it("derives the toggled selection into the providerOptions the bridge reads", () => {
    // A fixture selection, independent of what this machine happens to have:
    // the same snapshot feeds the toggles and this derivation, so they cannot
    // disagree.
    const extension = {
      key: "ext_fixture_12345678",
      name: "fixture",
      path: "/tmp/prime-extensions/fixture/index.ts",
      description: "Loads from /tmp/prime-extensions/fixture/index.ts.",
      enabledInPrime: true,
    };
    const declaration = primeProviderDeclaration({ userExtensions: [extension] });

    // Everything off (the default) means an explicit empty list: discovery
    // stays off and the payload is unchanged from before the picker existed.
    expect(declaration.deriveProviderOptions?.(optionsContext({}))).toEqual({
      enabledExtensions: [],
    });
    expect(
      declaration.deriveProviderOptions?.(
        optionsContext({ [extension.key]: true, nobody_elses_key: true }),
      ),
    ).toEqual({ enabledExtensions: [extension.path] });

    // And the wire shape is exactly what the bridge's reader accepts.
    const derived = declaration.deriveProviderOptions?.(
      optionsContext({ [extension.key]: true }),
    );
    expect(enabledExtensionsFromProviderOptions(derived)).toEqual([extension.path]);
  });
});

function optionsContext(settings: Record<string, string | boolean>) {
  return {
    threadId: "thr_settings",
    projectId: "prj_settings",
    model: "zai/glm-5.3-flash",
    permissionMode: "full" as const,
    settings,
  };
}

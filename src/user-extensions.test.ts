import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PluginSettingValue } from "@get-bb/plugin-sdk";
import {
  discoverUserPrimeExtensions,
  enabledExtensionsFromProviderOptions,
  enabledExtensionsProviderOptions,
  enabledUserExtensionPaths,
  EXTRA_EXTENSION_PATHS_KEY,
  MAX_ENABLED_EXTENSIONS,
  MAX_LISTED_EXTENSIONS,
  parseExtraExtensionPaths,
  userExtensionSettingsDescriptors,
  type DiscoveredPrimeExtension,
} from "./user-extensions.js";

/**
 * The extension picker's discovery and selection rules (bbpa-ggf.12), against
 * fixture agent dirs: what lands on the settings page, and what a toggled-on
 * selection contributes to a new session's `create.config.extensions`.
 */

let agentDir: string;

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "bb-prime-extensions-"));
});

afterEach(() => {
  rmSync(agentDir, { recursive: true, force: true });
});

/** Write files/dirs relative to the fixture agent dir (`extensions/…`). */
function write(entries: Record<string, string>): void {
  for (const [relativePath, content] of Object.entries(entries)) {
    const fullPath = join(agentDir, relativePath);
    mkdirSync(join(fullPath, ".."), { recursive: true });
    writeFileSync(fullPath, content);
  }
}

function writeSettings(extensions: unknown, raw = false): void {
  write({
    "settings.json": raw
      ? (extensions as string)
      : JSON.stringify({ extensions }, null, 2),
  });
}

function discover(): ReturnType<typeof discoverUserPrimeExtensions> {
  return discoverUserPrimeExtensions({ agentDir });
}

function paths(extensions: readonly { path: string }[]): string[] {
  return extensions.map((extension) => extension.path);
}

describe("discovering user prime extensions", () => {
  it("finds extension files and extension directories, and skips everything else", () => {
    write({
      "extensions/alpha.ts": "export default () => {};",
      "extensions/beta.js": "export default () => {};",
      "extensions/gamma/index.ts": "export default () => {};",
      "extensions/delta/index.js": "export default () => {};",
      "extensions/notes.txt": "not an extension",
      "extensions/.hidden.ts": "export default () => {};",
      "extensions/node_modules/packaged.ts": "export default () => {};",
      "extensions/empty-dir/.keep": "",
    });

    expect(paths(discover())).toEqual([
      join(agentDir, "extensions/alpha.ts"),
      join(agentDir, "extensions/beta.js"),
      join(agentDir, "extensions/delta/index.js"),
      join(agentDir, "extensions/gamma/index.ts"),
    ]);
  });

  it("uses the manifest name and description when the extension ships one", () => {
    write({
      "extensions/auto-title/index.ts": "export default () => {};",
      "extensions/auto-title/package.json": JSON.stringify({
        name: "prime-auto-title",
        description: "Names sessions after their first message.",
      }),
    });

    const [extension] = discover();
    expect(extension?.name).toBe("prime-auto-title");
    expect(extension?.description).toContain(
      "Names sessions after their first message.",
    );
    expect(extension?.description).toContain(
      `Loads from ${join(agentDir, "extensions/auto-title/index.ts")}.`,
    );
    expect(extension?.key).toMatch(/^ext_prime_auto_title_[0-9a-f]{8}$/u);
  });

  it("falls back to the extension's own file name for the label", () => {
    write({ "extensions/tps.ts": "export default () => {};" });
    const [extension] = discover();
    expect(extension?.name).toBe("tps");
    // An extension directory contributes its index file; the directory is its name.
    write({ "extensions/whole/index.js": "export default () => {};" });
    const [whole] = discoverUserPrimeExtensions({ agentDir }).filter(
      (extension) => extension.name === "whole",
    );
    expect(whole?.path).toBe(join(agentDir, "extensions/whole/index.js"));
  });

  it("resolves settings.json entries against the agent dir and dedupes them with the scan", () => {
    write({
      "extensions/tps/index.ts": "export default () => {};",
      // A settings entry may also point anywhere on disk, outside the scan.
      "elsewhere/extra.ts": "export default () => {};",
    });
    writeSettings([
      "+extensions/tps/index.ts",
      join(agentDir, "elsewhere/extra.ts"),
    ]);

    const found = discover();
    expect(paths(found)).toEqual([
      join(agentDir, "elsewhere/extra.ts"),
      join(agentDir, "extensions/tps/index.ts"),
    ]);
    // The `+` entry describes the same extension the scan found: one toggle.
    expect(found.every((extension) => extension.enabledInPrime)).toBe(true);
  });

  it("never lists a settings entry that does not exist on disk", () => {
    writeSettings(["extensions/ghost.ts"]);
    expect(discover()).toEqual([]);
  });

  it("reports prime's own disabled state without changing what bb may load", () => {
    write({ "extensions/tps/index.ts": "export default () => {};" });
    writeSettings(["-extensions/tps/index.ts"]);

    const [extension] = discover();
    expect(extension?.enabledInPrime).toBe(false);
    expect(extension?.description).toContain(
      "prime-agent itself has this extension disabled.",
    );
  });

  it("expands a settings entry pointing at an extension directory to its file", () => {
    write({ "extensions/whole/index.ts": "export default () => {};" });
    writeSettings(["extensions/whole"]);

    // One concrete path, not the directory plus its index: prime would load
    // the extension twice if both were handed to `create.config.extensions`.
    expect(paths(discover())).toEqual([
      join(agentDir, "extensions/whole/index.ts"),
    ]);
  });

  it("honours a manifest's pi.extensions list for an extension package directory", () => {
    write({
      "extensions/pack/main.ts": "export default () => {};",
      "extensions/pack/second.ts": "export default () => {};",
      "extensions/pack/package.json": JSON.stringify({
        pi: { extensions: ["main.ts", "second.ts"] },
      }),
    });

    expect(paths(discover())).toEqual([
      join(agentDir, "extensions/pack/main.ts"),
      join(agentDir, "extensions/pack/second.ts"),
    ]);
  });

  it("tolerates a missing extensions dir, a missing settings file, and unparsable settings", () => {
    expect(discover()).toEqual([]);

    write({ "extensions/only.ts": "export default () => {};" });
    expect(paths(discover())).toEqual([join(agentDir, "extensions/only.ts")]);

    writeSettings("{ not json", true);
    expect(paths(discover())).toEqual([join(agentDir, "extensions/only.ts")]);
  });

  it("derives stable, distinct, settings-legal keys from the paths", () => {
    write({
      "extensions/alpha/index.ts": "export default () => {};",
      "extensions/beta/index.ts": "export default () => {};",
    });

    const first = discover();
    const second = discover();
    expect(paths(first)).toEqual(paths(second));
    expect(first.map((extension) => extension.key)).toEqual(
      second.map((extension) => extension.key),
    );
    expect(new Set(first.map((extension) => extension.key)).size).toBe(2);
    for (const extension of first) {
      expect(extension.key).toMatch(/^[a-zA-Z0-9_-]+$/u);
    }
  });

  it("caps how many extensions the settings page lists", () => {
    const entries: Record<string, string> = {};
    for (let index = 0; index < MAX_LISTED_EXTENSIONS + 5; index += 1) {
      entries[`extensions/ext-${index}.ts`] = "export default () => {};";
    }
    write(entries);

    expect(discover().length).toBe(MAX_LISTED_EXTENSIONS);
  });
});

describe("the provider settings descriptors", () => {
  it("offers one off-by-default toggle per extension plus the free-text escape hatch", () => {
    write({ "extensions/tps.ts": "export default () => {};" });
    const descriptors = userExtensionSettingsDescriptors(discover());

    expect(descriptors[EXTRA_EXTENSION_PATHS_KEY]).toMatchObject({
      type: "string",
      default: "",
      experimental_multiline: true,
    });
    const toggles = Object.entries(descriptors).filter(
      ([key]) => key !== EXTRA_EXTENSION_PATHS_KEY,
    );
    expect(toggles.length).toBe(1);
    const [key, descriptor] = toggles[0]!;
    expect(key).toMatch(/^ext_tps_[0-9a-f]{8}$/u);
    expect(descriptor).toMatchObject({ type: "boolean", label: "tps", default: false });
  });

  it("keeps a usable settings page even when nothing is discovered", () => {
    const descriptors = userExtensionSettingsDescriptors([]);
    expect(Object.keys(descriptors)).toEqual([EXTRA_EXTENSION_PATHS_KEY]);
  });
});

describe("turning the selection into extension paths", () => {
  /** Two fixture finds, as discovery would describe them. */
  const extensions: DiscoveredPrimeExtension[] = [
    {
      key: "ext_alpha_11111111",
      name: "alpha",
      path: "/opt/ext/alpha.ts",
      description: "Loads from /opt/ext/alpha.ts.",
      enabledInPrime: true,
    },
    {
      key: "ext_beta_22222222",
      name: "beta",
      path: "/opt/ext/beta/index.ts",
      description: "Loads from /opt/ext/beta/index.ts.",
      enabledInPrime: true,
    },
  ];

  function enabled(
    values: Record<string, PluginSettingValue | undefined>,
  ): string[] {
    return enabledUserExtensionPaths({ extensions, values });
  }

  it("loads only what is toggled on, in discovery order", () => {
    expect(enabled({})).toEqual([]);
    expect(enabled({ ext_alpha_11111111: true })).toEqual(["/opt/ext/alpha.ts"]);
    expect(
      enabled({ ext_alpha_11111111: false, ext_beta_22222222: true }),
    ).toEqual(["/opt/ext/beta/index.ts"]);
    // A key nothing discovered claims cannot enable anything.
    expect(enabled({ ext_ghost_99999999: true })).toEqual([]);
  });

  it("appends the free-text paths and never loads one extension twice", () => {
    expect(
      enabled({
        ext_beta_22222222: true,
        [EXTRA_EXTENSION_PATHS_KEY]: [
          "# toggled extensions win their position",
          "/opt/ext/alpha.ts",
          "",
          "~/home-ext.ts",
          "relative/ext.ts",
        ].join("\n"),
      }),
    ).toEqual(["/opt/ext/beta/index.ts", "/opt/ext/alpha.ts", join(homedir(), "home-ext.ts")]);
  });

  it("parses the free-text setting line by line", () => {
    expect(parseExtraExtensionPaths(undefined)).toEqual([]);
    expect(parseExtraExtensionPaths("")).toEqual([]);
    // A boolean is a legal settings value, just not one this setting can hold.
    expect(parseExtraExtensionPaths(true)).toEqual([]);
    expect(
      parseExtraExtensionPaths(
        ["  /opt/a.ts  ", "# comment", "", "~", "~/b.ts", "c.ts"].join("\n"),
      ),
    ).toEqual(["/opt/a.ts", homedir(), join(homedir(), "b.ts")]);
  });
});

describe("the providerOptions handoff to the bridge", () => {
  it("round-trips the selection", () => {
    const options = enabledExtensionsProviderOptions(["/opt/a.ts", "/opt/b.ts"]);
    expect(options).toEqual({ enabledExtensions: ["/opt/a.ts", "/opt/b.ts"] });
    expect(enabledExtensionsFromProviderOptions(options)).toEqual([
      "/opt/a.ts",
      "/opt/b.ts",
    ]);
  });

  it("degrades to no extensions on unusable provider options", () => {
    expect(enabledExtensionsFromProviderOptions(undefined)).toEqual([]);
    expect(enabledExtensionsFromProviderOptions("nope")).toEqual([]);
    expect(enabledExtensionsFromProviderOptions({})).toEqual([]);
    expect(enabledExtensionsFromProviderOptions({ enabledExtensions: "one" })).toEqual([]);
    expect(
      enabledExtensionsFromProviderOptions({
        enabledExtensions: [
          "/opt/a.ts",
          42,
          null,
          "  ",
          "relative.ts",
          "/opt/../opt/a.ts",
          "/opt/b.ts",
        ],
      }),
    ).toEqual(["/opt/a.ts", "/opt/b.ts"]);
  });

  it("caps how many extensions one session may load", () => {
    const many = Array.from(
      { length: MAX_ENABLED_EXTENSIONS + 10 },
      (_, index) => `/opt/ext-${index}.ts`,
    );
    expect(
      enabledExtensionsFromProviderOptions({ enabledExtensions: many }).length,
    ).toBe(MAX_ENABLED_EXTENSIONS);
  });
});

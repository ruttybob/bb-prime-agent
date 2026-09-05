import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type {
  PluginSettingDescriptor,
  PluginSettingDescriptors,
  PluginSettingValue,
} from "@get-bb/plugin-sdk";
import { primeAgentDir } from "./session-params.js";

/**
 * The extension picker (bbpa-ggf.12): which user prime-agent extensions a new
 * bb session loads.
 *
 * prime-agent's own extension discovery stays OFF in bb sessions
 * (`create.config.noExtensions`, `src/session-params.ts`) — code enters a bb
 * session only through paths bb states explicitly. This module is the control
 * surface for that: it scans the user-level sources prime itself would scan
 * (`~/.prime/agent/extensions/` plus the `extensions` array in
 * `~/.prime/agent/settings.json`), describes each find as a boolean settings
 * toggle, and turns the toggled-on selection into the absolute paths the bridge
 * appends to `create.config.extensions` — the daemon's `-e` form, which loads
 * even under `noExtensions: true` (`resource-loader.js` keeps only the CLI
 * paths when discovery is off).
 *
 * Deliberate limits, each with a reason:
 * - Discovery is a snapshot taken when the plugin server loads. Settings
 *   descriptors are plain data so the host can render them without executing
 *   plugin code, so the list cannot be re-scanned per render; an extension
 *   installed later appears when bb reloads the plugin — and, without waiting
 *   for that, through the free-text "additional paths" setting, which is read
 *   when a session starts. Project-local extensions (`.prime/agent/extensions/`
 *   under a workspace) are not listed at all: the settings page has no cwd to
 *   scan against, and a per-project list does not belong in provider settings.
 * - Everything defaults to false. The default stays discovery-off (the intent's
 *   trust posture: prime extensions run with full user permissions), so a
 *   session loads exactly what the user asked for and nothing else.
 * - Paths must be absolute. prime resolves relative `create.config.extensions`
 *   entries against its worker's own cwd, not the session's, so a relative path
 *   would silently mean "whatever directory the daemon happens to run in".
 */

/** One user prime-agent extension the picker can load into new bb sessions. */
export interface DiscoveredPrimeExtension {
  /**
   * Stable settings key for this extension, derived from its absolute path:
   * the user's toggles survive plugin reloads and bb restarts because the same
   * path always produces the same key.
   */
  readonly key: string;
  /** The toggle's label — the extension's manifest name, else its file name. */
  readonly name: string;
  /** Absolute path — the exact value `create.config.extensions` expects. */
  readonly path: string;
  /** The toggle's description: manifest summary, load path, prime-side state. */
  readonly description: string;
  /**
   * Whether prime-agent's own settings leave the extension enabled for its own
   * sessions (`+` entry) or disabled (`-` entry). Informational only: the bb
   * toggle decides what bb sessions load.
   */
  readonly enabledInPrime: boolean;
}

/**
 * How many extensions the picker lists. A bound, not a judgement: settings
 * pages render one descriptor each, and the free-text escape hatch still loads
 * whatever else the user names explicitly.
 */
export const MAX_LISTED_EXTENSIONS = 64;

/**
 * Upper bound on extensions one bb session loads. Defence, not policy — the
 * daemon sets no cap — but a corrupted settings value should not be able to
 * hand the session an unbounded `-e` list.
 */
export const MAX_ENABLED_EXTENSIONS = 32;

/** The `options.providerOptions` key the picker's selection rides into the bridge. */
export const ENABLED_EXTENSIONS_OPTION = "enabledExtensions";

/**
 * The free-text escape-hatch setting: absolute paths loaded in addition to the
 * toggles. It is what keeps the picker honest between plugin reloads — an
 * extension installed after the snapshot can still be loaded by typing its path.
 */
export const EXTRA_EXTENSION_PATHS_KEY = "extraExtensionPaths";

/**
 * The extension files prime loads, per `collectAutoExtensionEntries`
 * (`prime-agent/dist/core/package-manager.js`): `*.ts`/`*.js` files, plus one
 * entry per extension directory (its manifest's `pi.extensions` list, else its
 * `index.ts`/`index.js`).
 */
const EXTENSION_FILE = /\.(ts|js)$/u;

/** The extension index files prime looks for inside an extension directory. */
const EXTENSION_INDEX_FILES = ["index.ts", "index.js"] as const;

/**
 * Scan the user-level extension sources for the agent dir (default: prime's own
 * `~/.prime/agent`). Tolerates a missing extensions dir, a missing settings
 * file, and unparsable JSON — a machine without prime must still get an empty
 * picker rather than a broken plugin, and a half-written settings file must not
 * take the settings page down.
 */
export function discoverUserPrimeExtensions(
  args: { agentDir?: string } = {},
): readonly DiscoveredPrimeExtension[] {
  const agentDir = resolve(args.agentDir ?? primeAgentDir());
  const sources = new Map<string, ExtensionSource>();

  // Directory scan first, settings entries second: a `+` entry for a discovered
  // extension must not duplicate it, and a `-` entry must be able to flip the
  // state of something the scan already found.
  for (const source of scanExtensionsDir(join(agentDir, "extensions"))) {
    sources.set(source.path, source);
  }
  for (const entry of readSettingsExtensionEntries(agentDir)) {
    const existing = sources.get(entry.path);
    if (existing === undefined) {
      if (entry.enabled) {
        sources.set(entry.path, { path: entry.path, enabledInPrime: true });
      }
      continue;
    }
    sources.set(entry.path, { ...existing, enabledInPrime: entry.enabled });
  }

  const ordered = [...sources.values()].sort((a, b) => a.path.localeCompare(b.path));
  return ordered
    .slice(0, MAX_LISTED_EXTENSIONS)
    .map((source) => describeExtension(source, agentDir));
}

/**
 * The provider settings page: one multiline escape hatch (always present, so
 * the page exists even on a machine with no prime extensions) plus one toggle
 * per discovered extension, all defaulting to off.
 */
export function userExtensionSettingsDescriptors(
  extensions: readonly DiscoveredPrimeExtension[],
): PluginSettingDescriptors {
  const toggles = Object.fromEntries(
    extensions.map((extension): [string, PluginSettingDescriptor] => [
      extension.key,
      {
        type: "boolean",
        label: extension.name,
        description: extension.description,
        // The default stays discovery-off: nothing loads until the user asks.
        default: false,
      },
    ]),
  );
  return {
    [EXTRA_EXTENSION_PATHS_KEY]: {
      type: "string",
      label: "Additional extension paths",
      description:
        "Absolute paths of prime-agent extensions to load into new bb sessions, one per line " +
        "(# starts a comment line). Read when a session starts, so it covers extensions " +
        "installed after this page was rendered; the toggles below refresh when bb reloads the plugin.",
      default: "",
      experimental_multiline: true,
    },
    ...toggles,
  };
}

/**
 * The enabled selection: the toggled-on extensions (discovery order), then the
 * free-text paths, deduplicated — a user who types a path that is also toggled
 * on must not load that extension twice (prime would register its tools twice).
 */
export function enabledUserExtensionPaths(args: {
  extensions: readonly DiscoveredPrimeExtension[];
  values: Readonly<Record<string, PluginSettingValue | undefined>>;
}): string[] {
  const toggled = args.extensions
    .filter((extension) => args.values[extension.key] === true)
    .map((extension) => extension.path);
  return dedupePreservingOrder([
    ...toggled,
    ...parseExtraExtensionPaths(args.values[EXTRA_EXTENSION_PATHS_KEY]),
  ]);
}

/**
 * The free-text setting's lines → absolute paths. Blank lines and `#` comments
 * are skipped; `~` expands to the home directory; relative entries are dropped
 * (see the module docs for why bb never sends prime a relative extension path).
 */
export function parseExtraExtensionPaths(
  value: PluginSettingValue | undefined,
): string[] {
  if (typeof value !== "string") {
    return [];
  }
  const paths: string[] = [];
  for (const line of value.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    const absolute = absoluteExtensionPath(trimmed);
    if (absolute !== undefined) {
      paths.push(absolute);
    }
  }
  return paths;
}

/**
 * The bridge-side `create.config` payload the picker contributes, wrapped under
 * its providerOptions key. `deriveProviderOptions` builds exactly this, so the
 * producer and the bridge's reader cannot drift apart.
 */
export function enabledExtensionsProviderOptions(
  paths: readonly string[],
): Record<string, string[]> {
  return { [ENABLED_EXTENSIONS_OPTION]: [...paths] };
}

/**
 * Read the selection back out of a command's `options.providerOptions`.
 *
 * Defensive by design: the field is host-supplied JSON of type
 * `Record<string, unknown>`, and the daemon would happily take a relative path
 * and resolve it against the wrong directory. Anything that is not an absolute
 * path string is dropped, duplicates collapse, and the list is capped — a bad
 * value degrades to "no user extensions", never to a broken session.
 */
export function enabledExtensionsFromProviderOptions(
  options: unknown,
): string[] {
  if (typeof options !== "object" || options === null) {
    return [];
  }
  const value = (options as Record<string, unknown>)[ENABLED_EXTENSIONS_OPTION];
  if (!Array.isArray(value)) {
    return [];
  }
  const paths: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }
    const absolute = absoluteExtensionPath(entry.trim());
    if (absolute === undefined || paths.includes(absolute)) {
      continue;
    }
    paths.push(absolute);
    if (paths.length >= MAX_ENABLED_EXTENSIONS) {
      break;
    }
  }
  return paths;
}

/** An extension find, before it is described for the settings page. */
interface ExtensionSource {
  /** Absolute path of the extension file prime would load. */
  readonly path: string;
  /** Whether prime's own settings leave it enabled. */
  readonly enabledInPrime: boolean;
}

/** One `extensions` entry from `settings.json`, resolved and expanded. */
interface SettingsExtensionEntry {
  readonly path: string;
  readonly enabled: boolean;
}

/**
 * The extensions directory scan, mirroring prime's
 * `collectAutoExtensionEntries`: the directory may itself be one extension
 * package; otherwise every `*.ts`/`*.js` file and every extension subdirectory
 * is a find. Dotfiles and `node_modules` are skipped, as prime does; prime's
 * additional ignore-file rules are not replicated — an ignored extension still
 * shows up here, and the user simply leaves its toggle off.
 */
function scanExtensionsDir(extensionsDir: string): ExtensionSource[] {
  if (!existsSync(extensionsDir)) {
    return [];
  }
  const packageEntries = resolveExtensionPackageEntries(extensionsDir);
  if (packageEntries !== undefined) {
    return packageEntries.map((path) => ({ path, enabledInPrime: true }));
  }
  const sources: ExtensionSource[] = [];
  const entries = readdirSync(extensionsDir, { withFileTypes: true }).sort(
    (a, b) => a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") {
      continue;
    }
    const fullPath = join(extensionsDir, entry.name);
    const kind = entryKind(fullPath, entry.isDirectory(), entry.isFile());
    if (kind === "file" && EXTENSION_FILE.test(entry.name)) {
      sources.push({ path: fullPath, enabledInPrime: true });
    } else if (kind === "directory") {
      for (const path of resolveExtensionPackageEntries(fullPath) ?? []) {
        sources.push({ path, enabledInPrime: true });
      }
    }
  }
  return sources;
}

/**
 * The `extensions` array of the agent dir's `settings.json`. Entries are
 * resolved against the agent dir (prime resolves them against the same base),
 * `+`/`-` prefixes carry prime's own enable state, and directories expand to
 * their concrete extension files so the list never contains both a directory
 * and its `index.ts` — prime would load that extension twice.
 */
function readSettingsExtensionEntries(
  agentDir: string,
): SettingsExtensionEntry[] {
  const settings = readJsonFile(join(agentDir, "settings.json"));
  const entries = isJsonObject(settings) ? settings.extensions : undefined;
  if (!Array.isArray(entries)) {
    return [];
  }
  const resolved: SettingsExtensionEntry[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string") {
      continue;
    }
    const trimmed = entry.trim();
    const forceExclude = trimmed.startsWith("-");
    const unprefixed = forceExclude || trimmed.startsWith("+") ? trimmed.slice(1) : trimmed;
    const pattern = unprefixed.trim();
    if (pattern === "") {
      continue;
    }
    const target = resolveFrom(pattern, agentDir);
    for (const path of expandExtensionTarget(target)) {
      resolved.push({ path, enabled: !forceExclude });
    }
  }
  return resolved;
}

/**
 * What an extension path contributes when loaded: itself when it is an
 * extension file, its concrete entries when it is an extension directory,
 * nothing when it does not exist or is neither (prime's loader skips it too).
 */
function expandExtensionTarget(target: string): string[] {
  if (!existsSync(target)) {
    return [];
  }
  const kind = entryKind(target, false, false);
  if (kind === "file") {
    return EXTENSION_FILE.test(target) ? [target] : [];
  }
  if (kind === "directory") {
    return resolveExtensionPackageEntries(target) ?? [];
  }
  return [];
}

/**
 * prime's `resolveExtensionEntries`: a directory is an extension package when
 * its `package.json` lists `pi.extensions` paths, else when it has an
 * `index.ts`/`index.js`. `undefined` = not an extension package (fall through
 * to the directory scan).
 */
function resolveExtensionPackageEntries(dir: string): string[] | undefined {
  const manifest = readJsonFile(join(dir, "package.json"));
  const declared = isJsonObject(manifest) && isJsonObject(manifest.pi)
    ? manifest.pi.extensions
    : undefined;
  if (Array.isArray(declared)) {
    const entries = declared
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => resolve(dir, entry))
      .filter((entry) => existsSync(entry));
    if (entries.length > 0) {
      return entries;
    }
  }
  for (const index of EXTENSION_INDEX_FILES) {
    const candidate = join(dir, index);
    if (existsSync(candidate)) {
      return [candidate];
    }
  }
  return undefined;
}

/**
 * Whether a path is an extension file or an extension directory, judged through
 * `statSync` so a symlinked extension resolves like prime's own scan. When the
 * stat itself fails (a dangling symlink), the directory entry's own claim is
 * the best left — a later read of it is guarded anyway.
 */
function entryKind(
  path: string,
  isDirectory: boolean,
  isFile: boolean,
): "file" | "directory" | undefined {
  try {
    const stats = statSync(path);
    if (stats.isDirectory()) {
      return "directory";
    }
    if (stats.isFile()) {
      return "file";
    }
    return undefined;
  } catch {
    return isDirectory ? "directory" : isFile ? "file" : undefined;
  }
}

/** The settings-page view of one find: name, load path, prime-side state. */
function describeExtension(
  source: ExtensionSource,
  agentDir: string,
): DiscoveredPrimeExtension {
  const manifest = readJsonFile(join(dirname(source.path), "package.json"));
  const name =
    isJsonObject(manifest) && typeof manifest.name === "string" && manifest.name.trim() !== ""
      ? manifest.name.trim()
      : defaultExtensionName(source.path);
  const summary =
    isJsonObject(manifest) && typeof manifest.description === "string"
      ? manifest.description.trim()
      : "";
  const description = [
    ...(summary === "" ? [] : [summary]),
    `Loads from ${displayPath(source.path)}.`,
    ...(source.enabledInPrime
      ? []
      : ["prime-agent itself has this extension disabled."]),
  ].join(" ");
  return {
    key: settingsKeyFor(source.path, name),
    name,
    path: source.path,
    description,
    enabledInPrime: source.enabledInPrime,
  };
}

/** The toggle's fallback label: the extension's own file or directory name. */
function defaultExtensionName(path: string): string {
  const stem = basename(path).replace(EXTENSION_FILE, "");
  // An extension directory contributes `index.ts`; the directory is its name.
  return stem === "index" ? basename(dirname(path)) : stem;
}

/**
 * The stable settings key: a readable slug plus a short digest of the absolute
 * path. Two different extensions with the same file name (two `index.ts` under
 * different directories) must not share a key, and the same path must keep the
 * user's toggle across reloads.
 */
function settingsKeyFor(path: string, name: string): string {
  const slug =
    name
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/gu, "_")
      .replace(/^_+|_+$/gu, "") || "extension";
  const digest = createHash("sha256").update(path).digest("hex").slice(0, 8);
  return `ext_${slug}_${digest}`;
}

/** Paths in the copy are user-readable: `~/…` under home, absolute otherwise. */
function displayPath(path: string): string {
  const home = homedir();
  if (path === home || path.startsWith(`${home}/`)) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}

/** Absolute, `~`-expanded, lexically normal — or nothing, for relative input. */
function absoluteExtensionPath(path: string): string | undefined {
  const expanded =
    path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
  return isAbsolute(expanded) ? resolve(expanded) : undefined;
}

function resolveFrom(path: string, baseDir: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(baseDir, path);
}

function readJsonFile(path: string): unknown {
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as unknown;
  } catch {
    return undefined;
  }
}

/** True when the value is a JSON object (arrays are not objects here). */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dedupePreservingOrder(paths: readonly string[]): string[] {
  return [...new Set(paths)];
}

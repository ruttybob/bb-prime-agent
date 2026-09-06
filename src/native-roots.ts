import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  experimental_filterResolvedNativeRoots,
  type ExperimentalNativeRootsResolveAnswer,
} from "@get-bb/plugin-sdk/host";
import { primeAgentDir, primeProjectAgentDir } from "./session-params.js";
import {
  materializePrimeSessionCommandFiles,
  primeSessionCommandRoots,
  primeSessionCommandsDir,
  type PrimeSessionCommandRoot,
} from "./session-commands.js";

/**
 * The host-resolved half of prime-agent's native roots (bbpa-ggf.8):
 * what only this host can name — the `skills` arrays of prime's user and
 * project `settings.json`, plus the loose top-level `*.md` skill files prime
 * discovers inside its two default skill directories, and — since bbpa-b1m.1
 * — prime's session slash commands, materialized one `command-file` per
 * command by `./session-commands.ts`. bb scans the answer beside the declared
 * roots (`./native-roots-declaration.ts` holds the fixed directories) for the
 * composer "/" menu; invoking an entry is the prompt path
 * (`src/skill-mentions.ts`) — prime expands `/skill:<name>` in the session
 * itself, so nothing here needs to reach the daemon's `create`.
 *
 * This module value-imports `@get-bb/plugin-sdk/host` lawfully: it is
 * reachable only from the `bb.host` graph (`host.ts`), where the builder
 * inlines the SDK from the plugin's own install. It must stay out of the
 * server graph — there bb reloads the entry through jiti, where SDK subpaths
 * resolve into the one-file runtime shim and die (bbpa-cry, guarded by
 * `server-entry-graph.test.ts`).
 *
 * Two deliberate divergences from pi's resolver, both because bb pins prime's
 * agent dir (`buildPrimeCreateCommand.config.agentDir`):
 * - `PRIME_AGENT_CODING_AGENT_DIR` is ignored. A moved agent dir is where
 *   *prime's own* sessions read config; a bb session always reads the pinned
 *   default, so listing a moved dir's skills would advertise entries the
 *   session cannot resolve.
 * - The user settings file is read from that same pinned default
 *   (`~/.prime/agent/settings.json`), not from a probed agent dir.
 *
 * One known gap, accepted: bb's scanner names skills after their directory and
 * only reads `SKILL.md` frontmatter for the description, so a skill whose
 * frontmatter name differs from its directory name is listed (and invoked)
 * under the directory name — prime itself only warns about that mismatch.
 */

export interface ResolvePrimeNativeRootsArgs {
  /** The host user's home directory. */
  homeDir: string;
  /**
   * The workspace, or null when bb lists without one: the project settings
   * file, the project skills root, and its loose skill files count only for
   * the workspace that holds them.
   */
  cwd: string | null;
}

/**
 * How many loose `*.md` skill files one default skills directory contributes.
 * A bound, not a judgement: prime itself caps nothing, and each file becomes
 * its own root in bb's set.
 */
export const MAX_LOOSE_SKILL_FILES_PER_ROOT = 64;

/**
 * The host-resolved half of prime's skill roots: everything beyond the fixed
 * declared directories. Tolerates a missing settings file, unparsable JSON,
 * and missing directories — a machine without prime must answer an empty
 * roots set, not an error, because a resolver throw costs the user the whole
 * resolved answer for that listing.
 */
export function resolvePrimeNativeRoots(
  args: ResolvePrimeNativeRootsArgs,
): ExperimentalNativeRootsResolveAnswer {
  const agentDir = primeAgentDir(args.homeDir);
  const roots: ResolvedSkillRoot[] = [];
  const seen = new Set<string>();

  // User settings entries (`~/.prime/agent/settings.json` `skills`), then the
  // project settings' own entries, then the loose top-level skill files of the
  // two default directories. Fixed order, deduplicated by path: the same
  // directory named twice must not become two roots.
  for (const entry of settingsSkillEntries(
    join(agentDir, "settings.json"),
    agentDir,
    args.homeDir,
  )) {
    pushRoots(roots, seen, skillRootsForTarget(entry, "user"));
  }
  if (args.cwd !== null) {
    const projectAgentDir = primeProjectAgentDir(args.cwd);
    for (const entry of settingsSkillEntries(
      join(projectAgentDir, "settings.json"),
      projectAgentDir,
      args.homeDir,
    )) {
      pushRoots(roots, seen, skillRootsForTarget(entry, "project"));
    }
    pushRoots(
      roots,
      seen,
      looseSkillFileRoots(join(projectAgentDir, "skills"), "project"),
    );
  }
  pushRoots(roots, seen, looseSkillFileRoots(join(agentDir, "skills"), "user"));

  // The session commands (bbpa-b1m.1): materialized one `.md` per command
  // into the shared per-uid temp dir and answered as `command-file` roots, so
  // the "/" menu lists them beside the skills. A materialization failure (a
  // read-only temp, say) must not cost the skills answer — the resolver
  // contract charges a throw against the whole listing — so the commands
  // side degrades to empty with a warning.
  let commandRoots: PrimeSessionCommandRoot[] = [];
  try {
    const commandsDir = primeSessionCommandsDir();
    materializePrimeSessionCommandFiles(commandsDir);
    commandRoots = primeSessionCommandRoots(commandsDir);
  } catch (error) {
    console.warn(
      `prime-agent: could not materialize session command files: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  // One root the contract refuses must not cost the user the others: each is
  // judged on its own, and the refused ones are dropped with a warning.
  return experimental_filterResolvedNativeRoots(
    { skills: roots, commands: commandRoots },
    { warn: console.warn },
  ).answer;
}

/** One resolved root, in the form the host contract's answer takes. */
type ResolvedSkillRoot = NonNullable<
  ExperimentalNativeRootsResolveAnswer["skills"]
>[number];

function pushRoots(
  roots: ResolvedSkillRoot[],
  seen: Set<string>,
  additions: readonly ResolvedSkillRoot[],
): void {
  for (const root of additions) {
    if (seen.has(root.path)) {
      continue;
    }
    seen.add(root.path);
    roots.push(root);
  }
}

/** A `skills` entry from `settings.json`, resolved the way prime resolves it. */
interface SettingsSkillEntry {
  readonly path: string;
}

/**
 * The plain directory/file entries of a settings file's `skills` array — the
 * entries prime turns into skill sources (`resolveLocalEntries` +
 * `resolvePathFromBase`). Override patterns (`!`/`+`/`-` prefixed — prime's
 * enable/disable overrides), glob entries, and non-path sources
 * (`npm:`/`git:`/…) are not roots and are skipped; `~` expands against the
 * home directory and relative entries resolve against the settings file's own
 * base dir (the agent dir that holds the file).
 */
function settingsSkillEntries(
  settingsPath: string,
  baseDir: string,
  homeDir: string,
): SettingsSkillEntry[] {
  const settings = readJsonFile(settingsPath);
  const entries = isJsonObject(settings) ? settings.skills : undefined;
  if (!Array.isArray(entries)) {
    return [];
  }
  const resolved: SettingsSkillEntry[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string") {
      continue;
    }
    const trimmed = entry.trim();
    if (!isPlainSkillSource(trimmed)) {
      continue;
    }
    resolved.push({ path: resolveFrom(trimmed, baseDir, homeDir) });
  }
  return resolved;
}

function isPlainSkillSource(value: string): boolean {
  return (
    value !== "" &&
    !/^[!+-]/u.test(value) &&
    !value.includes("*") &&
    !value.includes("?") &&
    !/^(?:npm:|git:|https?:\/\/|git@)/u.test(value)
  );
}

/**
 * The bb roots one resolved settings entry contributes, judged the way prime's
 * loader would load it:
 * - a directory holding `SKILL.md` is that one skill (`shape: "skill"`);
 * - any other directory is a skills directory (`shape: "skills"`), and its
 *   loose top-level `*.md` files join it the way prime's `includeRootFiles`
 *   discovers them;
 * - a `*.md` file is one file-backed skill (`shape: "skill-file"`);
 * - anything else (missing, not markdown) contributes nothing — prime skips it
 *   with a warning too.
 */
function skillRootsForTarget(
  entry: SettingsSkillEntry,
  origin: "user" | "project",
): ResolvedSkillRoot[] {
  const kind = entryKind(entry.path);
  if (kind === undefined) {
    return [];
  }
  if (kind === "file") {
    return entry.path.toLowerCase().endsWith(".md")
      ? [{ path: entry.path, origin, shape: "skill-file", fallbackName: fallbackNameFor(entry.path) }]
      : [];
  }
  if (existsSync(join(entry.path, "SKILL.md"))) {
    return [{ path: entry.path, origin, shape: "skill" }];
  }
  return [
    { path: entry.path, origin, shape: "skills" },
    ...looseSkillFileRoots(entry.path, origin),
  ];
}

/**
 * The loose top-level `*.md` skills of one of prime's default skills
 * directories (`loadSkillsFromDirInternal` … `includeRootFiles`): sorted, so
 * the answer is stable, and capped. Nested directories are the declared
 * `skills` roots' job; only the top level carries loose files.
 */
function looseSkillFileRoots(
  skillsDir: string,
  origin: "user" | "project",
): ResolvedSkillRoot[] {
  if (!existsSync(skillsDir)) {
    return [];
  }
  let entries;
  try {
    entries = readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, MAX_LOOSE_SKILL_FILES_PER_ROOT)
    .map((name) => {
      const path = join(skillsDir, name);
      return {
        path,
        origin,
        shape: "skill-file" as const,
        fallbackName: fallbackNameFor(path),
      };
    });
}

/**
 * A file-backed skill's fallback name: prime names a loose file by its
 * frontmatter `name`, falling back to the parent directory (which, for a
 * skills root, is the skills directory itself — useless). The file's own stem
 * is the closest stable guess, and bb reads the frontmatter name when there
 * is one.
 */
function fallbackNameFor(path: string): string {
  return basename(path).replace(/\.[^.]+$/u, "");
}

/** Whether a path is a file or a directory, or nothing when it is neither. */
function entryKind(path: string): "file" | "directory" | undefined {
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
    return undefined;
  }
}

/**
 * `~`-expanded against the resolver's home directory, resolved against the
 * settings entry's base, lexically normal — prime's `resolvePathFromBase`.
 */
function resolveFrom(path: string, baseDir: string, homeDir: string): string {
  const expanded =
    path === "~"
      ? homeDir
      : path.startsWith("~/")
        ? join(homeDir, path.slice(2))
        : path;
  return resolve(baseDir, expanded);
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

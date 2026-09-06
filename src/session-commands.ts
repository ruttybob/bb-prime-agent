import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

/**
 * prime's session slash commands as bb composer commands (bbpa-b1m.1).
 *
 * prime runs a prompt whose text parses as one of its session slash commands
 * inside the session itself (`parseSessionSlashCommand` in prime's
 * `dist/core/slash-commands.js`), and the bridge's prompt path passes
 * non-skill "/"-text through untouched (`src/skill-mentions.ts`) — so `/goal …`
 * typed into bb already works. What was missing is discoverability: bb's "/"
 * menu lists a provider's commands from `command-file` native roots, one
 * `.md` per command, and no such root can be *declared* statically, because
 * the files must exist on the machine doing the listing. The host-resolved
 * half of the native-roots contract can: `resolvePrimeNativeRoots`
 * (`src/native-roots.ts`, host graph) materializes the catalog below into one
 * file per command and answers the roots. bb reads each file's frontmatter
 * `description`/`argumentHint` for the menu entry, names the entry after the
 * file's basename, and an invocation inserts the literal `/name …` text —
 * which rides the prompt passthrough into prime.
 *
 * Deliberately NO `compact`: bb ships a builtin `/compact` already, and that
 * passthrough is live (bbpa-ggf.6) — a second menu entry for the same name is
 * noise in the picker.
 *
 * This module is host-graph-only: it serves the native-roots resolver and
 * must not be imported from the server graph — the same rule
 * `src/native-roots.ts` documents (bb reloads the server entry through jiti,
 * guarded by `server-entry-graph.test.ts`).
 */

/** One prime session command, with prime's own copy for the bb menu. */
export interface PrimeSessionCommand {
  /** The command name — the menu entry, and the `.md` file's basename. */
  readonly name: string;
  /** Verbatim from prime's `CANONICAL_BUILTIN_SLASH_COMMANDS`. */
  readonly description: string;
  /** Verbatim from prime; absent exactly when prime omits it. */
  readonly argumentHint: string | undefined;
}

/**
 * The session commands bb offers, in menu order. The strings are copied
 * verbatim from prime's `CANONICAL_BUILTIN_SLASH_COMMANDS`
 * (`dist/core/slash-commands.js`) — they are what the session actually runs,
 * so the menu must not paraphrase them.
 */
export const PRIME_SESSION_COMMANDS: readonly PrimeSessionCommand[] = [
  {
    name: "goal",
    description: "Set or view a persistent goal; supports pause, resume, and clear",
    argumentHint: "[objective]",
  },
  {
    name: "refine",
    description: "Refine continual harness prompt notes, skills, subagents, and memory",
    argumentHint: undefined,
  },
  {
    name: "heartbeat",
    description:
      "Set or view a persistent heartbeat; delivery defaults to steer, use --follow-up to queue; supports pause, resume, stop, and clear",
    argumentHint:
      "[status|pause|resume|stop|[every <duration>] [--steer|--follow-up] <instruction>]",
  },
  {
    name: "heartbeats",
    description: "View and manage all user and agent heartbeats",
    argumentHint: undefined,
  },
  {
    name: "autonomous",
    description: "Set or view autonomous mode",
    argumentHint: "[status|on|off]",
  },
  {
    name: "rlm-max-depth",
    description:
      "Set/view the per-chat persistent RLM max depth immediately; never interrupts or queues the running turn",
    argumentHint: "[<int> [--global]]",
  },
];

/**
 * Where the command files live: under the machine's temp dir, namespaced per
 * uid the way prime names its own socket (`prime-agent-<uid>`), so two
 * accounts on one machine never share files. Temp is the right home — the
 * content is regenerable catalog data, rewritten on every host listing.
 */
export function primeSessionCommandsDir(): string {
  return join(tmpdir(), `bb-prime-agent-commands-${userInfo().uid}`);
}

/**
 * Write one `<name>.md` per catalog command into `dir`. Idempotent: the
 * content depends on nothing but the catalog, and existing files are
 * overwritten — a stale file from an older plugin version heals itself on
 * the next host listing.
 */
export function materializePrimeSessionCommandFiles(dir: string): void {
  mkdirSync(dir, { recursive: true });
  for (const command of PRIME_SESSION_COMMANDS) {
    writeFileSync(join(dir, `${command.name}.md`), commandFileBody(command));
  }
}

/** One resolved root per command file, in the form the resolver answers. */
export interface PrimeSessionCommandRoot {
  readonly path: string;
  /**
   * `user`: these are the session's builtin commands — not workspace state,
   * so every workspace lists them the same way.
   */
  readonly origin: "user";
  /** One command per file; bb names the entry after the file's basename. */
  readonly shape: "command-file";
}

/** The resolved commands roots answer: one `command-file` root per command. */
export function primeSessionCommandRoots(
  dir: string,
): PrimeSessionCommandRoot[] {
  return PRIME_SESSION_COMMANDS.map((command) => ({
    path: join(dir, `${command.name}.md`),
    origin: "user",
    shape: "command-file",
  }));
}

/**
 * The command file bb scans. bb reads only the frontmatter (`description`,
 * `argumentHint`) and names the entry after the basename; the body is for a
 * human opening the file, so it stays one truthful line. `JSON.stringify` is
 * a valid YAML double-quoted scalar — which the hints (`[status|…]`) need,
 * unquoted they would parse as flow sequences.
 */
function commandFileBody(command: PrimeSessionCommand): string {
  const frontmatter = [
    "---",
    `description: ${JSON.stringify(command.description)}`,
    ...(command.argumentHint === undefined
      ? []
      : [`argumentHint: ${JSON.stringify(command.argumentHint)}`]),
    "---",
  ];
  return [
    ...frontmatter,
    "",
    `Runs inside the prime-agent session: bb forwards /${command.name} plus arguments, and prime executes it there.`,
    "",
  ].join("\n");
}

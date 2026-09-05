import { homedir } from "node:os";
import { join } from "node:path";
import type { ReasoningLevel } from "@get-bb/plugin-sdk/provider-bridge";

/**
 * THE seam between bb and the prime-agent daemon session.
 *
 * Every field this bridge ever sends in a `create` command payload is produced
 * by `buildPrimeCreateCommand` — no other module assembles daemon session
 * params. That single funnel is deliberate:
 *
 * - the "[bb] " session name and the bb environment's cwd are decided once, so
 *   every session bb owns is recognisable in prime's own catalog;
 * - `noExtensions: true` keeps prime's extension discovery off, which is what
 *   makes the *companion extension* channel (ADR-0003) the only way code enters
 *   a bb session;
 * - the later tickets inject their fields HERE and nowhere else:
 *   bbpa-ggf.12 (extension picker) appends to `config.extensions`, and
 *   bbpa-ggf.13 (dynamic tools) appends the companion extension path. The
 *   `extensionConfigFields` seam below is that injection point — it stays a
 *   closed `{}` until those tickets land, so a diff that touches session
 *   params shows up as a one-file change.
 *
 * What deliberately does NOT ride `create`: model/thinking *changes* after the
 * session exists (bbpa-ggf.6 owns `set_model`/`set_thinking_level`), and skill
 * roots (bbpa-ggf.8 owns native roots; prime's own skill discovery stays on via
 * `noSkills: false`).
 */

/** Sessions bb owns are namespaced in prime's own catalog with this prefix. */
export const BB_SESSION_NAME_PREFIX = "[bb] ";

/**
 * prime's per-session agent dir, pinned to prime's own default
 * (`~/.prime/agent`, `dist/config.js` `CONFIG_DIR_NAME`) so a bb session never
 * inherits an agent dir from the bb environment it runs in.
 */
export function primeAgentDir(): string {
  return join(homedir(), ".prime", "agent");
}

/**
 * prime's thinking ladder (`ThinkingLevel`, pi-lineage), read-only onto bb's
 * reasoning levels. bb's `ultracode`/`ultra` are outside prime's ladder and the
 * declaration does not offer them; if one ever arrives it is dropped rather
 * than guessed at.
 */
export type PrimeThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export function primeThinkingLevel(
  reasoningLevel: ReasoningLevel | undefined,
): PrimeThinkingLevel | undefined {
  switch (reasoningLevel) {
    case "none":
      return "off";
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return reasoningLevel;
    case "ultracode":
    case "ultra":
    case undefined:
      return undefined;
  }
}

/**
 * The prime session name for a bb thread. bb does not send a thread title over
 * the bridge protocol, so the title is the thread's first prompt text when
 * there is one and the bb thread id otherwise — either way the "[bb] " prefix
 * is what prime's catalog (and this repo's tests) key on.
 */
export function primeSessionName(args: {
  threadId: string;
  title?: string | undefined;
}): string {
  const title = args.title?.trim() ?? "";
  const trimmed =
    title.length > 0 ? truncate(title, 80) : truncate(args.threadId, 80);
  return `${BB_SESSION_NAME_PREFIX}${trimmed}`;
}

function truncate(text: string, max: number): string {
  const normalized = text.replaceAll(/\s+/gu, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

/**
 * Extension/config fields contributed by the tickets that extend a bb session
 * on prime's side. Deliberately empty until then: an empty `extensions` list
 * plus `noExtensions: true` is exactly CLI `-e <none>` + `-ne`, so bb sessions
 * load no prime extension until one is injected here.
 */
function extensionConfigFields(_args: PrimeCreateCommandArgs): Record<string, never> {
  return {};
}

export interface PrimeCreateCommandArgs {
  /** The bb thread id — the fallback session title and the audit trail. */
  threadId: string;
  /** bb thread title as the bridge derived it (first prompt text, if any). */
  title?: string | undefined;
  /** The bb thread environment's cwd; the session executes here. */
  cwd: string;
  /** bb-selected model, passed through when the thread picked one. */
  model?: string | undefined;
  /** bb-selected reasoning level, mapped onto prime's thinking ladder. */
  reasoningLevel?: ReasoningLevel | undefined;
}

/** The `create` command payload, exactly as the daemon expects it. */
export interface PrimeCreateCommand {
  type: "create";
  name: string;
  lifecycle: "resident";
  config: {
    cwd: string;
    agentDir: string;
    noExtensions: true;
    noSkills: false;
    model?: string;
    thinking?: PrimeThinkingLevel;
  };
}

/**
 * The whole `create` payload for a bb thread's resident session. The daemon
 * merges `config` over its own defaults per session, and `lifecycle: "resident"`
 * (the daemon default, stated here so it survives a prime default flip) keeps
 * the session alive after the bridge disconnects — the session file is the
 * durable thing bb's threads point at.
 */
export function buildPrimeCreateCommand(
  args: PrimeCreateCommandArgs,
): PrimeCreateCommand {
  const thinking = primeThinkingLevel(args.reasoningLevel);
  return {
    type: "create",
    name: primeSessionName({ threadId: args.threadId, title: args.title }),
    lifecycle: "resident",
    config: {
      cwd: args.cwd,
      agentDir: primeAgentDir(),
      noExtensions: true,
      noSkills: false,
      ...(args.model === undefined ? {} : { model: args.model }),
      ...(thinking === undefined ? {} : { thinking }),
      ...extensionConfigFields(args),
    },
  };
}

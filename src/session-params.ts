import { homedir } from "node:os";
import { join } from "node:path";
import type { ReasoningLevel } from "@get-bb/plugin-sdk/provider-bridge";
import type { PrimeModel } from "./daemon/wire.js";
import { BB_TOOLS_CHANNEL_FLAG } from "./dynamic-tools/protocol.js";

/**
 * THE seam between bb and the prime-agent daemon session.
 *
 * Every field this bridge ever sends in a `create` command payload is produced
 * by `buildPrimeCreateCommand` — no other module assembles daemon session
 * params. That single funnel is deliberate:
 *
 * - the "[bb] " session name and the bb environment's cwd are decided once, so
 *   every session bb owns is recognisable in prime's own catalog;
 * - `noExtensions: true` keeps prime's extension discovery off, so code enters
 *   a bb session only through explicit paths: the extension picker's selection
 *   (bbpa-ggf.12) and the dynamic-tools companion extension (bbpa-ggf.13,
 *   ADR-0003) are both appended to `config.extensions` HERE, by
 *   `extensionConfigFields` — the one injection point for extension config, so
 *   a diff that touches it shows up as a one-file change.
 *
 * What deliberately does NOT ride `create`: model/thinking *changes* after the
 * session exists (bbpa-ggf.6 owns `set_model`/`set_thinking_level`), and skill
 * roots (bbpa-ggf.8 owns native roots; prime's own skill discovery stays on via
 * `noSkills: false`). `create` is also sent exactly once per session, which is
 * what makes the picker's selection a new-sessions-only knob: a resume attaches
 * to the resident worker without re-sending any of this.
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

/** The ladder prime's models speak, in prime's own order. */
export const PRIME_THINKING_LADDER: readonly PrimeThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/**
 * The levels a model accepts, exactly as prime computes them
 * (`getSupportedThinkingLevels`, pi-ai `dist/models.js`): a non-reasoning
 * model takes "off" only, a level marked `null` in the model's
 * `thinkingLevelMap` is dropped, and `xhigh`/`max` additionally need an
 * explicit entry. This is the authority for refusing an unsupported level
 * instead of letting prime clamp it silently — prime's clamp also writes the
 * clamped level into the user's global settings.
 */
export function supportedPrimeThinkingLevels(
  model: Pick<PrimeModel, "reasoning" | "thinkingLevelMap">,
): PrimeThinkingLevel[] {
  if (model.reasoning !== true) {
    return ["off"];
  }
  return PRIME_THINKING_LADDER.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) {
      return false;
    }
    if (level === "xhigh" || level === "max") {
      return mapped !== undefined;
    }
    return true;
  });
}

/** bb's model id for a prime model: `provider/modelId`. */
export function canonicalPrimeModelId(model: PrimeModel): string {
  return `${model.provider}/${model.id}`;
}

/**
 * Split a bb model id back into prime's `set_model`/`create.config` fields.
 * The split is at the first `/`: model ids may themselves contain slashes
 * (openrouter's `openrouter/openai/gpt-…`), providers never do.
 */
export function splitPrimeModelId(
  model: string,
): { provider: string; modelId: string } | undefined {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) {
    return undefined;
  }
  return {
    provider: model.slice(0, slash),
    modelId: model.slice(slash + 1),
  };
}

/**
 * The prime session name for a bb thread.
 *
 * bb does not send a thread title over the bridge protocol, so the title is the
 * thread's first prompt text; the "[bb] " prefix is what prime's catalog (and
 * this repo's tests) key on. The bb thread id is part of the name because prime
 * requires agent names to be unique among its resident sessions ("an agent of
 * that name already exists at depth 0 under this parent"): two bb threads whose
 * first message happens to match must not collide, and a repeat create for the
 * same thread keeps converging on the same name.
 */
export function primeSessionName(args: {
  threadId: string;
  title?: string | undefined;
}): string {
  const title = args.title?.trim() ?? "";
  if (title.length === 0) {
    return `${BB_SESSION_NAME_PREFIX}${args.threadId}`;
  }
  return `${BB_SESSION_NAME_PREFIX}${truncate(title, 64)} (${args.threadId})`;
}

function truncate(text: string, max: number): string {
  const normalized = text.replaceAll(/\s+/gu, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

/**
 * Extension/config fields contributed by the tickets that extend a bb session
 * on prime's side. Two contributions, merged into one explicit `-e` list under
 * the unconditional `-ne`:
 *
 * - bbpa-ggf.12's picker selection (`enabledExtensions`, absolute paths of the
 *   user prime-agent extensions the provider settings enabled). The paths
 *   always stay absolute because prime resolves relative ones against its own
 *   worker's cwd, not the session's; flag values for user extensions are not
 *   wired — the picker loads paths, nothing else.
 * - bbpa-ggf.13's companion extension, when the thread declares bb dynamic
 *   tools, which learns its channel socket through the per-session flag value —
 *   the only per-session value channel prime offers
 *   (`create.config.extensionFlagValues`).
 *
 * Nothing here until one of the two contributes: a plain session's `create`
 * carries no extension fields at all, so the picker's default (everything off)
 * produces byte-identical payloads to before the picker existed.
 */
function extensionConfigFields(args: PrimeCreateCommandArgs): Record<string, unknown> {
  const dynamicTools = args.dynamicTools;
  // User extensions first (picker order), companion last: deterministic on both
  // sides, and deduplicated so a user extension that *is* the companion cannot
  // be handed to prime twice.
  const extensions = dedupePreservingOrder([
    ...(args.enabledExtensions ?? []),
    ...(dynamicTools?.extensions ?? []),
  ]);
  if (extensions.length === 0) {
    return {};
  }
  return {
    extensions,
    ...(dynamicTools?.extensionFlagValues === undefined
      ? {}
      : { extensionFlagValues: dynamicTools.extensionFlagValues }),
  };
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
  /**
   * The extension picker's selection for new sessions (bbpa-ggf.12): absolute
   * paths of the user prime-agent extensions to load explicitly. Present only
   * when the provider settings enabled any.
   */
  enabledExtensions?: readonly string[] | undefined;
  /**
   * The dynamic-tools channel for this session (bbpa-ggf.13): loads the
   * companion extension explicitly and points it at the bridge-side socket.
   * Present only when the thread declares bb dynamic tools.
   */
  dynamicTools?: PrimeDynamicToolsConfig | undefined;
}

/**
 * The `create.config` fragment the dynamic-tools registry contributes
 * (bbpa-ggf.13): the companion extension loaded explicitly on top of the
 * unconditional discovery-off, with its channel socket as a flag value.
 */
export interface PrimeDynamicToolsConfig {
  noExtensions: true;
  extensions: string[];
  extensionFlagValues: Record<string, string>;
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
    /**
     * Explicit extension loads (`-e`): the picker's user extensions
     * (bbpa-ggf.12) then the bb companion extension (bbpa-ggf.13). Loads even
     * with `noExtensions: true` above — that is the `-e` + `-ne` pair.
     */
    extensions?: string[];
    /** Per-session values for extension-declared flags (the channel socket). */
    extensionFlagValues?: Record<string, string>;
  };
}

function dedupePreservingOrder(paths: readonly string[]): string[] {
  return [...new Set(paths)];
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
  // bb carries models as `provider/modelId` (the shape `model/list` answers
  // with); prime wants the two parts separately in `create.config`.
  const model = args.model === undefined ? undefined : splitPrimeModelId(args.model);
  return {
    type: "create",
    name: primeSessionName({ threadId: args.threadId, title: args.title }),
    lifecycle: "resident",
    config: {
      cwd: args.cwd,
      agentDir: primeAgentDir(),
      noExtensions: true,
      noSkills: false,
      ...(model === undefined ? {} : { provider: model.provider, model: model.modelId }),
      ...(thinking === undefined ? {} : { thinking }),
      ...extensionConfigFields(args),
    },
  };
}

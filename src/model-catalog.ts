import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  HIGH_REASONING_EFFORT,
  LOW_REASONING_EFFORT,
  MAX_REASONING_EFFORT,
  MEDIUM_REASONING_EFFORT,
  XHIGH_REASONING_EFFORT,
  type AvailableModel,
  type ModelReasoningEffort,
} from "@get-bb/plugin-sdk/provider-bridge";
/** bb spells prime's "off" thinking level as the "none" reasoning effort. */
const NONE_REASONING_EFFORT: ModelReasoningEffort = {
  reasoningEffort: "none",
  description: "No extended thinking",
};
import { z } from "zod";
import { daemonRequest } from "./daemon/connection.js";
import {
  primeConnectionStateSchema,
  primeModelSchema,
  type PrimeModel,
} from "./daemon/wire.js";
import {
  BB_SESSION_NAME_PREFIX,
  PRIME_THINKING_LADDER,
  canonicalPrimeModelId,
  supportedPrimeThinkingLevels,
  type PrimeThinkingLevel,
} from "./session-params.js";

/**
 * bb's `model/list`, answered from prime-agent's own model catalog.
 *
 * There is deliberately no curated model list in this plugin: prime's daemon
 * owns the catalog (`get_model_catalog`, gated by the daemon's `model_catalog`
 * capability — `src/daemon/protocol.ts`) and this module only translates its
 * entries into bb's `AvailableModel` shape. The model id bb carries around is
 * the canonical `provider/modelId` pair, which is exactly what prime's
 * `set_model` splits back into its two fields.
 *
 * The catalog is a *per-session* answer on the daemon wire — it is read off a
 * session's model registry — and `model/list` has no thread. So the fetch runs
 * a throwaway catalog lane: a `client_owned` session with `noSession: true`
 * (no transcript file is ever written), no extensions and no skills, which is
 * killed as soon as the catalog is read. If the bridge dies before that, the
 * daemon reaps a client-owned session on its own. Answers are cached briefly
 * per cwd (a picker opens often; prime's catalog does not change under it).
 */

/**
 * prime's thinking ladder, read onto bb's reasoning efforts. bb spells prime's
 * "off" as "none"; there is no bb effort for "minimal", so a model whose ladder
 * is minimal-only advertises none (pi's catalog does the same).
 */
const LEVEL_TO_EFFORT: Partial<
  Record<PrimeThinkingLevel, ModelReasoningEffort["reasoningEffort"]>
> = {
  off: NONE_REASONING_EFFORT.reasoningEffort,
  low: LOW_REASONING_EFFORT.reasoningEffort,
  medium: MEDIUM_REASONING_EFFORT.reasoningEffort,
  high: HIGH_REASONING_EFFORT.reasoningEffort,
  xhigh: XHIGH_REASONING_EFFORT.reasoningEffort,
  max: MAX_REASONING_EFFORT.reasoningEffort,
};

/**
 * prime's own clamp (pi-ai `clampThinkingLevel`): the requested level when the
 * model takes it, else the nearest supported level downwards, then upwards —
 * this is what a fresh session runs when the user has not picked anything, so
 * it is also the effort bb should default the model to.
 */
function clampPrimeThinkingLevel(
  model: PrimeModel,
  level: PrimeThinkingLevel,
): PrimeThinkingLevel {
  const ladder = supportedPrimeThinkingLevels(model);
  if (ladder.includes(level)) {
    return level;
  }
  const requested = PRIME_THINKING_LADDER.indexOf(level);
  if (requested < 0) {
    return ladder[0] ?? "off";
  }
  for (let index = requested; index < PRIME_THINKING_LADDER.length; index += 1) {
    const candidate = PRIME_THINKING_LADDER[index]!;
    if (ladder.includes(candidate)) {
      return candidate;
    }
  }
  for (let index = requested - 1; index >= 0; index -= 1) {
    const candidate = PRIME_THINKING_LADDER[index]!;
    if (ladder.includes(candidate)) {
      return candidate;
    }
  }
  return ladder[0] ?? "off";
}

function describePrimeModel(model: PrimeModel): string {
  const capabilities = [model.reasoning === true ? "reasoning" : "non-reasoning"];
  if (model.input?.includes("image")) {
    capabilities.push("multimodal");
  }
  return `${capabilities.join(", ")} model from ${model.provider}, via prime-agent`;
}

function primeModelToAvailableModel(model: PrimeModel): AvailableModel {
  const efforts = supportedPrimeThinkingLevels(model).flatMap((level) => {
    const effort = LEVEL_TO_EFFORT[level];
    return effort === undefined
      ? []
      : [{ reasoningEffort: effort, description: `${level} thinking` }];
  });
  const supportedReasoningEfforts: ModelReasoningEffort[] =
    efforts.length > 0 ? efforts : [NONE_REASONING_EFFORT];
  // bb's default effort for this model is the level prime itself runs when
  // nobody picked one: its medium default, clamped to the model's ladder.
  const defaultEffort =
    LEVEL_TO_EFFORT[clampPrimeThinkingLevel(model, "medium")] ??
    NONE_REASONING_EFFORT.reasoningEffort;
  return {
    id: canonicalPrimeModelId(model),
    model: canonicalPrimeModelId(model),
    displayName: model.name ?? model.id,
    description: describePrimeModel(model),
    routeProviderId: model.provider,
    supportedReasoningEfforts,
    defaultReasoningEffort: defaultEffort,
    // The one default is prime's own choice (its current model for a fresh
    // session), never a table maintained in this plugin.
    isDefault: false,
  };
}

/** The bb `model/list` answer, as the SDK's `modelListResultSchema` expects it. */
export interface PrimeModelList {
  models: AvailableModel[];
  selectedOnlyModels: AvailableModel[];
}

export interface PrimeAvailableModelsArgs {
  /** bb's thread environment; the catalog is resolved per cwd like a session. */
  cwd?: string | undefined;
}

/**
 * One `model/list` answer: prime's catalog translated, with prime's own
 * current model marked as bb's default.
 */
export async function primeAvailableModels(
  args: PrimeAvailableModelsArgs = {},
): Promise<PrimeModelList> {
  const key = resolve(args.cwd ?? process.cwd());
  const cached = cache.get(key);
  if (cached !== undefined && Date.now() - cached.fetchedAt < CATALOG_TTL_MS) {
    return cached.answer;
  }
  const pending = inFlight.get(key);
  if (pending !== undefined) {
    return pending;
  }
  const created = fetchPrimeAvailableModels(args).then((answer) => {
    cache.set(key, { answer, fetchedAt: Date.now() });
    return answer;
  });
  const tracked = created.finally(() => {
    inFlight.delete(key);
  });
  // Callers that coalesce onto this promise get the failure; the stored
  // reference itself must not warn when nobody is waiting on it.
  tracked.catch(() => {});
  inFlight.set(key, tracked);
  return created;
}

/** Test seam: forget the cached catalog answers. */
export function resetModelCatalogForTests(): void {
  cache.clear();
  inFlight.clear();
}

const CATALOG_TTL_MS = 5 * 60_000;
const cache = new Map<string, { answer: PrimeModelList; fetchedAt: number }>();
const inFlight = new Map<string, Promise<PrimeModelList>>();

async function fetchPrimeAvailableModels(
  args: PrimeAvailableModelsArgs,
): Promise<PrimeModelList> {
  // A client-owned session with no transcript file: it exists only to answer
  // one catalog read, and the daemon reaps it even if this process dies first.
  const created = await daemonRequest({
    type: "create",
    name: `${BB_SESSION_NAME_PREFIX}model catalog ${randomUUID().slice(0, 8)}`,
    lifecycle: "client_owned",
    noSession: true,
    config: {
      cwd: args.cwd ?? process.cwd(),
      noExtensions: true,
      noSkills: true,
    },
  });
  if (
    !created.success ||
    !isRecord(created.data) ||
    typeof created.data.activeSessionId !== "string"
  ) {
    throw new Error(
      `prime-agent did not answer the model catalog probe with a session: ${created.error ?? "no activeSessionId"}`,
    );
  }
  const activeSessionId = created.data.activeSessionId;
  try {
    const catalog = await daemonRequest(
      { type: "get_model_catalog", activeSessionId },
      { timeoutMs: 60_000 },
    );
    if (!catalog.success) {
      throw new Error(
        `prime-agent refused to answer the model catalog: ${catalog.error ?? "unknown daemon error"}`,
      );
    }
    const parsed = primeModelCatalogSchema.safeParse(catalog.data);
    if (!parsed.success) {
      throw new Error(
        "prime-agent answered the model catalog with something this bridge cannot read",
      );
    }
    const models: AvailableModel[] = [];
    for (const entry of parsed.data.models) {
      const model = primeModelSchema.safeParse(entry);
      if (!model.success) {
        // One malformed entry degrades to one missing model, never a broken list.
        continue;
      }
      models.push(primeModelToAvailableModel(model.data));
    }
    // prime's own current model for a fresh session is the default bb shows;
    // the state read is best effort, a catalog without a default is still a
    // usable catalog.
    let currentModelKey: string | undefined;
    try {
      const state = await daemonRequest({ type: "get_connection_state", activeSessionId });
      const parsedState = primeConnectionStateSchema.safeParse(
        isRecord(state.data) && isRecord(state.data.state) ? state.data.state : state.data,
      );
      if (parsedState.success && parsedState.data.model !== undefined) {
        currentModelKey = canonicalPrimeModelId(parsedState.data.model);
      }
    } catch {
      currentModelKey = undefined;
    }
    const defaultKey = models.some((model) => model.id === currentModelKey)
      ? currentModelKey
      : models[0]?.id;
    return {
      models: models.map((model) =>
        model.id === defaultKey ? { ...model, isDefault: true } : model,
      ),
      selectedOnlyModels: [],
    };
  } finally {
    // Never leak the lane: a killed client-owned session leaves no file behind.
    try {
      await daemonRequest({ type: "kill", activeSessionId });
    } catch {
      // The daemon reaps it on its own.
    }
  }
}

const primeModelCatalogSchema = z
  .object({
    models: z.array(z.unknown()),
    configuredProviders: z.array(z.string()).optional(),
  })
  .passthrough();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

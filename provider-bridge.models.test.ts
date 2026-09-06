import { describe, expect, it, vi } from "vitest";
import { BRIDGE_JSON_RPC_ERRORS } from "@get-bb/plugin-sdk/provider-bridge";
import { setPrimeDaemonTransportFactoryForTests } from "./src/daemon/connection.js";
import { calibratedHello, FakeDaemon } from "./test-support/fake-daemon.js";
import { createSocketTransport } from "./src/daemon/transport.js";
import { textTurnEvents, type ScriptedDaemonHandle } from "./test-support/scripted-daemon.js";
import { resetModelCatalogForTests } from "./src/model-catalog.js";
import {
  splitPrimeModelId,
  supportedPrimeThinkingLevels,
} from "./src/session-params.js";
import { primeProviderDeclaration } from "./src/declaration.js";
import {
  CLIENT_REQUEST_ID,
  FULL_OPTIONS,
  startBridgeHarness,
} from "./test-support/bridge-harness.js";

/**
 * The model/thinking/compaction surface (bbpa-ggf.6), over the scripted
 * daemon: `model/list` answered from prime's catalog — no curated list of our
 * own, and an honest error on a daemon without the `model_catalog` capability
 * —, model and thinking switches applied to the *running* session
 * (`set_model`/`set_thinking_level` before the turn's `prompt`), and manual
 * compaction mapped onto prime's `compact` with its events streamed.
 */

/** The scripted daemon is created per test; beforeEach re-binds the alias. */
let daemon: ScriptedDaemonHandle;
let fake: FakeDaemon | undefined;

const h = startBridgeHarness({
  session: {
    activeSessionId: "sess_1",
    sessionFile: "/tmp/prime/sessions/sess_1.jsonl",
    sessionName: "[bb] scripted thread",
    cwd: "/tmp/prime-workspace",
  },
  beforeEachExtra: (harness) => {
    daemon = harness.daemon;
    resetModelCatalogForTests();
  },
  afterEachExtra: async () => {
    delete process.env.BB_PRIME_AGENT_DAEMON_SOCKET;
    resetModelCatalogForTests();
    await fake?.close();
    fake = undefined;
  },
});

const { cwd, sendRequest, waitForResponse, deltas, rawNotifications, messages } = h;

/** The `prime.session_state` raw mirror payloads (the inner params object). */
function sessionStateNotifications(): Array<Record<string, unknown>> {
  return rawNotifications("prime.session_state").flatMap(
    (params) => [params.params as Record<string, unknown>],
  );
}

/** prime's model facts, as the daemon's catalog and connection state carry them. */
const GLM = {
  id: "glm-5.3-flash",
  name: "GLM 5.3 Flash",
  api: "openai-completions",
  provider: "zai",
  baseUrl: "https://api.z.ai/api/coding/paas/v4",
  reasoning: true,
  thinkingLevelMap: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
  input: ["text"],
  contextWindow: 1_000_000,
  maxTokens: 131_072,
};
const NOVA = {
  id: "amazon.nova-lite-v1:0",
  name: "Nova Lite",
  api: "bedrock-converse-stream",
  provider: "amazon-bedrock",
  baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
  reasoning: false,
  input: ["text", "image"],
  contextWindow: 128_000,
  maxTokens: 4096,
};

/** Enqueue a full catalog lane: create → get_model_catalog → state → kill. */
function enqueueCatalog(args: {
  models: Array<Record<string, unknown>>;
  /** prime's own session state; its current model becomes bb's default. */
  state?: Record<string, unknown>;
}): void {
  daemon.enqueueCreate();
  daemon.enqueueData("get_model_catalog", {
    models: args.models,
    configuredProviders: [...new Set(args.models.map((model) => model.provider))],
  });
  daemon.enqueueData("get_connection_state", {
    state: args.state ?? { model: GLM },
  });
  daemon.enqueueOk("kill");
}

describe("the model catalog", () => {
  it("answers model/list from prime's catalog, mapped into bb's shape", async () => {
    enqueueCatalog({
      models: [GLM, NOVA],
      state: { model: NOVA, thinkingLevel: "off", autoCompactionEnabled: true },
    });

    sendRequest("ml", "model/list", { cwd });
    const reply = await waitForResponse("ml");
    expect(reply.error).toBeUndefined();
    const models = (reply.result?.models ?? []) as Array<Record<string, unknown>>;
    const selectedOnly = reply.result?.selectedOnlyModels as Array<Record<string, unknown>>;
    expect(selectedOnly).toEqual([]);
    expect(models.map((model) => model.id)).toEqual([
      "zai/glm-5.3-flash",
      "amazon-bedrock/amazon.nova-lite-v1:0",
    ]);
    expect(models.map((model) => model.model)).toEqual(models.map((model) => model.id));
    const [glm, nova] = models;
    // bb spelling of prime's ladder: off→none, and only the mapped levels.
    expect(
      (glm.supportedReasoningEfforts as Array<Record<string, unknown>>).map(
        (effort) => effort.reasoningEffort,
      ),
    ).toEqual(["low", "high", "max"]);
    expect(glm.defaultReasoningEffort).toBe("high");
    expect(glm.displayName).toBe("GLM 5.3 Flash");
    expect(glm.routeProviderId).toBe("zai");
    expect(String(glm.description)).toContain("reasoning");
    expect(
      (nova.supportedReasoningEfforts as Array<Record<string, unknown>>).map(
        (effort) => effort.reasoningEffort,
      ),
    ).toEqual(["none"]);
    expect(nova.defaultReasoningEffort).toBe("none");
    expect(String(nova.description)).toContain("multimodal");
    // The one default is prime's own current model — not our curation.
    expect(models.map((model) => model.isDefault)).toEqual([false, true]);
    // The throwaway catalog lane was killed: no resident session left behind.
    expect(daemon.commands.map((command) => command.type)).toEqual([
      "create",
      "get_model_catalog",
      "get_connection_state",
      "kill",
    ]);
    expect(daemon.commands[0]).toMatchObject({
      lifecycle: "client_owned",
      noSession: true,
      config: { cwd, noExtensions: true, noSkills: true },
    });
  });

  it("answers one `model/list` per cwd from one catalog read (cache)", async () => {
    enqueueCatalog({ models: [GLM] });
    sendRequest("a", "model/list", { cwd });
    sendRequest("b", "model/list", { cwd });
    await waitForResponse("a");
    await waitForResponse("b");
    // A second cwd is a second environment: prime resolves providers per cwd.
    enqueueCatalog({ models: [GLM] });
    sendRequest("c", "model/list", { cwd: "/tmp/another-workspace" });
    await waitForResponse("c");
    const reads = daemon.commands.filter(
      (command) => command.type === "get_model_catalog",
    );
    expect(reads).toHaveLength(2);
  });

  it("answers an honest error on a daemon without the model_catalog capability", async () => {
    // A real socket with a capability-less greeting, so the client-side compat
    // gate is in play exactly as it is against a production daemon.
    fake = await FakeDaemon.start({
      hello: calibratedHello({
        serverCapabilities: (calibratedHello().serverCapabilities as string[]).filter(
            (capability: string) => capability !== "model_catalog",
          )
          .concat("model_catalog_legacy"),
      }),
      respond: (envelope) => {
        const command = String(
          (envelope.command as Record<string, unknown> | undefined)?.type,
        );
        // The catalog lane boots; only the catalog read is gated.
        if (command === "create") {
          return {
            type: "response",
            id: envelope.id,
            command,
            success: true,
            data: { activeSessionId: "sess_cap" },
          };
        }
        return {
          type: "response",
          id: envelope.id,
          command,
          success: true,
        };
      },
    });
    process.env.BB_PRIME_AGENT_DAEMON_SOCKET = fake.socketPath;
    setPrimeDaemonTransportFactoryForTests(({ socketPath }) =>
      createSocketTransport({ socketPath, clientId: "bbpa-test" }),
    );
    sendRequest("ml", "model/list", { cwd });
    const reply = await waitForResponse("ml");
    expect(reply.error?.code).toBe(BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR);
    expect(reply.error?.message).toContain("model_catalog");
    expect(reply.error?.message).toContain("capability");
  });

  it("answers an honest error when the daemon refuses the catalog", async () => {
    daemon.enqueueFail("create", "no providers configured");
    sendRequest("ml", "model/list", { cwd });
    const reply = await waitForResponse("ml");
    expect(reply.error?.code).toBe(BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR);
    expect(reply.error?.message).toContain("no providers configured");
  });

  it("answers an empty catalog as an empty picker, not an error", async () => {
    enqueueCatalog({ models: [] });
    sendRequest("ml", "model/list", { cwd });
    const reply = await waitForResponse("ml");
    expect(reply.error).toBeUndefined();
    expect(reply.result as Record<string, unknown>).toEqual({
      models: [],
      selectedOnlyModels: [],
    });
  });
});

describe("thinking ladders", () => {
  it("computes a model's levels exactly like prime does", () => {
    // Non-reasoning: off only.
    expect(supportedPrimeThinkingLevels({ reasoning: false })).toEqual(["off"]);
    // No map: everything but the explicit-entry-only top levels.
    expect(supportedPrimeThinkingLevels({ reasoning: true })).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
    // A map decides: null marks unsupported.
    expect(supportedPrimeThinkingLevels(GLM)).toEqual(["low", "high", "max"]);
  });

  it("splits bb's provider/model ids at the first slash", () => {
    expect(splitPrimeModelId("zai/glm-5.3-flash")).toEqual({
      provider: "zai",
      modelId: "glm-5.3-flash",
    });
    // Model ids may carry slashes themselves; providers never do.
    expect(splitPrimeModelId("openrouter/openai/gpt-5.1-codex")).toEqual({
      provider: "openrouter",
      modelId: "openai/gpt-5.1-codex",
    });
    expect(splitPrimeModelId("glm-5.3-flash")).toBeUndefined();
    expect(splitPrimeModelId("/glm")).toBeUndefined();
    expect(splitPrimeModelId("zai/")).toBeUndefined();
  });
});

/** Start a thread whose session reports this model/thinking state. */
async function startThread(
  id: string,
  threadId: string,
  state: Record<string, unknown> = {
    model: GLM,
    thinkingLevel: "medium",
    availableThinkingLevels: ["low", "high", "max"],
    isCompacting: false,
    autoCompactionEnabled: true,
  },
): Promise<string> {
  daemon.enqueueCreate();
  daemon.enqueueAttach({ state });
  sendRequest(id, "thread/start", {
    threadId,
    cwd,
    instructionMode: "append",
    options: FULL_OPTIONS,
  });
  const reply = await waitForResponse(id);
  expect(reply.error).toBeUndefined();
  return String(reply.result?.providerThreadId);
}

describe("model and thinking switches on the running session", () => {
  it("applies a model and thinking change with set_* before the prompt", async () => {
    const providerThreadId = await startThread("s", "thr_switch");
    // The target model answers the switch (prime returns the model it moved to).
    const target = { ...GLM, id: "glm-5.4", name: "GLM 5.4" };
    daemon.enqueueData("set_model", target);
    daemon.enqueueOk("set_thinking_level");
    daemon.enqueuePrompt({ events: textTurnEvents({ text: "ok" }) });
    sendRequest("t", "turn/start", {
      threadId: "thr_switch",
      providerThreadId,
      input: [{ type: "text", text: "hello", mentions: [] }],
      clientRequestId: CLIENT_REQUEST_ID,
      options: {
        ...FULL_OPTIONS,
        model: "zai/glm-5.4",
        reasoningLevel: "high",
      },
    });
    const reply = await waitForResponse("t");
    expect(reply.error).toBeUndefined();
    const types = daemon.commands.map((command) => command.type);
    // Order is the contract: the switch lands before the turn is prompted.
    expect(types.slice(-3)).toEqual(["set_model", "set_thinking_level", "prompt"]);
    expect(daemon.commands.at(-3)).toMatchObject({
      type: "set_model",
      activeSessionId: "sess_1",
      provider: "zai",
      modelId: "glm-5.4",
    });
    expect(daemon.commands.at(-2)).toMatchObject({
      type: "set_thinking_level",
      level: "high",
    });
    // Off-timeline mirror of the session facts, so the switch is observable.
    const states = sessionStateNotifications().filter(
      (params) => params.source === "turn-options",
    );
    expect(states.at(-1)).toMatchObject({
      threadId: "thr_switch",
      model: "zai/glm-5.4",
      thinkingLevel: "high",
      availableThinkingLevels: ["low", "high", "max"],
    });
  });

  it("sends nothing when the turn's options already match the session", async () => {
    const providerThreadId = await startThread("s", "thr_noop");
    daemon.enqueuePrompt({ events: textTurnEvents({ text: "ok" }) });
    sendRequest("t", "turn/start", {
      threadId: "thr_noop",
      providerThreadId,
      input: [{ type: "text", text: "hello", mentions: [] }],
      clientRequestId: CLIENT_REQUEST_ID,
      options: { ...FULL_OPTIONS, model: "zai/glm-5.3-flash", reasoningLevel: "medium" },
    });
    const reply = await waitForResponse("t");
    expect(reply.error).toBeUndefined();
    expect(daemon.commands.at(-1)?.type).toBe("prompt");
    expect(
      daemon.commands.some((command) => String(command.type).startsWith("set_")),
    ).toBe(
      false,
    );
  });

  it("leaves bb levels prime has no word for untranslated", async () => {
    const providerThreadId = await startThread("s", "thr_ultra");
    daemon.enqueuePrompt({ events: textTurnEvents({ text: "ok" }) });
    sendRequest("t", "turn/start", {
      threadId: "thr_ultra",
      providerThreadId,
      input: [{ type: "text", text: "hello", mentions: [] }],
      clientRequestId: CLIENT_REQUEST_ID,
      options: { ...FULL_OPTIONS, reasoningLevel: "ultracode" },
    });
    const reply = await waitForResponse("t");
    expect(reply.error).toBeUndefined();
    expect(daemon.commands.at(-1)?.type).toBe("prompt");
  });

  it("refuses a thinking level the model does not offer, before prompting", async () => {
    const providerThreadId = await startThread("s", "thr_unsupported");
    // Switch to a non-reasoning model, then ask for a level it cannot take:
    // prime would clamp this silently (and write the clamp into the user's
    // settings), so the bridge refuses instead.
    daemon.enqueueData("set_model", NOVA);
    sendRequest("t", "turn/start", {
      threadId: "thr_unsupported",
      providerThreadId,
      input: [{ type: "text", text: "hello", mentions: [] }],
      clientRequestId: CLIENT_REQUEST_ID,
      options: {
        ...FULL_OPTIONS,
        model: "amazon-bedrock/amazon.nova-lite-v1:0",
        reasoningLevel: "low",
      },
    });
    const reply = await waitForResponse("t");
    expect(reply.error?.code).toBe(BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR);
    expect(reply.error?.message).toContain('"low"');
    expect(reply.error?.message).toContain("it offers: off");
    // No prompt went out for a turn whose options could not be applied.
    expect(daemon.commands.at(-1)?.type).toBe("set_model");
    expect(daemon.commands.some((command) => command.type === "prompt")).toBe(false);
  });

  it("publishes the session facts prime reports on attach", async () => {
    await startThread("s", "thr_state", {
      model: GLM,
      thinkingLevel: "high",
      availableThinkingLevels: ["low", "high", "max"],
      isCompacting: false,
      autoCompactionEnabled: false,
    });
    expect(sessionStateNotifications().at(-1)).toMatchObject({
      threadId: "thr_state",
      source: "attach",
      model: "zai/glm-5.3-flash",
      thinkingLevel: "high",
      isCompacting: false,
      autoCompactionEnabled: false,
    });
  });
});

describe("the context window on the timeline (bbpa-b1m.9)", () => {
  it("fills the usage row's window and meters the contextWindow row", async () => {
    // The session reports GLM (contextWindow 1M) in its attach state; the
    // meter reads the turn's own tokens (see the assertion below).
    const providerThreadId = await startThread("s", "thr_window");
    daemon.enqueuePrompt({ events: textTurnEvents({ text: "ok" }) });
    sendRequest("t", "turn/start", {
      threadId: "thr_window",
      providerThreadId,
      input: [{ type: "text", text: "hello", mentions: [] }],
      clientRequestId: CLIENT_REQUEST_ID,
      options: FULL_OPTIONS,
    });
    const reply = await waitForResponse("t");
    expect(reply.error).toBeUndefined();

    // `textTurnEvents` reports 9 tokens (7 in, 2 out) for the turn.
    const threadDeltas = deltas("thr_window");
    expect(threadDeltas.find((delta) => delta.kind === "usage")).toMatchObject({
      total: { totalTokens: 9 },
      last: { totalTokens: 9 },
      modelContextWindow: 1_000_000,
    });
    expect(threadDeltas.find((delta) => delta.kind === "contextWindow")).toEqual({
      kind: "contextWindow",
      used: 9,
      size: 1_000_000,
      estimated: true,
      attach: "currentOrLast",
    });
  });
});

describe("manual compaction", () => {
  // bb sends the standalone builtin `/compact` prompt as text with a builtin
  // command mention spanning it — the shape `provider/list`'s composer emits.
  const COMPACT_INPUT = [
    {
      type: "text",
      text: "/compact",
      mentions: [
        {
          start: 0,
          end: 8,
          resource: {
            kind: "command",
            trigger: "/",
            name: "compact",
            source: "command",
            origin: "builtin",
            label: "Compact",
            argumentHint: null,
          },
        },
      ],
    },
  ];

  it("maps the standalone /compact prompt onto prime's compact command", async () => {
    const providerThreadId = await startThread("s", "thr_compact");
    daemon.enqueue({
      commandType: "compact",
      events: [
        { type: "compaction_start", reason: "manual" },
        {
          type: "compaction_end",
          reason: "manual",
          aborted: false,
          willRetry: false,
        },
      ],
    });
    sendRequest("t", "turn/start", {
      threadId: "thr_compact",
      providerThreadId,
      input: COMPACT_INPUT,
      clientRequestId: CLIENT_REQUEST_ID,
      options: FULL_OPTIONS,
    });
    const reply = await waitForResponse("t");
    expect(reply.error).toBeUndefined();
    expect(daemon.commands.at(-1)?.type).toBe("compact");
    expect(daemon.commands.some((command) => command.type === "prompt")).toBe(false);
    // prime's own compaction events stream the timeline: the manual compaction
    // opens its turn, compacts, and settles it.
    const kinds = deltas("thr_compact").map((delta) => delta.kind);
    expect(kinds).toContain("input.accepted");
    expect(kinds).toContain("turn.open");
    expect(kinds).toContain("item.open");
    expect(kinds).toContain("item.close");
    expect(kinds).toContain("context.compacted");
    expect(deltas("thr_compact").at(-1)).toMatchObject({
      kind: "turn.boundary",
      status: "completed",
    });
    // The compaction state is tracked, and mirrored off the timeline.
    expect(sessionStateNotifications().at(-1)).toMatchObject({
      threadId: "thr_compact",
      isCompacting: false,
    });
  });

  it("reports a refused compaction as a failed turn when prime never started one", async () => {
    const providerThreadId = await startThread("s", "thr_compact_refused");
    daemon.enqueueFail("compact", "session is busy");
    sendRequest("t", "turn/start", {
      threadId: "thr_compact_refused",
      providerThreadId,
      input: COMPACT_INPUT,
      clientRequestId: CLIENT_REQUEST_ID,
      options: FULL_OPTIONS,
    });
    const reply = await waitForResponse("t");
    expect(reply.error).toBeUndefined();
    const compaction = deltas("thr_compact_refused");
    expect(compaction.some((delta) => delta.kind === "provider.error")).toBe(true);
    expect(compaction.at(-1)).toMatchObject({
      kind: "turn.boundary",
      status: "failed",
      error: { message: "session is busy" },
    });
  });

  it("renders prime's benign skip as a compaction-skipped warning, not a compaction", async () => {
    const providerThreadId = await startThread("s", "thr_compact_skip");
    daemon.enqueue({
      commandType: "compact",
      events: [
        { type: "compaction_start", reason: "manual" },
        {
          type: "compaction_end",
          reason: "manual",
          aborted: false,
          willRetry: false,
          errorMessage: "Session is too short to compact — try again once it grows",
          errorSeverity: "warning",
        },
      ],
    });
    sendRequest("t", "turn/start", {
      threadId: "thr_compact_skip",
      providerThreadId,
      input: COMPACT_INPUT,
      clientRequestId: CLIENT_REQUEST_ID,
      options: FULL_OPTIONS,
    });
    await waitForResponse("t");
    const threadDeltas = deltas("thr_compact_skip");
    const warning = threadDeltas.find(
      (delta) =>
        delta.kind === "provider.warning" && delta.category === "compaction-skipped",
    );
    expect(warning).toMatchObject({
      summary: "Context compaction skipped",
      details: "Session is too short to compact — try again once it grows",
    });
    // Nothing was compacted, so the timeline must not claim it was.
    expect(threadDeltas.some((delta) => delta.kind === "context.compacted")).toBe(false);
    expect(threadDeltas.at(-1)).toMatchObject({
      kind: "turn.boundary",
      status: "completed",
    });
  });

  it("keeps compaction events for automatic compactions off the turn ladder", async () => {
    const providerThreadId = await startThread("s", "thr_compact_auto");
    daemon.enqueuePrompt({
      events: [
        { type: "agent_start" },
        { type: "compaction_start", reason: "threshold" },
        {
          type: "compaction_end",
          reason: "threshold",
          aborted: false,
          willRetry: false,
        },
        ...textTurnEvents({ text: "ok" }),
      ],
    });
    sendRequest("t", "turn/start", {
      threadId: "thr_compact_auto",
      providerThreadId,
      input: [{ type: "text", text: "hello", mentions: [] }],
      clientRequestId: CLIENT_REQUEST_ID,
      options: FULL_OPTIONS,
    });
    await waitForResponse("t");
    const threadDeltas = deltas("thr_compact_auto");
    // An automatic compaction rides the running turn: no extra boundary of its
    // own, just the compacted marker on the timeline.
    expect(threadDeltas.filter((delta) => delta.kind === "turn.boundary")).toHaveLength(1);
    expect(threadDeltas.some((delta) => delta.kind === "context.compacted")).toBe(true);
    expect(providerThreadId).toBe("prime_sess_1");
  });

  it("fails a /compact on a thread the bridge never attached", async () => {
    sendRequest("t", "turn/start", {
      threadId: "thr_missing",
      providerThreadId: "prime_sess_1",
      input: COMPACT_INPUT,
      clientRequestId: CLIENT_REQUEST_ID,
      options: FULL_OPTIONS,
    });
    const reply = await waitForResponse("t");
    expect(reply.error?.code).toBe(BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS);
  });

  it("declares manual compaction, so bb offers the /compact affordance", () => {
    expect(primeProviderDeclaration().capabilities.supportsManualCompaction).toBe(
      true,
    );
  });
});

describe("the attached-clients badge (story 21)", () => {
  it("mirrors how many other clients are attached, from the attach summary and the poll", async () => {
    vi.useFakeTimers();
    try {
      // bb is one of the attached clients; the badge counts the others.
      daemon.enqueueCreate();
      daemon.enqueueAttach({ summary: { attachedClients: 2 } });
      // Prime has no push for other clients' attach/detach (spike, wire
      // facts), so the lane polls: the scripted daemon now reports four.
      daemon.enqueueData("get_state", {
        activeSessionId: "sess_1",
        attachedClients: 4,
      });
      sendRequest("s", "thread/start", {
        threadId: "thr_badge",
        cwd,
        instructionMode: "append",
        options: FULL_OPTIONS,
      });
      // The attach summary is the badge's first datum, free with the attach.
      await vi.advanceTimersByTimeAsync(0);
      expect(sessionStateNotifications().at(-1)).toMatchObject({
        threadId: "thr_badge",
        source: "attach",
        attachedClients: 2,
        otherClients: 1,
      });

      // One slow poll later the mirror carries the count prime holds now.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sessionStateNotifications().at(-1)).toMatchObject({
        threadId: "thr_badge",
        source: "clients-read",
        attachedClients: 4,
        otherClients: 3,
      });
      // Exactly one poll went out for the whole minute — the read is windowed.
      expect(
        daemon.commands.filter((command) => command.type === "get_state"),
      ).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops polling once the lane is released", async () => {
    vi.useFakeTimers();
    try {
      daemon.enqueueCreate();
      daemon.enqueueAttach({ summary: { attachedClients: 1 } });
      sendRequest("s", "thread/start", {
        threadId: "thr_badge",
        cwd,
        instructionMode: "append",
        options: FULL_OPTIONS,
      });
      await vi.advanceTimersByTimeAsync(0);
      messages();
      daemon.enqueueOk("detach");
      sendRequest("r", "thread/stop", {
        threadId: "thr_badge",
        providerThreadId: "prime_sess_1",
        intent: "release",
        activeTurnId: null,
      });
      await vi.advanceTimersByTimeAsync(0);
      const mirrorsBeforeRelease = sessionStateNotifications().length;

      // Long past the release: no timer left, so no reads and no mirrors.
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(
        daemon.commands.filter((command) => command.type === "get_state"),
      ).toEqual([]);
      expect(sessionStateNotifications()).toHaveLength(mirrorsBeforeRelease);
    } finally {
      vi.useRealTimers();
    }
  });
});

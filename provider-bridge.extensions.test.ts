import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  experimental_captureBridgeJsonRpcOutput as captureBridgeJsonRpcOutput,
  type CapturedBridgeJsonRpcOutput,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import {
  dynamicToolsRegistryForTests,
  handleLine,
  resetDaemonForTests,
  sessionTableForTests,
} from "./src/provider-bridge.js";
import { setPrimeDaemonTransportFactoryForTests } from "./src/daemon/connection.js";
import { companionExtensionPath } from "./src/dynamic-tools/registry.js";
import { BB_TOOLS_CHANNEL_FLAG } from "./src/dynamic-tools/protocol.js";
import {
  createScriptedDaemon,
  textTurnEvents,
  type ScriptedDaemonHandle,
} from "./test-support/scripted-daemon.js";
import { FakeExtension } from "./test-support/fake-extension.js";

/**
 * The extension picker on the session path (bbpa-ggf.12): the selection the
 * provider settings derived rides `options.providerOptions` into `thread/start`
 * and nowhere else, lands in `create.config.extensions` next to the
 * dynamic-tools companion extension (bbpa-ggf.13) under the unconditional
 * `noExtensions: true`, and never reaches a session that already exists — a
 * resume attaches to the resident worker without re-sending `create`.
 */

const ENABLED = [
  "/tmp/prime-extensions/alpha.ts",
  "/tmp/prime-extensions/beta/index.ts",
];

let output: CapturedBridgeJsonRpcOutput;
let collected: unknown[] = [];
let daemon: ScriptedDaemonHandle;

beforeEach(() => {
  output = captureBridgeJsonRpcOutput();
  collected = [];
  daemon = createScriptedDaemon({
    session: {
      activeSessionId: "sess_ext",
      sessionFile: "/tmp/prime/sessions/sess_ext.jsonl",
      sessionName: "[bb] extension picker thread",
      cwd: "/tmp/prime-workspace",
    },
  });
  setPrimeDaemonTransportFactoryForTests(() => daemon.transport);
});

afterEach(async () => {
  output.restore();
  setPrimeDaemonTransportFactoryForTests(undefined);
  resetDaemonForTests();
  sessionTableForTests().clear();
  await dynamicToolsRegistryForTests().clear();
});

interface Response {
  id: string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

function responses(): Response[] {
  collected.push(...output.takeMessages());
  return collected.filter(
    (message): message is Response =>
      typeof message === "object" &&
      message !== null &&
      !("method" in (message as Record<string, unknown>)),
  );
}

/** Poll for an answer that lands on a later tick (async handlers). */
async function waitForResponse(id: string, timeoutMs = 2_000): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = responses().find((message) => message.id === id);
    if (found !== undefined) {
      return found;
    }
    if (Date.now() > deadline) {
      throw new Error(`no response with id ${id} within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function waitFor(
  label: string,
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function commands(type: string): Array<Record<string, unknown>> {
  return daemon.commands.filter(
    (command) => command.type === type,
  ) as Array<Record<string, unknown>>;
}

function createConfig(create: Record<string, unknown>): Record<string, unknown> {
  return create.config as Record<string, unknown>;
}

const FULL_OPTIONS = {
  permissionMode: "full",
  permissionScope: "full",
  approvalReviewer: null,
  permissionEscalation: null,
};

/** Options carrying the picker's derived selection. */
function pickerOptions(enabled: unknown): Record<string, unknown> {
  return { ...FULL_OPTIONS, providerOptions: { enabledExtensions: enabled } };
}

/** Enqueue a full start (create, attach, first turn) and send `thread/start`. */
function sendStart(
  id: string,
  threadId: string,
  options: Record<string, unknown>,
  dynamicTools?: unknown[],
): void {
  daemon.enqueueCreate();
  daemon.enqueueAttach();
  daemon.enqueuePrompt({ events: textTurnEvents({ text: "ok" }) });
  daemon.enqueueOk("abort");
  daemon.enqueueOk("detach");
  handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "thread/start",
      params: {
        threadId,
        cwd: "/tmp/prime-workspace",
        instructionMode: "append",
        input: [{ type: "text", text: "hi", mentions: [] }],
        options,
        ...(dynamicTools === undefined ? {} : { dynamicTools }),
      },
    }),
  );
}

const DYNAMIC_TOOLS = [
  {
    name: "bb_echo",
    description: "Echo a message back",
    inputSchema: {
      type: "object" as const,
      properties: { message: { type: "string" as const } },
      required: ["message"],
    },
  },
];

/**
 * Start a thread that declares bb tools, with the companion extension actually
 * connected so the create/answer flow completes instead of degrading.
 */
async function startToolsThread(
  id: string,
  threadId: string,
  options: Record<string, unknown>,
): Promise<FakeExtension> {
  sendStart(id, threadId, options, DYNAMIC_TOOLS);
  const registry = dynamicToolsRegistryForTests();
  await waitFor("the channel to listen", () => registry.channel(threadId) !== undefined);
  const channelPath =
    registry.sessionConfig(threadId)?.extensionFlagValues[BB_TOOLS_CHANNEL_FLAG];
  const extension = await FakeExtension.connect(channelPath!);
  await waitForResponse(id);
  return extension;
}

describe("the extension picker on the session path", () => {
  it("loads exactly the enabled extensions into the new session", async () => {
    sendStart("t1", "thr_pick", pickerOptions(ENABLED));
    const reply = await waitForResponse("t1");

    expect(reply.error).toBeUndefined();
    const [create] = commands("create");
    const config = createConfig(create!);
    expect(config.extensions).toEqual(ENABLED);
    // Discovery stays off: the picker is the only way code enters a session.
    expect(config.noExtensions).toBe(true);
    // User extensions carry no flag values; that channel is the companion's.
    expect(config.extensionFlagValues).toBeUndefined();
  });

  it("appends the companion extension when the thread also declares dynamic tools", async () => {
    const extension = await startToolsThread("t1", "thr_both", pickerOptions(ENABLED));
    try {
      const config = createConfig(commands("create")[0]!);
      // The user extensions first, the bb channel last — one explicit `-e`
      // list, deduplicated, under the same `-ne` as ever.
      expect(config.extensions).toEqual([...ENABLED, companionExtensionPath()]);
      const flagValues = config.extensionFlagValues as Record<string, string>;
      expect(flagValues[BB_TOOLS_CHANNEL_FLAG]).toBe(
        dynamicToolsRegistryForTests().sessionConfig("thr_both")?.extensionFlagValues[
          BB_TOOLS_CHANNEL_FLAG
        ],
      );
    } finally {
      await extension.close();
    }
  });

  it("changes nothing when the selection is absent, empty, or unusable", async () => {
    sendStart("t1", "thr_plain", FULL_OPTIONS);
    await waitForResponse("t1");
    expect(commands("create").length).toBe(1);
    expect(createConfig(commands("create")[0]!).extensions).toBeUndefined();

    sendStart("t2", "thr_empty", pickerOptions([]));
    await waitForResponse("t2");
    expect(commands("create").length).toBe(2);
    expect(createConfig(commands("create")[1]!).extensions).toBeUndefined();

    sendStart(
      "t3",
      "thr_junk",
      pickerOptions([
        "relative.ts",
        42,
        null,
        "   ",
        "  /tmp/once.ts",
        "/tmp/../tmp/once.ts",
      ]),
    );
    await waitForResponse("t3");
    expect(commands("create").length).toBe(3);
    // Only absolute path strings survive, deduplicated.
    expect(createConfig(commands("create")[2]!).extensions).toEqual(["/tmp/once.ts"]);
  });

  it("keeps the companion alone when a junk selection rides a dynamic-tools thread", async () => {
    sendStart("t1", "thr_junk_tools", pickerOptions(["nope", 7]), DYNAMIC_TOOLS);
    // No extension connects here, so the channel degrades off the timeline and
    // the session still comes up — the create is what this test reads.
    await waitFor("the create command", () => commands("create").length === 1);

    expect(createConfig(commands("create")[0]!).extensions).toEqual([
      companionExtensionPath(),
    ]);
  });

  it("never re-writes an existing session when the selection changes", async () => {
    sendStart("t1", "thr_live", pickerOptions(ENABLED));
    await waitForResponse("t1");
    expect(commands("create").length).toBe(1);

    // The user flipped the picker between turns: the resume carries a new
    // selection, but the resident session was already created with the old one.
    daemon.enqueueAttach();
    handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "t2",
        method: "thread/resume",
        params: {
          threadId: "thr_live",
          providerThreadId: "prime_sess_ext",
          cwd: "/tmp/prime-workspace",
          instructionMode: "append",
          options: pickerOptions(["/tmp/prime-extensions/changed.ts"]),
        },
      }),
    );
    const reply = await waitForResponse("t2");
    expect(reply.error).toBeUndefined();

    expect(commands("create").length).toBe(1);
    expect(createConfig(commands("create")[0]!).extensions).toEqual(ENABLED);
    // And the resumed session answered through attach, not a second create.
    expect(commands("attach").length).toBe(2);
  });
});

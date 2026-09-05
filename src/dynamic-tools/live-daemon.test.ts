import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { PrimeDaemonClient } from "../daemon/client.js";
import { resolveDaemonSocketPath } from "../daemon/socket.js";
import { DynamicToolsRegistry, companionExtensionPath } from "./registry.js";
import { BB_TOOLS_CHANNEL_FLAG } from "./protocol.js";

/**
 * The acceptance proof for the dynamic-tools channel, against the **real**
 * installed prime-agent daemon (not a fixture).
 *
 * Gated behind `BBPA_LIVE_DAEMON=1` because it needs the daemon, its auth, and
 * a model. It creates exactly one throwaway session named "[bb] …", drives a
 * bb dynamic tool through it with a scripted executor standing in for the
 * `item/tool/call` wiring (bbpa-ggf.3), and then kills the session and deletes
 * only its own saved session file. Pre-existing sessions, the daemon process,
 * and anything outside this test's temp dirs are never touched.
 */
const live = process.env.BBPA_LIVE_DAEMON === "1";
const describeLive = live ? describe : describe.skip;

const ECHO_TOOL = {
  name: "bb_echo",
  description: "Echo the message back. Proof that bb-provided tools work in this session.",
  inputSchema: {
    type: "object",
    properties: { message: { type: "string", description: "Text to echo" } },
    required: ["message"],
  },
};

const ECHO_PROMPT =
  "Use the bb_echo tool on the text: ping. Then reply with exactly the text the bb_echo tool returned, and nothing else.";
const ECHO_RESULT = "[bb-echo] ping";
const SESSION_NAME = "[bb] ggf13-dynamic-tools-proof";
const PROVIDER_THREAD_ID = "prime_live_ggf13";

let client: PrimeDaemonClient | undefined;
let registry: DynamicToolsRegistry | undefined;
let workDir: string | undefined;
let sessionId: string | undefined;
let sessionPath: string | undefined;
const events: Record<string, unknown>[] = [];

describeLive("the live prime-agent dynamic-tools channel", () => {
  afterAll(async () => {
    // Safety net when the test itself failed mid-way.
    await cleanup();
    client?.close();
    client = undefined;
  });

  afterEach(() => {
    events.length = 0;
  });

  it(
    "delivers a bb tool into a real prime session, executes the model's call through the bridge, and returns the result",
    { timeout: 240_000 },
    async () => {
      // 0. the daemon, our channel, and a throwaway cwd.
      const daemon = new PrimeDaemonClient({ socketPath: resolveDaemonSocketPath() });
      const hello = await daemon.connect(5_000).catch((error: Error) => {
        throw new Error(
          `BBPA_LIVE_DAEMON=1 needs a reachable prime-agent daemon at ${resolveDaemonSocketPath()}: ${error.message}`,
        );
      });
      client = daemon;
      expect(hello.protocol).toEqual({ name: "prime-agent.daemon", version: 7 });

      workDir = mkdtempSync(join(tmpdir(), "bbpa-live-dynamic-tools-"));
      registry = new DynamicToolsRegistry();
      // The scripted executor: exactly what the `item/tool/call` outbound
      // request will do once bbpa-ggf.3 wires the chat path.
      const executedCalls: { name: string; args: Record<string, unknown> }[] = [];
      const channel = await registry.start({
        providerThreadId: PROVIDER_THREAD_ID,
        onToolCall: async (call) => {
          executedCalls.push({ name: call.name, args: call.args });
          return { ok: true, content: `[bb-echo] ${String(call.args.message ?? "")}` };
        },
      });
      daemon.onPush = (message) => {
        if (message.type === "session_event") {
          events.push(message.event as Record<string, unknown>);
        }
      };

      // 1. create: the per-session config loads ONLY the companion extension
      //    (noExtensions:true) and hands it the channel path through the
      //    extension flag.
      const create = await daemon.request({
        type: "create",
        name: SESSION_NAME,
        lifecycle: "resident",
        config: {
          cwd: workDir,
          agentDir: join(homedir(), ".prime", "agent"),
          noExtensions: true,
          extensions: [companionExtensionPath()],
          noSkills: false,
          extensionFlagValues: { [BB_TOOLS_CHANNEL_FLAG]: channel.path },
        },
      });
      expect(create.success).toBe(true);
      const data = (create.data ?? {}) as Record<string, unknown>;
      const summary = (data.summary ?? {}) as Record<string, unknown>;
      sessionId = String(data.activeSessionId ?? "");
      sessionPath = String(
        summary.sessionPath ?? summary.sessionFile ?? data.sessionPath ?? data.sessionFile ?? "",
      );
      expect(sessionId).not.toBe("");
      expect(sessionPath).not.toBe("");

      // 2. publish the bb tool set: resolves only once the REAL extension
      //    connected to the channel and registered the tool inside prime.
      const setAck = await registry.setTools(PROVIDER_THREAD_ID, [ECHO_TOOL], { timeoutMs: 30_000 });
      expect(setAck.ok).toBe(true);
      expect(setAck.registered).toEqual(["bb_echo"]);

      // 3. attach and confirm prime itself sees the tool.
      const attach = await daemon.request({
        type: "attach",
        activeSessionId: sessionId,
        capabilities: [
          "attach_snapshot",
          "event_sequence",
          "slim_attach",
          "chunked_snapshot",
          "client_owned_sessions",
        ],
      });
      expect(attach.success).toBe(true);
      const definition = await daemon.request({
        type: "get_tool_definition",
        activeSessionId: sessionId,
        name: "bb_echo",
      });
      expect(definition.success).toBe(true);
      const toolDefinition = (definition.data as Record<string, unknown> | undefined)
        ?.toolDefinition as Record<string, unknown> | undefined;
      expect(toolDefinition).not.toBeNull();
      expect(toolDefinition?.name).toBe("bb_echo");

      // 4. the model calls the bb tool; the scripted executor answers and the
      //    result comes back into the session.
      const prompt = await daemon.request({
        type: "prompt",
        activeSessionId: sessionId,
        message: ECHO_PROMPT,
      });
      expect(prompt.success).toBe(true);

      const toolStart = (): Record<string, unknown> | undefined =>
        events.find(
          (event) => event.type === "tool_execution_start" && event.toolName === "bb_echo",
        ) as Record<string, unknown> | undefined;
      const toolEnd = (): Record<string, unknown> | undefined =>
        events.find(
          (event) => event.type === "tool_execution_end" && event.toolName === "bb_echo",
        ) as Record<string, unknown> | undefined;
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        // The run closes with turn_end ×2 + agent_end; the quoting assistant
        // message only exists after the second model round.
        if (toolStart() !== undefined && toolEnd() !== undefined && runEnded()) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
      }

      // The extension forwarded the model's call to the bridge channel...
      expect(executedCalls).toEqual([{ name: "bb_echo", args: { message: "ping" } }]);
      // ...prime executed the registered tool with those arguments...
      expect(toolStart()).toBeDefined();
      expect(toolStart()?.args).toEqual({ message: "ping" });
      // ...and the scripted result landed in the session unchanged — both on
      // the executed tool and on the toolResult message the model reads.
      expect(toolEnd()).toBeDefined();
      expect(toolEnd()?.isError).toBe(false);
      expect(toolEnd()?.result).toMatchObject({
        content: [{ type: "text", text: ECHO_RESULT }],
      });
      expect(
        events.some(
          (event) =>
            (event.type === "message_end" || event.type === "message_start") &&
            (event.message as Record<string, unknown> | undefined)?.role === "toolResult" &&
            JSON.stringify((event.message as Record<string, unknown>).content ?? []).includes(ECHO_RESULT),
        ),
      ).toBe(true);

      // 5. the assistant message reflects the tool result.
      expect(turnEnded()).toBe(true);
      expect(runEnded()).toBe(true);
      expect(assistantText()).toContain(ECHO_RESULT);

      // 6. clean up our own session only, and prove the deletion answered.
      await cleanup({ expectDeleted: true });
    },
  );
});

function turnEnded(): boolean {
  return events.some((event) => event.type === "turn_end");
}

function runEnded(): boolean {
  return events.some((event) => event.type === "agent_end");
}

function assistantText(): string {
  return events
    .filter((event) => event.type === "message_end" || event.type === "message_update")
    .map((event) => event.message as Record<string, unknown> | undefined)
    .filter((message) => message?.role === "assistant")
    .flatMap((message) =>
      Array.isArray(message?.content) ? (message.content as Record<string, unknown>[]) : [],
    )
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
}

/**
 * Kill the session this test created and delete only its saved session file.
 * Idempotent: whatever was already cleaned up is skipped, so the afterAll net
 * never touches anything twice.
 */
async function cleanup(args: { expectDeleted?: boolean } = {}): Promise<void> {
  const daemon = client;
  const id = sessionId;
  const path = sessionPath;
  sessionId = undefined;
  sessionPath = undefined;
  let deleted = false;
  if (daemon !== undefined && id !== undefined) {
    await daemon.request({ type: "abort", activeSessionId: id }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const kill = await daemon.request({ type: "kill", activeSessionId: id }).catch(() => undefined);
    if (kill?.success === true && path !== undefined) {
      const deletion = await daemon
        .request({ type: "delete_saved_session", sessionPath: path })
        .catch(() => undefined);
      deleted = deletion?.success === true;
    }
  }
  if (registry !== undefined) {
    await registry.clear();
    registry = undefined;
  }
  if (workDir !== undefined) {
    rmSync(workDir, { recursive: true, force: true });
    workDir = undefined;
  }
  if (args.expectDeleted) {
    expect(deleted).toBe(true);
  }
}

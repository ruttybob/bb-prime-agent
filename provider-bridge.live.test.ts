import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
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
import { BB_TOOLS_CHANNEL_FLAG } from "./src/dynamic-tools/protocol.js";
import { FakeExtension } from "./test-support/fake-extension.js";
import { PrimeDaemonClient } from "./src/daemon/client.js";
import { resolveDaemonSocketPath } from "./src/daemon/socket.js";
import {
  BB_SESSION_NAME_PREFIX,
  primeSessionName,
} from "./src/session-params.js";

/**
 * The live lane: a real turn against the real installed prime-agent daemon.
 *
 * Gated behind `BBPA_LIVE_DAEMON=1` so the default suite stays hermetic — this
 * test creates a daemon session of its own (named with the "[bb] " prefix and a
 * nonce), asserts the streamed turn, the prime catalog entry, the mid-turn
 * steer (bbpa-ggf.5), and the soft stop, then removes exactly that one session
 * (`kill` + `delete_saved_session`). It never touches a session it did not
 * create: the `list` check filters to the test's own name, and cleanup
 * addresses the `activeSessionId` the create answered with.
 *
 * With `BBPA_LIVE_RECORD_DIR=<dir>` the same run also writes a recording cell
 * (all four lanes plus a manifest) into that directory — the input for the
 * plugin's committed recordings and their replay test.
 */

const LIVE = process.env.BBPA_LIVE_DAEMON === "1";
const RECORD_DIR = process.env.BBPA_LIVE_RECORD_DIR;

let output: CapturedBridgeJsonRpcOutput;
let collected: unknown[] = [];
let workspaceDir: string;
let cleanupSession:
  | { activeSessionId: string; sessionFile?: string; name: string }
  | undefined;

const runtimeLines: string[] = [];
const bridgeLines: string[] = [];
let liveExtension: FakeExtension | undefined;

beforeEach(() => {
  if (!LIVE) {
    return;
  }
  if (RECORD_DIR !== undefined && RECORD_DIR.trim() !== "") {
    // The bridge tees its provider lanes when record mode is on in its process.
    rmSync(RECORD_DIR.trim(), { recursive: true, force: true });
    process.env.BB_PROVIDER_BRIDGE_RECORD_DIR = RECORD_DIR.trim();
  }
  runtimeLines.length = 0;
  bridgeLines.length = 0;
  output = captureBridgeJsonRpcOutput();
  collected = [];
  workspaceDir = mkdtempSync(join(tmpdir(), "bb-prime-live-"));
});

afterEach(async () => {
  if (!LIVE) {
    return;
  }
  delete process.env.BB_PROVIDER_BRIDGE_RECORD_DIR;
  output.restore();
  resetDaemonForTests();
  sessionTableForTests().clear();
  // Cleanup is not optional: remove exactly the session this test created.
  const stale = cleanupSession;
  if (stale !== undefined) {
    try {
      await withTestClient(async (client) => {
        await client.request({
          type: "kill",
          activeSessionId: stale.activeSessionId,
        });
        if (stale.sessionFile !== undefined) {
          await client.request({
            type: "delete_saved_session",
            sessionPath: stale.sessionFile,
          });
        }
      });
    } catch {
      // A daemon that disappeared already took the resident session with it.
    }
    cleanupSession = undefined;
  }
  rmSync(workspaceDir, { recursive: true, force: true });
  await liveExtension?.close();
  liveExtension = undefined;
  await dynamicToolsRegistryForTests().clear();
});

async function withTestClient(
  run: (client: PrimeDaemonClient) => Promise<void>,
): Promise<void> {
  const client = new PrimeDaemonClient({
    socketPath: resolveDaemonSocketPath(),
    clientId: "bbpa-live-test",
  });
  try {
    await client.connect();
    await run(client);
  } finally {
    client.close();
  }
}

function sendRequest(id: string, method: string, params: unknown): void {
  const line = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  runtimeLines.push(line);
  handleLine(line);
}

let DEBUG_LIVE = process.env.BBPA_LIVE_DEBUG === "1";

function messages(): unknown[] {
  for (const message of output.takeMessages()) {
    const line = JSON.stringify(message);
    bridgeLines.push(line);
    if (DEBUG_LIVE) {
      console.info("[bridge]", line.slice(0, 300));
    }
    collected.push(message);
  }
  return collected;
}

function deltas(threadId: string): Array<Record<string, unknown>> {
  return messages()
    .filter(
      (message): message is { method: string; params: Record<string, unknown> } =>
        typeof message === "object" &&
        message !== null &&
        (message as Record<string, unknown>).method === "thread/delta",
    )
    .filter((message) => message.params.threadId === threadId)
    .flatMap((message) => message.params.deltas as Array<Record<string, unknown>>);
}

interface LiveResponse {
  id: string;
  result?: Record<string, unknown>;
  error?: unknown;
}

function responses(): LiveResponse[] {
  return messages().filter(
    (message): message is LiveResponse =>
      typeof message === "object" &&
      message !== null &&
      !("method" in (message as Record<string, unknown>)),
  );
}

async function waitFor(
  label: string,
  predicate: () => boolean,
  timeoutMs = 90_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const FULL_OPTIONS = {
  permissionMode: "full",
  permissionScope: "full",
  approvalReviewer: null,
  permissionEscalation: null,
};

it.skipIf(!LIVE)(
  "exchanges a full streamed turn with the installed prime-agent",
  async () => {
    const nonce = Math.random().toString(36).slice(2, 8);
    const threadId = `thr_live_${nonce}`;
    const prompt =
      "Call the bb_echo tool right now with message 'ping from bb'. Do not use any other tool and do not investigate anything. Then reply with exactly what it returned.";
    // The name the bridge must give prime: prefix + title + thread id.
    const name = primeSessionName({ threadId, title: prompt });
    expect(name.startsWith(BB_SESSION_NAME_PREFIX)).toBe(true);

    // --- thread/start with the cheap prompt: the whole turn streams in. ---
    sendRequest("s", "thread/start", {
      threadId,
      cwd: workspaceDir,
      instructionMode: "append",
      options: FULL_OPTIONS,
      input: [{ type: "text", text: prompt, mentions: [] }],
      dynamicTools: [
        {
          name: "bb_echo",
          description: "Echo the provided message back, prefixed with [bb-echo].",
          inputSchema: {
            type: "object",
            properties: { message: { type: "string", description: "Message to echo" } },
            required: ["message"],
          },
        },
      ],
    });
    // The channel listens before `create`; the REAL companion extension
    // (loaded by the prime worker from create.config.extensions) connects and
    // acks, which lets the reply through.
    await waitFor("the dynamic-tools channel", () =>
      dynamicToolsRegistryForTests().channel(threadId) !== undefined,
    );
    await waitFor("the thread/start response", () =>
      responses().some((reply) => reply.id === "s"),
    );
    const startReply = responses().find((reply) => reply.id === "s")!;
    expect(startReply.error).toBeUndefined();
    const providerThreadId = startReply.result?.providerThreadId;
    expect(providerThreadId).toMatch(/^prime_/);
    expect(startReply.result?.sessionRestorable).toBe(true);

    const record = sessionTableForTests().byThread(threadId);
    // prime's active session ids are opaque hashes, not prefixed strings.
    expect(record?.activeSessionId).toMatch(/^[0-9a-f_-]{6,}$/i);
    cleanupSession = {
      activeSessionId: record!.activeSessionId!,
      sessionFile: record?.sessionFile,
      name,
    };
    // The companion extension actually registered the bb tool in the worker.
    await withTestClient(async (client) => {
      const tool = await client.request({
        type: "get_tool_definition",
        activeSessionId: record!.activeSessionId!,
        name: "bb_echo",
      });
      expect(tool.success, `get_tool_definition failed: ${tool.error}`).toBe(true);
    });
    expect(record?.sessionName).toBe(name);
    expect(record?.cwd).toBe(workspaceDir);

    // A full streamed turn: opened, streamed, usage, settled. While it runs,
    // the runtime half of this harness answers the bridge's item/tool/call
    // (the companion extension forwarded the model's bb_echo call) — the same
    // {success, contentItems} shape the real bb runtime answers with.
    let settled = false;
    const answeredToolCalls = new Set<unknown>();
    const toolCallAnswerer = (async () => {
      for (;;) {
        const calls = messages().filter(
          (message) =>
            (message as { method?: string }).method === "item/tool/call" &&
            !answeredToolCalls.has((message as { id?: unknown }).id),
        ) as Array<{ id: unknown; params: { tool: string; arguments: Record<string, unknown> } }>;
        for (const call of calls) {
          answeredToolCalls.add(call.id);
          expect(call.params.tool).toBe("bb_echo");
          handleLine(
            JSON.stringify({
              jsonrpc: "2.0",
              id: call.id,
              result: {
                success: true,
                contentItems: [
                  { type: "inputText", text: `[bb-echo] ${call.params.arguments.message}` },
                ],
              },
            }),
          );
        }
        if (settled) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    })();
    await waitFor("the first turn to settle", () =>
      deltas(threadId).some(
        (delta) => delta.kind === "turn.boundary" && delta.status === "completed",
      ),
    );
    settled = true;
    await toolCallAnswerer;
    expect(answeredToolCalls.size).toBeGreaterThanOrEqual(1);
    const kinds = deltas(threadId).map((delta) => delta.kind);
    expect(kinds[0]).toBe("session.reset");
    for (const kind of ["turn.open", "item.textDelta", "item.textClose", "usage"]) {
      expect(kinds).toContain(kind);
    }
    const streamed = deltas(threadId)
      .filter((delta) => delta.kind === "item.textDelta")
      .map((delta) => String(delta.text))
      .join("");
    // The answer quotes what the bb tool returned: the full round trip worked.
    expect(streamed).toContain("[bb-echo] ping from bb");
    expect(deltas(threadId).find((delta) => delta.kind === "usage")).toMatchObject({
      last: { totalTokens: expect.any(Number) },
    });
    expect(deltas(threadId).at(-1)).toMatchObject({
      kind: "turn.boundary",
      status: "completed",
    });

    // The session is in prime's own catalog, under the [bb] name and this cwd.
    await withTestClient(async (client) => {
      const listing = await client.request({ type: "list" });
      expect(listing.success).toBe(true);
      const sessions =
        (listing.data as { sessions?: Array<{ sessionName?: string; cwd?: string }> })
          .sessions ?? [];
      const mine = sessions.filter((session) => session.sessionName === name);
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ cwd: workspaceDir });
    });

    // --- A long turn, stopped: soft stop ends it, the file survives. ---
    sendRequest("t", "turn/start", {
      threadId,
      providerThreadId,
      input: [
        {
          type: "text",
          text: "Call the bash tool right now with the command `sleep 20`. Do not run any other tool first and do not explain. When the tool returns, reply with exactly this word and nothing else: DONE.",
          mentions: [],
        },
      ],
      clientRequestId: "creq_secndxturn",
      options: FULL_OPTIONS,
    });
    // The runtime awaits each answer before its next request; mirror that, so
    // the stop cannot race the prompt it is meant to interrupt.
    await waitFor("the turn/start response", () =>
      responses().some((reply) => reply.id === "t"),
    );
    await waitFor("the second turn to open", () =>
      deltas(threadId).filter((delta) => delta.kind === "turn.open").length >= 2,
    );
    const sessionFile = record?.sessionFile;
    expect(sessionFile).toBeDefined();
    expect(existsSync(sessionFile!)).toBe(true);

    sendRequest("p", "thread/stop", {
      threadId,
      providerThreadId,
      intent: "interrupt",
      activeTurnId: "turn-live-2",
    });
    await waitFor("the interrupt to settle the turn", () =>
      deltas(threadId).some(
        (delta) =>
          delta.kind === "turn.boundary" && delta.status === "interrupted",
      ),
    );
    expect(existsSync(sessionFile!)).toBe(true);

    // --- Steering (bbpa-ggf.5): redirect a running turn. The steer is queued
    // on prime's steering lane while the sleep tool round runs, delivered when
    // the running work settles, and the model answers it — on the calibrated
    // 0.7.3 daemon the steered answer streams as the follow-up run, which
    // opens the next bb turn. What must hold: the steered text lands on the
    // timeline, queue state surfaces, the answer streams after the steer, and
    // steering never interrupts the work in flight. ---
    sendRequest("u", "turn/start", {
      threadId,
      providerThreadId,
      input: [
        {
          type: "text",
          text: "Call the bash tool right now with the command `sleep 20`. Do not run any other tool first and do not explain. When the tool returns, reply with exactly this word and nothing else: DONE.",
          mentions: [],
        },
      ],
      clientRequestId: "creq_thrdbbturn",
      options: FULL_OPTIONS,
    });
    await waitFor("the turn/start response", () =>
      responses().some((reply) => reply.id === "u"),
    );
    await waitFor("the third turn to open", () =>
      deltas(threadId).filter((delta) => delta.kind === "turn.open").length >= 3,
    );

    const steerText = "Reply with exactly this word and nothing else: STEERED";
    sendRequest("st", "turn/steer", {
      threadId,
      providerThreadId,
      expectedTurnId: "turn-live-3",
      input: [{ type: "text", text: steerText, mentions: [] }],
      clientRequestId: "creq_steerabcdx",
      options: FULL_OPTIONS,
    });
    await waitFor("the steer response", () =>
      responses().some((reply) => reply.id === "st"),
    );
    const steerReply = responses().find((reply) => reply.id === "st")!;
    expect(steerReply.error).toBeUndefined();
    expect(steerReply.result).toEqual({ threadId });
    // The acceptance and the steered text are on the timeline.
    expect(
      deltas(threadId).some(
        (delta) =>
          delta.kind === "input.accepted" && delta.clientRequestId === "creq_steerabcdx",
      ),
    ).toBe(true);
    expect(
      deltas(threadId).some(
        (delta) => delta.kind === "input.provider" && delta.text === steerText,
      ),
    ).toBe(true);
    // Prime's waiting-lane announcement surfaces as queue state.
    await waitFor("the queue state delta", () =>
      deltas(threadId).some(
        (delta) =>
          delta.kind === "extension.state" &&
          delta.extensionKind === "prime-agent/queue",
      ),
    );

    const steerIndex = deltas(threadId).findIndex(
      (delta) => delta.kind === "input.provider" && delta.text === steerText,
    );
    expect(steerIndex).toBeGreaterThanOrEqual(0);
    const streamedText = (list: Array<Record<string, unknown>>): string =>
      list
        .filter((delta) => delta.kind === "item.textDelta")
        .map((delta) => String(delta.text))
        .join("");
    await waitFor("the steered answer to stream", () =>
      streamedText(deltas(threadId)).includes("STEERED"),
    );
    // The steered answer comes after the steer landed (the streamed text
    // before it holds no STEERED — the word is not quoted back early), and
    // steering never interrupts: nothing settled as interrupted on the way.
    const allDeltas = deltas(threadId);
    expect(streamedText(allDeltas.slice(0, steerIndex))).not.toContain("STEERED");
    expect(
      allDeltas
        .slice(steerIndex)
        .some(
          (delta) =>
            delta.kind === "turn.boundary" && delta.status === "interrupted",
        ),
    ).toBe(false);

    // Release: the bridge lets go, the daemon session file stays.
    sendRequest("r", "thread/stop", {
      threadId,
      providerThreadId,
      intent: "release",
      activeTurnId: null,
    });
    await waitFor("the release response", () =>
      responses().some((reply) => reply.id === "r"),
    );
    expect(existsSync(sessionFile!)).toBe(true);
    expect(sessionTableForTests().byThread(threadId)).toBeUndefined();

    if (RECORD_DIR !== undefined && RECORD_DIR.trim() !== "") {
      writeCell(RECORD_DIR.trim(), {
        threadId,
        name,
        sessionFile: String(sessionFile),
        cwd: workspaceDir,
        providerThreadId: String(providerThreadId),
      });
    }
  },
  180_000,
);

/**
 * Assemble a recording cell from this run: the two runtime lanes this harness
 * captured, the two provider lanes the bridge teed in record mode, and a
 * manifest. The layout matches the committed cells (`recordings/<provider>/<cell>/`).
 */
function writeCell(
  cellDir: string,
  facts: {
    threadId: string;
    name: string;
    sessionFile: string;
    cwd: string;
    providerThreadId: string;
  },
): void {
  // The provider lanes are already inside this directory (the bridge teed them
  // under its process scope), so nothing here may wipe it.
  mkdirSync(cellDir, { recursive: true });
  const run = Date.now();
  let seq = 0;
  const writeLane = (dir: "runtime→bridge" | "bridge→runtime", lines: string[]) => {
    const body = lines
      .map((line) => JSON.stringify({ ts: Date.now(), run, seq: (seq += 1), dir, line }))
      .join("\n");
    writeFileSync(join(cellDir, `${dir}.ndjson`), body.length > 0 ? `${body}\n` : "");
  };
  writeLane("runtime→bridge", runtimeLines);
  writeLane("bridge→runtime", bridgeLines);

  // The bridge tees provider lanes under its process scope; flatten them.
  const processScope = join(cellDir, "_process");
  if (existsSync(processScope)) {
    for (const file of readdirSync(processScope)) {
      if (!file.endsWith(".ndjson")) {
        continue;
      }
      writeFileSync(
        join(cellDir, file),
        readFileSync(join(processScope, file), "utf8"),
        { flag: "a" },
      );
    }
    rmSync(processScope, { recursive: true, force: true });
  }

  const count = (dir: string): number => {
    const file = join(cellDir, `${dir}.ndjson`);
    return existsSync(file)
      ? readFileSync(file, "utf8").split("\n").filter((line) => line !== "").length
      : 0;
  };
  writeFileSync(
    join(cellDir, "manifest.json"),
    `${JSON.stringify(
      {
        provider: "prime-agent",
        cell: "live-turn",
        threadId: facts.threadId,
        scope: "thread",
        cliVersion: "bb-plugin-prime-agent 0.1.0",
        recordedAt: new Date().toISOString().slice(0, 10),
        description:
          "One live prime-agent turn: the resident session is created in the bb workspace, the reply streams as text deltas with usage and a completed boundary; a second turn is steered mid-flight (the steer lands in the same turn, queue state surfaces) and then soft-stopped (interrupt), the session survives, then the bridge releases it.",
        note: `Recorded against the machine's installed prime-agent daemon (session ${facts.name}, ${facts.sessionFile}, cwd ${facts.cwd}); the provider lanes carry the daemon wire. Replayed with BB_PRIME_AGENT_DAEMON_REPLAY_CELL pointed at the cell, so no daemon is needed.`,
        bridgeRuns: 1,
        lines: {
          "runtime→bridge": count("runtime→bridge"),
          "bridge→runtime": count("bridge→runtime"),
          "provider→bridge": count("provider→bridge"),
          "bridge→provider": count("bridge→provider"),
        },
      },
      null,
      2,
    )}\n`,
  );
}

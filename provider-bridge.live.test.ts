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
 * nonce), asserts the streamed turn, the prime catalog entry, and the soft
 * stop, then removes exactly that one session (`kill` +
 * `delete_saved_session`). It never touches a session it did not create: the
 * `list` check filters to the test's own name, and cleanup addresses the
 * `activeSessionId` the create answered with.
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
  // Cleanup is not optional: remove exactly the session this test created,
  // and check the daemon's own catalog before moving on. If prime still lists
  // the session after the bounded retries, say so loudly rather than failing
  // the lane — reaping a resident worker is prime's schedule, not ours.
  const stale = cleanupSession;
  if (stale !== undefined) {
    const removed = await removeDaemonSession(stale.activeSessionId);
    if (!removed) {
      console.warn(
        `[bb prime-agent live lane] the daemon still lists session ${stale.activeSessionId} (${stale.name}) after abort + kill + delete_saved_session; remove it from prime-agent's catalog if it lingers.`,
      );
    }
    cleanupSession = undefined;
  }
  rmSync(workspaceDir, { recursive: true, force: true });
  await liveExtension?.close();
  liveExtension = undefined;
  await dynamicToolsRegistryForTests().clear();
});

/**
 * Stop one daemon session and remove it, verified against the daemon's own
 * listing: abort (a settled turn still leaves the worker holding the
 * session), then kill, then delete the saved file, and retry the round while
 * the daemon still lists the session — a worker that is shutting down can
 * re-save its file, and prime reaps the process on its own schedule, so the
 * round runs (bounded ~15s) until the listing is clean. Answers false when
 * the daemon still lists the session after the last attempt; a daemon that
 * went away entirely took the resident session with it, which counts as
 * removed.
 */
async function removeDaemonSession(activeSessionId: string): Promise<boolean> {
  try {
    return await withTestClient(async (client) => {
      for (let attempt = 0; ; attempt += 1) {
        const listing = await client.request({ type: "list" });
        const sessions =
          (listing.data as
            | {
                sessions?: Array<{
                  activeSessionId?: string;
                  sessionFile?: string;
                }>;
              }
            | undefined)?.sessions ?? [];
        const entry = sessions.find(
          (session) => session.activeSessionId === activeSessionId,
        );
        if (entry === undefined) {
          return true;
        }
        await client.request({ type: "abort", activeSessionId });
        await client.request({ type: "kill", activeSessionId });
        if (entry.sessionFile !== undefined) {
          await client.request({
            type: "delete_saved_session",
            sessionPath: entry.sessionFile,
          });
        }
        if (attempt >= 19) {
          return false;
        }
        await new Promise((resolve) => setTimeout(resolve, 750));
      }
    });
  } catch (error) {
    if (isConnectFailure(error)) {
      // No daemon, no session.
      return true;
    }
    throw error;
  }
}

function isConnectFailure(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  return (
    code === "ECONNREFUSED" ||
    code === "ENOENT" ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT"
  );
}

async function withTestClient<T>(
  run: (client: PrimeDaemonClient) => Promise<T>,
): Promise<T> {
  const client = new PrimeDaemonClient({
    socketPath: resolveDaemonSocketPath(),
    clientId: "bbpa-live-test",
  });
  try {
    await client.connect();
    return await run(client);
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
          text: "Count slowly from 1 to 40, one number per line, with no other text.",
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

it.skipIf(!LIVE)(
  "runs a workspace prime skill from a slash mention",
  async () => {
    // A real prime project skill, in the workspace's `.prime/agent/skills/`:
    // the directory the declaration indexes into bb's "/" menu and the
    // directory the prime worker discovers at session boot.
    const skillName = `bbpa-live-${Math.random().toString(36).slice(2, 8)}`;
    const skillDir = join(workspaceDir, ".prime", "agent", "skills", skillName);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      [
        "---",
        `name: ${skillName}`,
        "description: Live-check skill for the bb prime-agent provider.",
        "---",
        "",
        "Reply with exactly the single line BBPA_SKILL_OK and nothing else.",
        "",
      ].join("\n"),
    );

    const threadId = `thr_live_${skillName}`;
    sendRequest("s", "thread/start", {
      threadId,
      cwd: workspaceDir,
      instructionMode: "append",
      options: FULL_OPTIONS,
      input: [
        {
          type: "text",
          text: `/${skillName}`,
          mentions: [
            {
              start: 0,
              end: skillName.length + 1,
              resource: {
                kind: "command",
                trigger: "/",
                name: skillName,
                source: "skill",
                origin: "project",
                label: skillName,
                argumentHint: null,
              },
            },
          ],
        },
      ],
    });
    await waitFor("the thread/start response", () =>
      responses().some((reply) => reply.id === "s"),
    );
    const startReply = responses().find((reply) => reply.id === "s")!;
    expect(startReply.error).toBeUndefined();
    const providerThreadId = String(startReply.result?.providerThreadId);

    const record = sessionTableForTests().byThread(threadId);
    cleanupSession = {
      activeSessionId: record!.activeSessionId!,
      sessionFile: record?.sessionFile,
      name: threadId,
    };

    // The worker discovered the skill and lists it as a skill-sourced command
    // — the daemon command listing the "/" menu mirrors.
    await withTestClient(async (client) => {
      const listing = await client.request({
        type: "get_commands",
        activeSessionId: record!.activeSessionId!,
      });
      expect(listing.success, `get_commands failed: ${listing.error}`).toBe(true);
      const entries =
        (listing.data as { commands?: Array<{ name?: string; source?: string }> })
          .commands ?? [];
      expect(
        entries.some(
          (entry) =>
            entry.name === `skill:${skillName}` && entry.source === "skill",
        ),
      ).toBe(true);
    });

    // The slash mention reached prime as `/skill:<name>` and prime ran it:
    // the reply is the skill's own instruction, not an echo of the mention.
    await waitFor("the skill turn to settle", () =>
      deltas(threadId).some(
        (delta) => delta.kind === "turn.boundary" && delta.status === "completed",
      ),
    );
    const streamed = deltas(threadId)
      .filter((delta) => delta.kind === "item.textDelta")
      .map((delta) => String(delta.text))
      .join("");
    expect(streamed).toContain("BBPA_SKILL_OK");
    expect(providerThreadId).toMatch(/^prime_/);

    // Release through the bridge (the supported detach path) before the
    // afterEach removes the daemon session.
    sendRequest("r", "thread/stop", {
      threadId,
      providerThreadId,
      intent: "release",
      activeTurnId: "turn-live-skill",
    });
    await waitFor("the release response", () =>
      responses().some((reply) => reply.id === "r"),
    );
    expect(sessionTableForTests().byThread(threadId)).toBeUndefined();
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
          "One live prime-agent turn: the resident session is created in the bb workspace, the reply streams as text deltas with usage and a completed boundary; a second turn is soft-stopped (interrupt) and the session survives, then the bridge releases it.",
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

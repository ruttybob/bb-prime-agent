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
import { FakeExtension } from "./test-support/fake-extension.js";
import { PrimeDaemonClient } from "./src/daemon/client.js";
import { resolveDaemonSocketPath } from "./src/daemon/socket.js";
import {
  BB_SESSION_NAME_PREFIX,
  primeSessionName,
} from "./src/session-params.js";
import { FULL_OPTIONS } from "./test-support/bridge-harness.js";

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
/** Every session this run created; afterEach removes exactly these. */
const cleanupSessions: Array<{
  activeSessionId: string;
  sessionFile?: string;
  name: string;
}> = [];

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
  // Cleanup is not optional: remove exactly the sessions this test created,
  // and check the daemon's own catalog before moving on. If prime still lists
  // a session after the bounded retries, say so loudly rather than failing
  // the lane — reaping a resident worker is prime's schedule, not ours.
  for (const stale of cleanupSessions) {
    const removed = await removeDaemonSession(stale.activeSessionId);
    if (!removed) {
      console.warn(
        `[bb prime-agent live lane] the daemon still lists session ${stale.activeSessionId} (${stale.name}) after abort + kill + delete_saved_session; remove it from prime-agent's catalog if it lingers.`,
      );
    }
  }
  cleanupSessions.length = 0;
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
  // A fresh clientId per connection: the daemon journals mutating commands by
  // (clientId, envelope id) and *replays the recorded response* on a repeat,
  // so a fixed id would silently turn this run's kill/prompt into a previous
  // run's recorded answer (see the spike's wire facts).
  const client = new PrimeDaemonClient({
    socketPath: resolveDaemonSocketPath(),
    clientId: `bbpa-live-test-${Math.random().toString(36).slice(2, 10)}`,
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

/** Same poll, for predicates that themselves talk to the daemon. */
async function waitForAsync(
  label: string,
  predicate: () => Promise<boolean>,
  timeoutMs = 90_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

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
    cleanupSessions.push({
      activeSessionId: record!.activeSessionId!,
      sessionFile: record?.sessionFile,
      name,
    });
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
    cleanupSessions.push({
      activeSessionId: record!.activeSessionId!,
      sessionFile: record?.sessionFile,
      name: threadId,
    });

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
 * The persistence lane, live: release keeps the session, work continues in the
 * daemon, reopen rebuilds the timeline from the attach snapshot, and discard
 * removes the session for good.
 *
 * Like the turn lane above, it creates exactly one session of its own ("[bb] "
 * prefix + nonce), never touches a session it did not create, and cleans up via
 * `kill` + `delete_saved_session` in `afterEach` — a successful discard beats
 * it to it, and the failed kill on an already-removed session is swallowed.
 */
it.skipIf(!LIVE)(
  "reopens a released thread from the daemon snapshot and discards it for good",
  async () => {
    const nonce = Math.random().toString(36).slice(2, 8);
    const threadId = `thr_live_${nonce}`;
    const prompt = "Reply with the single word: ok";

    // --- thread/start: the resident session is created and answers once. ---
    sendRequest("s", "thread/start", {
      threadId,
      cwd: workspaceDir,
      instructionMode: "append",
      options: FULL_OPTIONS,
      input: [{ type: "text", text: prompt, mentions: [] }],
    });
    await waitFor("the thread/start response", () =>
      responses().some((reply) => reply.id === "s"),
    );
    const startReply = responses().find((reply) => reply.id === "s")!;
    expect(startReply.error).toBeUndefined();
    const providerThreadId = String(startReply.result?.providerThreadId);
    expect(providerThreadId).toMatch(/^prime_/);
    await waitFor("the first turn to settle", () =>
      deltas(threadId).some(
        (delta) => delta.kind === "turn.boundary" && delta.status === "completed",
      ),
    );

    const record = sessionTableForTests().byThread(threadId);
    const activeSessionId = record!.activeSessionId!;
    const sessionFile = record!.sessionFile!;
    const name = record!.sessionName!;
    expect(name).toBe(primeSessionName({ threadId, title: prompt }));
    expect(existsSync(sessionFile)).toBe(true);
    // Every path below is covered by this cleanup if the test fails midway.
    cleanupSessions.push({ activeSessionId, sessionFile, name });

    // --- release: bb lets go; the daemon session and its file stay. ---
    sendRequest("r", "thread/stop", {
      threadId,
      providerThreadId,
      intent: "release",
      activeTurnId: null,
    });
    await waitFor("the release response", () =>
      responses().some((reply) => reply.id === "r"),
    );
    expect(sessionTableForTests().byThread(threadId)).toBeUndefined();
    expect(existsSync(sessionFile)).toBe(true);
    await withTestClient(async (client) => {
      const listing = await client.request({ type: "list" });
      const sessions =
        (listing.data as { sessions?: Array<{ sessionName?: string }> }).sessions ?? [];
      expect(sessions.filter((session) => session.sessionName === name)).toHaveLength(1);
    });

    // --- bb is closed; the resident session keeps working out of band. ---
    await withTestClient(async (client) => {
      let settled = false;
      client.onPush = (message) => {
        const candidate = message as {
          type?: string;
          activeSessionId?: string;
          event?: { type?: string };
        };
        if (
          candidate.type === "session_event" &&
          candidate.activeSessionId === activeSessionId &&
          candidate.event?.type === "agent_end"
        ) {
          settled = true;
        }
      };
      // The daemon pushes session events to attached clients only, so this
      // out-of-band client attaches before prompting — exactly what another
      // prime window would do.
      const attached = await client.request({ type: "attach", activeSessionId });
      expect(attached.success, `attach failed: ${attached.error}`).toBe(true);
      const prompted = await client.request({
        type: "prompt",
        activeSessionId,
        message: "Reply with the single word: done",
      });
      expect(prompted.success, `out-of-band prompt failed: ${prompted.error}`).toBe(true);
      await waitFor("the out-of-band turn to settle", () => settled, 120_000);
    });

    // --- reopen: the timeline comes from the attach snapshot, exactly once. ---
    sendRequest("p", "thread/resume", {
      threadId,
      providerThreadId,
      cwd: workspaceDir,
      instructionMode: "append",
      options: FULL_OPTIONS,
    });
    await waitFor("the resume response", () =>
      responses().some((reply) => reply.id === "p"),
    );
    expect(responses().find((reply) => reply.id === "p")?.error).toBeUndefined();
    expect(responses().find((reply) => reply.id === "p")?.result).toMatchObject({
      providerThreadId,
      sessionRestorable: true,
    });
    await waitFor("the snapshot timeline to arrive", () =>
      deltas(threadId).some(
        (delta) =>
          delta.kind === "input.provider" && String(delta.text).includes("done"),
      ),
    );
    const kinds = deltas(threadId).map((delta) => delta.kind);
    // Both constructions announced their id-space boundary.
    expect(kinds.filter((kind) => kind === "session.reset")).toHaveLength(2);
    const snapshotInputs = deltas(threadId)
      .filter((delta) => delta.kind === "input.provider")
      .map((delta) => String(delta.text));
    // Both exchanges — bb's own and the out-of-band one — came from the
    // snapshot, each exactly once.
    expect(snapshotInputs).toHaveLength(2);
    expect(snapshotInputs[0]).toContain("ok");
    expect(snapshotInputs[1]).toContain("done");
    expect(
      deltas(threadId).some(
        (delta) =>
          delta.kind === "item.open" &&
          JSON.stringify(delta.item ?? {}).includes("done"),
      ),
    ).toBe(true);

    // --- discard: stop + cleanup; nothing is left behind. ---
    sendRequest("d", "thread/discard", { threadId, providerThreadId });
    await waitFor("the discard response", () =>
      responses().some((reply) => reply.id === "d"),
    );
    expect(responses().find((reply) => reply.id === "d")?.result).toEqual({ ok: true });
    expect(sessionTableForTests().byThread(threadId)).toBeUndefined();
    await waitForAsync("the discarded session to leave the daemon", async () => {
      try {
        await withTestClient(async (client) => {
          const listing = await client.request({ type: "list" });
          const sessions =
            (listing.data as { sessions?: Array<{ sessionName?: string }> }).sessions ?? [];
          const saved = await client.request({
            type: "list_saved_sessions",
            cwd: workspaceDir,
            scope: "current",
          });
          const savedSessions =
            (saved.data as { sessions?: Array<{ path?: string }> }).sessions ?? [];
          if (sessions.some((session) => session.sessionName === name)) {
            throw new StillThere("still listed as a live session");
          }
          if (savedSessions.some((session) => session.path === sessionFile)) {
            throw new StillThere("still listed as a saved session");
          }
          if (existsSync(sessionFile)) {
            throw new StillThere("the transcript file is still on disk");
          }
        });
      } catch (error) {
        if (error instanceof StillThere) {
          return false;
        }
        throw error;
      }
      return true;
    });
    // The discard removed the session itself; the afterEach net has nothing
    // left to clean.
    cleanupSessions.length = 0;
  },
  240_000,
);

/**
 * The fork-and-rename lane, live (bbpa-ggf.7): a thread with two exchanges is
 * forked from the FIRST turn's checkpoint into a NEW thread whose own resident
 * session holds history up to that fork point, and a rename in bb is reflected
 * in prime's catalog with the "[bb] " prefix kept. Both sessions — the source
 * and the fork — are cleaned up.
 *
 * The forked session's inherited history is asserted at the source of truth
 * the bridge owns: prime's own transcript (`get_messages` on the forked
 * session). The new bb thread's persisted timeline is bb's server business —
 * it copies the inherited events itself, which is why the bridge does not
 * replay the snapshot as content.
 */
it.skipIf(!LIVE)(
  "forks a thread from an earlier message and renames it in prime's catalog",
  async () => {
    const nonce = Math.random().toString(36).slice(2, 8);
    const threadId = `thr_live_${nonce}`;
    const forkThreadId = `thr_live_fork_${nonce}`;
    const firstPrompt = "Remember the word SEVEN. Reply with exactly: ok";
    const secondPrompt = "Reply with exactly: done";

    // --- Two settled exchanges on the source thread. ---
    sendRequest("s", "thread/start", {
      threadId,
      cwd: workspaceDir,
      instructionMode: "append",
      options: FULL_OPTIONS,
      input: [{ type: "text", text: firstPrompt, mentions: [] }],
    });
    await waitFor("the thread/start response", () => responses().some((reply) => reply.id === "s"));
    const providerThreadId = String(responses().find((reply) => reply.id === "s")!.result?.providerThreadId);
    await waitFor("the first turn to settle", () =>
      deltas(threadId).some(
        (delta) => delta.kind === "turn.boundary" && delta.status === "completed",
      ),
    );
    const firstCheckpoint = deltas(threadId).find(
      (delta) => delta.kind === "turn.boundary",
    )?.providerCheckpointId;
    expect(typeof firstCheckpoint).toBe("string");

    sendRequest("t", "turn/start", {
      threadId,
      providerThreadId,
      input: [{ type: "text", text: secondPrompt, mentions: [] }],
      clientRequestId: "creq_turn2abcde",
      options: FULL_OPTIONS,
    });
    await waitFor("the second turn to settle", () =>
      deltas(threadId).filter((delta) => delta.kind === "turn.boundary").length >= 2,
    );

    const record = sessionTableForTests().byThread(threadId)!;
    const sourceSessionId = record.activeSessionId!;
    const sourceFile = record.sessionFile!;
    const sourceName = record.sessionName!;
    cleanupSessions.push({ activeSessionId: sourceSessionId, sessionFile: sourceFile, name: sourceName });

    // --- Fork from the first turn's checkpoint. ---
    sendRequest("f", "thread/fork", {
      threadId: forkThreadId,
      cwd: workspaceDir,
      sourceProviderThreadId: providerThreadId,
      sourceProviderCheckpointId: firstCheckpoint,
      instructionMode: "append",
      options: FULL_OPTIONS,
    });
    await waitFor("the fork response", () => responses().some((reply) => reply.id === "f"));
    const forkReply = responses().find((reply) => reply.id === "f")!;
    expect(forkReply.error).toBeUndefined();
    const forkProviderThreadId = String(forkReply.result?.providerThreadId);
    expect(forkProviderThreadId).toMatch(/^prime_/);
    expect(forkProviderThreadId).not.toBe(providerThreadId);

    const forkRecord = sessionTableForTests().byThread(forkThreadId)!;
    const forkSessionId = forkRecord.activeSessionId!;
    const forkFile = forkRecord.sessionFile!;
    const forkName = forkRecord.sessionName!;
    expect(forkName.startsWith(BB_SESSION_NAME_PREFIX)).toBe(true);
    expect(forkFile).not.toBe(sourceFile);
    cleanupSessions.push({ activeSessionId: forkSessionId, sessionFile: forkFile, name: forkName });

    // The forked session holds history up to the fork point: the first
    // exchange is in, the second is not. The source kept both.
    await withTestClient(async (client) => {
      const forked = await client.request({ type: "get_messages", activeSessionId: forkSessionId });
      expect(forked.success, `get_messages failed: ${forked.error}`).toBe(true);
      const forkedText = JSON.stringify(forked.data);
      expect(forkedText).toContain("SEVEN");
      expect(forkedText).not.toContain("done");

      const source = await client.request({ type: "get_messages", activeSessionId: sourceSessionId });
      expect(source.success, `get_messages failed: ${source.error}`).toBe(true);
      const sourceText = JSON.stringify(source.data);
      expect(sourceText).toContain("SEVEN");
      expect(sourceText).toContain("done");
    });

    // Both sessions sit in prime's catalog under their [bb] names.
    await withTestClient(async (client) => {
      const listing = await client.request({ type: "list" });
      const sessions =
        (listing.data as { sessions?: Array<{ sessionName?: string; cwd?: string }> }).sessions ?? [];
      const mine = sessions.filter(
        (session) => session.sessionName === sourceName || session.sessionName === forkName,
      );
      expect(mine).toHaveLength(2);
      for (const session of mine) {
        expect(session.cwd).toBe(workspaceDir);
      }
    });

    // The forked thread is a live session of its own: it answers a turn.
    sendRequest("p", "turn/start", {
      threadId: forkThreadId,
      providerThreadId: forkProviderThreadId,
      input: [{ type: "text", text: "Reply with exactly: forked", mentions: [] }],
      clientRequestId: "creq_turn3abcde",
      options: FULL_OPTIONS,
    });
    await waitFor("the forked thread's turn to settle", () =>
      deltas(forkThreadId).some(
        (delta) => delta.kind === "turn.boundary" && delta.status === "completed",
      ),
    );
    const forkedStream = deltas(forkThreadId)
      .filter((delta) => delta.kind === "item.textDelta")
      .map((delta) => String(delta.text))
      .join("");
    expect(forkedStream.toLowerCase()).toContain("forked");

    // --- A rename in bb lands in prime's catalog, prefix kept. ---
    sendRequest("n", "thread/name/set", {
      threadId: forkThreadId,
      providerThreadId: forkProviderThreadId,
      title: `Renamed live ${nonce}`,
    });
    await waitFor("the rename response", () => responses().some((reply) => reply.id === "n"));
    expect(responses().find((reply) => reply.id === "n")?.error).toBeUndefined();
    const renamedName = primeSessionName({
      threadId: forkThreadId,
      title: `Renamed live ${nonce}`,
    });
    await waitForAsync("the renamed catalog entry", async () => {
      await withTestClient(async (client) => {
        const listing = await client.request({ type: "list" });
        const sessions =
          (listing.data as { sessions?: Array<{ sessionName?: string }> }).sessions ?? [];
        if (!sessions.some((session) => session.sessionName === renamedName)) {
          throw new StillThere("the renamed session is not in prime's catalog yet");
        }
      });
      return true;
    });
    expect(renamedName.startsWith(BB_SESSION_NAME_PREFIX)).toBe(true);
  },
  300_000,
);

/** Marker for the discard poll: the session is (still) there. */
class StillThere extends Error {}


/**
 * The live model/thinking/compaction surface (bbpa-ggf.6): the catalog answered
 * from the machine's prime, a thinking-level switch applied to the running
 * session, and a manual `/compact` mapped onto prime's compaction. Owns one
 * "[bb] " session, named with a nonce, and removes exactly that one.
 */
it.skipIf(!LIVE)(
  "lists the machine's models and switches thinking level live",
  async () => {
    const nonce = Math.random().toString(36).slice(2, 8);
    const threadId = `thr_live_models_${nonce}`;

    // --- model/list: prime's own catalog, translated. ---
    sendRequest("ml", "model/list", { cwd: workspaceDir });
    await waitFor("the model/list response", () =>
      responses().some((reply) => reply.id === "ml"),
    );
    const catalog = responses().find((reply) => reply.id === "ml")!;
    expect(catalog.error).toBeUndefined();
    const models = (catalog.result?.models ?? []) as Array<{
      id: string;
      model: string;
      displayName: string;
      isDefault: boolean;
      supportedReasoningEfforts: Array<{ reasoningEffort: string }>;
    }>;
    expect(models.length).toBeGreaterThan(0);
    // bb's shape: provider/modelId ids, exactly one default, every model
    // carries the efforts its thinking ladder supports.
    for (const model of models) {
      expect(model.id).toMatch(/^[^/]+\/.+/);
      expect(model.model).toBe(model.id);
      expect(model.displayName.length).toBeGreaterThan(0);
      expect(model.supportedReasoningEfforts.length).toBeGreaterThan(0);
    }
    expect(models.filter((model) => model.isDefault)).toHaveLength(1);
    // The throwaway catalog lane is gone: no "[bb] model catalog" session.
    await withTestClient(async (client) => {
      const listing = await client.request({ type: "list" });
      const sessions =
        (listing.data as { sessions?: Array<{ sessionName?: string }> }).sessions ?? [];
      expect(
        sessions.filter((session) =>
          String(session.sessionName ?? "").includes("model catalog"),
        ),
      ).toEqual([]);
    });

    // --- A thread of our own. ---
    sendRequest("s", "thread/start", {
      threadId,
      cwd: workspaceDir,
      instructionMode: "append",
      options: FULL_OPTIONS,
    });
    await waitFor("the thread/start response", () =>
      responses().some((reply) => reply.id === "s"),
    );
    const startReply = responses().find((reply) => reply.id === "s")!;
    expect(startReply.error).toBeUndefined();
    const providerThreadId = String(startReply.result?.providerThreadId);
    const record = sessionTableForTests().byThread(threadId)!;
    cleanupSessions.push({
      activeSessionId: record.activeSessionId!,
      sessionFile: record.sessionFile,
      name: record.sessionName ?? threadId,
    });

    // A second, passive daemon connection watches the session events prime
    // pushes, so the switch is observed on the wire, not through the bridge.
    const raw = new PrimeDaemonClient({
      socketPath: resolveDaemonSocketPath(),
      clientId: "bbpa-live-models",
    });
    const sessionEvents: Array<Record<string, unknown>> = [];
    raw.onPush = (message) => {
      if (
        message.type === "session_event" &&
        (message as { activeSessionId?: string }).activeSessionId ===
          record.activeSessionId
      ) {
        sessionEvents.push(
          (message as unknown as { event: Record<string, unknown> }).event,
        );
      }
    };
    await raw.connect();
    try {
      // The level bb asks for must be one the session's model actually offers
      // and it must differ from what the session already runs, so this really
      // is a switch. Ask prime what it offers before asking bb to move; the
      // passive client attaches so prime routes the session's events to it.
      await raw.request({ type: "attach", activeSessionId: record.activeSessionId! });
      const state = await raw.request({
        type: "get_connection_state",
        activeSessionId: record.activeSessionId!,
      });
      const data = state.data as
        | {
            thinkingLevel?: string;
            availableThinkingLevels?: string[];
          }
        | undefined;
      const ladder = (data?.availableThinkingLevels ?? []).filter(
        (candidate): candidate is "low" | "medium" | "high" | "xhigh" | "max" =>
          candidate === "low" ||
          candidate === "medium" ||
          candidate === "high" ||
          candidate === "xhigh" ||
          candidate === "max",
      );
      const current = data?.thinkingLevel;
      const level =
        [...ladder].reverse().find((candidate) => candidate !== current) ??
        current ??
        "high";
      const switched = level !== current;

      sendRequest("t", "turn/start", {
        threadId,
        providerThreadId,
        input: [
          {
            type: "text",
            text: "Reply with exactly: ok. Use no tools.",
            mentions: [],
          },
        ],
        clientRequestId: "creq_bbseteffab",
        options: { ...FULL_OPTIONS, reasoningLevel: level },
      });
      await waitFor("the switch turn to settle", () => {
        // Fail fast when the bridge refused the switch instead of waiting out.
        const reply = responses().find((response) => response.id === "t");
        if (reply?.error !== undefined) {
          throw new Error(`turn/start failed: ${JSON.stringify(reply.error)}`);
        }
        return deltas(threadId).some((delta) => delta.kind === "turn.boundary");
      });
      expect(
        responses().find((response) => response.id === "t")?.error,
      ).toBeUndefined();
      if (!switched) {
        // A model with a single-level ladder: nothing to switch, nothing to
        // observe — the no-op is the correct answer.
        return;
      }
      // prime announced the new level on the wire...
      await waitFor("the thinking_level_changed event", () =>
        sessionEvents.some(
          (event) =>
            event.type === "thinking_level_changed" && event.level === level,
        ),
      );
      // ...and the bridge mirrored the session facts off the timeline.
      const sessionStates = messages()
        .filter(
          (message): message is { method: string; params: Record<string, unknown> } =>
            typeof message === "object" &&
            message !== null &&
            (message as Record<string, unknown>).method === "provider/raw",
        )
        .map((message) => message.params as Record<string, unknown>)
        .filter((params) => params.method === "prime.session_state")
        .map((params) => params.params as Record<string, unknown>);
      expect(sessionStates.at(-1)).toMatchObject({
        threadId,
        thinkingLevel: level,
        autoCompactionEnabled: expect.any(Boolean),
      });
    } finally {
      raw.close();
    }

    // --- Manual compaction: the standalone builtin /compact prompt. ---
    const boundariesBefore = deltas(threadId).filter(
      (delta) => delta.kind === "turn.boundary",
    ).length;
    sendRequest("c", "turn/start", {
      threadId,
      providerThreadId,
      input: [
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
      ],
      clientRequestId: "creq_bbcmpctabc",
      options: FULL_OPTIONS,
    });
    await waitFor("the compaction turn to settle", () => {
      const reply = responses().find((response) => response.id === "c");
      if (reply?.error !== undefined) {
        throw new Error(`compaction failed: ${JSON.stringify(reply.error)}`);
      }
      return (
        deltas(threadId).filter((delta) => delta.kind === "turn.boundary")
          .length > boundariesBefore
      );
    });
    expect(responses().find((response) => response.id === "c")?.error).toBeUndefined();
    const compactionKinds = deltas(threadId)
      .slice(
        deltas(threadId)
          .map((delta) => delta.kind)
          .lastIndexOf("input.accepted"),
      )
      .map((delta) => delta.kind);
    // A fresh thread has nothing to compact: prime skips it benignly, and the
    // timeline says skipped — never that it compacted.
    if (compactionKinds.includes("provider.warning")) {
      expect(compactionKinds).not.toContain("context.compacted");
      expect(
        deltas(threadId).find((delta) => delta.kind === "provider.warning"),
      ).toMatchObject({ category: "compaction-skipped" });
    } else {
      expect(compactionKinds).toContain("item.open");
      expect(compactionKinds).toContain("context.compacted");
    }
    expect(compactionKinds.at(-1)).toBe("turn.boundary");

    // Release: the bridge lets go, then cleanup removes the session.
    sendRequest("r", "thread/stop", {
      threadId,
      providerThreadId,
      intent: "release",
      activeTurnId: null,
    });
    await waitFor("the release response", () =>
      responses().some((reply) => reply.id === "r"),
    );
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

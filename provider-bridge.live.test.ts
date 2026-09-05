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
  // Cleanup is not optional: remove exactly the session this test created.
  const stale = cleanupSession;
  if (stale !== undefined) {
    try {
      await withTestClient(async (client) => {
        // A killed resident session is flushed asynchronously, so one
        // kill+delete round can leave it right back in the list; converge.
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const listing = await client.request({ type: "list" });
          const sessions =
            (listing.data as {
              sessions?: Array<{
                activeSessionId: string;
                sessionFile?: string;
              }>;
            }).sessions ?? [];
          const mine = sessions.find(
            (session) => session.activeSessionId === stale.activeSessionId,
          );
          if (mine === undefined) {
            return;
          }
          await client.request({
            type: "kill",
            activeSessionId: stale.activeSessionId,
          });
          if (mine.sessionFile !== undefined) {
            await client.request({
              type: "delete_saved_session",
              sessionPath: mine.sessionFile,
            });
          }
          await new Promise((resolve) => setTimeout(resolve, 300));
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
    cleanupSession = {
      activeSessionId: record.activeSessionId!,
      sessionFile: record.sessionFile,
      name: record.sessionName ?? threadId,
    };

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

import { describe, expect, it } from "vitest";
import { BRIDGE_JSON_RPC_ERRORS } from "@get-bb/plugin-sdk/provider-bridge";
import {
  CLIENT_REQUEST_ID,
  FULL_OPTIONS,
  startBridgeHarness,
  type BridgeResponse,
} from "./test-support/bridge-harness.js";
import { type ScriptedDaemonHandle } from "./test-support/scripted-daemon.js";

/**
 * bb's `thread/goal/clear` and the goal state on the timeline (bbpa-b1m.2).
 *
 * prime exposes no goal RPC (probe wire fact, 2026-09-06): the bridge maps
 * bb's clear request onto prime's own `/goal clear` session command, sent as
 * a control prompt with no turn bookkeeping — bb called this as thread
 * metadata, not as a user turn. The command rows and the closing
 * `goal_update` flow back through the ordinary push path.
 */

/** The scripted daemon is created per test; beforeEach re-binds the alias. */
let daemon: ScriptedDaemonHandle;

const h = startBridgeHarness({
  session: {
    activeSessionId: "sess_1",
    sessionFile: "/tmp/prime/sessions/sess_1.jsonl",
    sessionName: "[bb] scripted thread",
    cwd: "/tmp/prime-workspace",
  },
  beforeEachExtra: (harness) => {
    daemon = harness.daemon;
  },
});

const { cwd, sendRequest, waitForResponse, deltas } = h;

/** Start a thread whose resident session is prime_sess_1, and settle it. */
async function startThread(id: string, threadId: string): Promise<string> {
  daemon.enqueueCreate();
  daemon.enqueueAttach();
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

function goalUpdate(goal: Record<string, unknown>): unknown {
  return { type: "goal_update", goal };
}

describe("thread/goal/clear (bbpa-b1m.2)", () => {
  it("declares threadGoalClear in the handshake", async () => {
    sendRequest("init", "initialize", {
      protocolVersion: 3,
      client: { name: "bb", version: "test" },
    });
    const reply = await waitForResponse("init");
    expect(reply.result?.capabilities).toMatchObject({ threadGoalClear: true });
  });

  it("maps the request onto prime's /goal clear command prompt", async () => {
    await startThread("s1", "thr_1");
    daemon.enqueueOk("prompt");
    sendRequest("c1", "thread/goal/clear", {
      threadId: "thr_1",
      providerThreadId: "prime_sess_1",
    });
    const reply = await waitForResponse("c1");
    expect(reply.error).toBeUndefined();
    expect(reply.result).toEqual({ ok: true });
    expect(daemon.commands.find((command) => command.type === "prompt")).toMatchObject({
      activeSessionId: "sess_1",
      message: "/goal clear",
      streamingBehavior: "followUp",
    });
  });

  it("refuses for a thread this bridge has no session for", async () => {
    sendRequest("c2", "thread/goal/clear", {
      threadId: "thr_missing",
      providerThreadId: "prime_sess_x",
    });
    const reply = await waitForResponse("c2");
    expect(reply.error?.code).toBe(BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR);
    expect(reply.error?.message).toMatch(/No session for thread/);
  });

  it("surfaces a live goal_update as a goal row on the thread", async () => {
    const providerThreadId = await startThread("s2", "thr_2");
    h.forgetMessages();
    daemon.enqueuePrompt({
      events: [
        { type: "agent_start" },
        {
          type: "goal_update",
          goal: {
            active: true,
            status: "active",
            goalId: "g-live",
            objective: "ship bbpa-b1m",
            tokensUsed: 0,
            timeUsedSeconds: 0,
          },
        },
        { type: "agent_end", messages: [] },
      ],
    });
    sendRequest("t3", "turn/start", {
      threadId: "thr_2",
      providerThreadId,
      input: [
        { type: "text", text: "/goal ship bbpa-b1m", mentions: [] },
      ],
      clientRequestId: CLIENT_REQUEST_ID,
      options: FULL_OPTIONS,
    });
    const reply = await waitForResponse("t3");
    expect(reply.error).toBeUndefined();
    expect(deltas("thr_2")).toContainEqual(
      expect.objectContaining({
        kind: "item.open",
        key: { channel: "goal-g-live" },
        item: expect.objectContaining({ kind: "prime-agent/goal" }),
      }),
    );
  });
});

describe("a goal in an adopted session's snapshot state", () => {
  it("seeds the goal row from the attach snapshot's state.goal", async () => {
    // bb is gone while the goal runs; the reopened bridge reads the goal from
    // the attach snapshot's `state.goal` — the snapshot field, not the
    // command rows (bbpa-b1m.2's open question, answered).
    daemon.enqueueAttach({
      state: {
        model: { id: "m", provider: "p" },
        thinkingLevel: "high",
        goal: {
          active: true,
          status: "active",
          goalId: "g-seed",
          objective: "keep building",
          tokensUsed: 900,
          timeUsedSeconds: 12,
        },
      },
      messages: [{ role: "user", content: "/goal keep building" }],
    });
    sendRequest("t4", "thread/resume", {
      threadId: "thr_seed",
      providerThreadId: "prime_sess_1",
      cwd,
      instructionMode: "append",
      options: FULL_OPTIONS,
    });
    const reply = await waitForResponse("t4");
    expect(reply.result).toMatchObject({ providerThreadId: "prime_sess_1" });

    const goalRows = deltas("thr_seed").filter(
      (delta) => delta.kind === "item.open",
    );
    expect(goalRows).toHaveLength(1);
    expect(goalRows[0]).toMatchObject({
      kind: "item.open",
      key: { channel: "goal-g-seed" },
      item: {
        kind: "prime-agent/goal",
        payload: {
          objective: "keep building",
          status: "active",
          tokensUsed: 900,
        },
      },
    });
  });
});

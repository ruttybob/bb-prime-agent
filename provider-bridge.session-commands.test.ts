import { describe, expect, it } from "vitest";
import { resetDaemonForTests, sessionTableForTests } from "./src/provider-bridge.js";
import { type ScriptedDaemonHandle } from "./test-support/scripted-daemon.js";
import {
  CLIENT_REQUEST_ID,
  FULL_OPTIONS,
  startBridgeHarness,
  type BridgeResponse,
} from "./test-support/bridge-harness.js";

/**
 * Session slash commands end to end (bbpa-b1m.1): a `/goal …`-style prompt
 * runs on the prime session, prime appends its durable command and result
 * messages, and the bridge turns the `message_start`/`message_end` pushes
 * into timeline rows — live, and from an adopted session's snapshot.
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

const { cwd, sendRequest, waitForResponse, deltas, forgetMessages } = h;

const GOAL = { name: "goal", args: "ship bbpa-b1m", text: "/goal ship bbpa-b1m" };

function commandMessage(command: typeof GOAL): Record<string, unknown> {
  return {
    role: "custom",
    customType: "session_slash_command",
    content: command.text,
    display: true,
    details: { command },
  };
}

function resultMessage(command: typeof GOAL): Record<string, unknown> {
  return {
    role: "custom",
    customType: "session_slash_command_result",
    content: "Goal set: ship bbpa-b1m",
    display: true,
    details: { command, success: true, severity: "info" },
  };
}

/** Start the thread with no first turn; tests open turns explicitly. */
async function startThread(args: { id: string; threadId: string }): Promise<string> {
  daemon.enqueueCreate();
  daemon.enqueueAttach();
  sendRequest(args.id, "thread/start", {
    threadId: args.threadId,
    cwd,
    instructionMode: "append",
    options: FULL_OPTIONS,
  });
  const reply = await waitForResponse(args.id);
  expect(reply.error).toBeUndefined();
  return String(reply.result?.providerThreadId);
}

async function runTurn(args: {
  id: string;
  threadId: string;
  providerThreadId: string;
  events: readonly unknown[];
}): Promise<BridgeResponse> {
  daemon.enqueuePrompt({ events: args.events });
  sendRequest(args.id, "turn/start", {
    threadId: args.threadId,
    providerThreadId: args.providerThreadId,
    input: [{ type: "text", text: GOAL.text, mentions: [] }],
    clientRequestId: CLIENT_REQUEST_ID,
    options: FULL_OPTIONS,
  });
  return waitForResponse(args.id);
}

describe("a session command inside a live turn", () => {
  it("renders the command and its result as extension rows", async () => {
    const providerThreadId = await startThread({ id: "t1", threadId: "thr_1" });
    forgetMessages();
    const reply = await runTurn({
      id: "t2",
      threadId: "thr_1",
      providerThreadId,
      events: [
        { type: "agent_start" },
        // prime appends the durable command message, announced as a pair …
        {
          type: "message_start",
          message: commandMessage(GOAL),
        },
        {
          type: "message_end",
          message: commandMessage(GOAL),
        },
        // … runs it, and appends the result the same way.
        {
          type: "message_start",
          message: resultMessage(GOAL),
        },
        {
          type: "message_end",
          message: resultMessage(GOAL),
        },
        {
          type: "agent_end",
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "Goal set: ship bbpa-b1m" }],
              stopReason: "stop",
            },
          ],
        },
      ],
    });
    expect(reply.error).toBeUndefined();

    const threadDeltas = deltas("thr_1");
    expect(threadDeltas).toContainEqual({
      kind: "item.open",
      key: { channel: "session-command-1" },
      item: {
        type: "extension",
        kind: "prime-agent/session-command",
        payload: {
          command: "goal",
          args: "ship bbpa-b1m",
          text: "/goal ship bbpa-b1m",
          phase: "requested",
        },
      },
      attach: "currentOrLast",
      presentation: {
        label: { pending: "/goal", completed: "/goal" },
        icon: { glyph: "terminal" },
        title: "/goal ship bbpa-b1m",
      },
    });
    // The close carries the same presentation the grammar requires on
    // extension rows.
    expect(threadDeltas).toContainEqual({
      kind: "item.close",
      key: { channel: "session-command-1" },
      item: {
        type: "extension",
        kind: "prime-agent/session-command",
        payload: {
          command: "goal",
          args: "ship bbpa-b1m",
          text: "/goal ship bbpa-b1m",
          phase: "succeeded",
        },
      },
      presentation: {
        label: { pending: "/goal", completed: "/goal" },
        icon: { glyph: "terminal" },
        title: "/goal ship bbpa-b1m",
      },
      status: "completed",
      resultText: "Goal set: ship bbpa-b1m",
    });
    // The command rows ride the turn without disturbing its boundary: the
    // run still settles exactly once, completed.
    expect(
      threadDeltas.filter((delta) => delta.kind === "turn.boundary"),
    ).toHaveLength(1);
    expect(threadDeltas.find((delta) => delta.kind === "turn.boundary")).toMatchObject({
      status: "completed",
      claimIfIdle: true,
    });
  });
});

describe("a session command in an adopted session's snapshot", () => {
  it("replays the rows settled, with no pending row left behind", async () => {
    // bb is gone while the session runs the commands; the reopened bridge
    // sees them only through the attach snapshot.
    daemon.enqueueAttach({
      messages: [
        { role: "user", content: "/goal ship bbpa-b1m" },
        commandMessage(GOAL),
        resultMessage(GOAL),
        // A command the transcript never answered.
        commandMessage({ name: "refine", args: "", text: "/refine" }),
      ],
    });
    sendRequest("t1", "thread/resume", {
      threadId: "thr_adopted",
      providerThreadId: "prime_sess_1",
      cwd,
      instructionMode: "append",
      options: FULL_OPTIONS,
    });
    const reply = await waitForResponse("t1");
    expect(reply.result).toMatchObject({ providerThreadId: "prime_sess_1" });

    const threadDeltas = deltas("thr_adopted");
    expect(threadDeltas.map((delta) => delta.kind)).toEqual([
      "session.reset",
      "input.provider",
      "item.open",
      "item.close",
      // The resultless command opens in message order and the end-of-pass
      // settlement closes it: replay never leaves a pending row.
      "item.open",
      "item.close",
    ]);
    expect(threadDeltas[2]).toMatchObject({
      key: { channel: "session-command-1" },
      item: { payload: { command: "goal", phase: "requested" } },
    });
    expect(threadDeltas[3]).toMatchObject({
      key: { channel: "session-command-1" },
      item: { payload: { phase: "succeeded" } },
      status: "completed",
    });
    expect(threadDeltas[5]).toMatchObject({
      key: { channel: "session-command-2" },
      item: { payload: { command: "refine", phase: "interrupted" } },
      status: "interrupted",
    });
  });
});

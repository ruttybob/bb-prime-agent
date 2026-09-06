import { describe, expect, it } from "vitest";
import { sessionTableForTests } from "./src/provider-bridge.js";
import { textTurnEvents, type ScriptedDaemonHandle } from "./test-support/scripted-daemon.js";
import {
  CLIENT_REQUEST_ID,
  FULL_OPTIONS,
  startBridgeHarness,
} from "./test-support/bridge-harness.js";

/**
 * Recovery from a session the prime-agent daemon no longer hosts (bbpa-px7).
 *
 * The daemon unloads sessions that sit idle (~90 minutes on the calibrated
 * build); the transcript file survives on disk, but the activeSessionId a bb
 * thread holds stops resolving and every session-scoped command refuses with
 * "Unknown active session". The bridge reopens the SAME transcript under the
 * fresh id (`create {sessionPath}`), re-indexes the record, and tells bb the
 * new identity — the thread continues instead of failing. These tests script
 * both ways the lane learns the news: the `session_closed` push, and the
 * refusal itself.
 */

let daemon: ScriptedDaemonHandle;

const h = startBridgeHarness({
  session: {
    activeSessionId: "sess_1",
    sessionFile: "/tmp/prime/sessions/sess_1.jsonl",
    sessionName: "[bb] thr_idle",
  },
  beforeEachExtra: (harness) => {
    daemon = harness.daemon;
  },
});

const { cwd, sendRequest, waitForResponse, notifications, deltas } = h;

function commandsOf(type: string): Array<Record<string, unknown>> {
  return daemon.commands.filter((command) => command.type === type);
}

/** Start a thread, create its resident session, and settle the response. */
async function startThread(id: string, threadId: string): Promise<string> {
  daemon.enqueueCreate();
  daemon.enqueueAttach();
  daemon.enqueuePrompt({ events: textTurnEvents({ text: "ok" }) });
  sendRequest(id, "thread/start", {
    threadId,
    cwd,
    instructionMode: "append",
    options: FULL_OPTIONS,
    input: [{ type: "text", text: "hello", mentions: [] }],
  });
  const reply = await waitForResponse(id);
  expect(reply.error).toBeUndefined();
  return String(reply.result?.providerThreadId);
}

describe("evicted-session recovery (bbpa-px7)", () => {
  it("reopens the transcript when a turn arrives after the session_closed push", async () => {
    await startThread("t1", "thr_idle");

    // The daemon unloads the session while the thread sits idle.
    daemon.push({
      type: "session_closed",
      activeSessionId: "sess_1",
      reason: "killed",
    });

    daemon.enqueueCreate({
      activeSessionId: "sess_2",
      sessionFile: "/tmp/prime/sessions/sess_2.jsonl",
    });
    daemon.enqueueAttach();
    daemon.enqueuePrompt({ events: textTurnEvents({ text: "back" }) });
    sendRequest("t2", "turn/start", {
      threadId: "thr_idle",
      providerThreadId: "prime_sess_1",
      input: [{ type: "text", text: "still there?", mentions: [] }],
      clientRequestId: CLIENT_REQUEST_ID,
      options: FULL_OPTIONS,
    });
    const reply = await waitForResponse("t2");
    expect(reply.error).toBeUndefined();

    // The reopen is a create over the REMEMBERED transcript file ...
    const reopens = commandsOf("create");
    expect(reopens).toHaveLength(2);
    expect(reopens[1]).toMatchObject({
      sessionPath: "/tmp/prime/sessions/sess_1.jsonl",
    });
    // ... attached and prompted under the fresh id.
    expect(commandsOf("attach")[1]).toMatchObject({ activeSessionId: "sess_2" });
    expect(commandsOf("prompt")[1]).toMatchObject({ activeSessionId: "sess_2" });

    // bb re-binds the thread to the new resident session.
    const identity = notifications("thread/identity").at(-1);
    expect(identity?.params).toMatchObject({
      threadId: "thr_idle",
      providerThreadId: "prime_sess_2",
    });
    // The timeline says why, and stays otherwise untouched (no session.reset).
    const warnings = deltas("thr_idle").filter(
      (delta) => delta.kind === "provider.warning",
    );
    expect(warnings.at(-1)).toMatchObject({
      summary: expect.stringContaining("unloaded this session"),
    });
    // The only session.reset on this thread's timeline is its start's — the
    // inline reopen re-binds identity WITHOUT a timeline rebuild.
    expect(
      deltas("thr_idle").filter((delta) => delta.kind === "session.reset"),
    ).toHaveLength(1);
    expect(sessionTableForTests().byThread("thr_idle")?.activeSessionId).toBe(
      "sess_2",
    );
  });

  it("recovers and retries once when the prompt itself refuses after a missed push", async () => {
    await startThread("t1", "thr_missed");

    // No session_closed push reached the lane: the eviction is discovered by
    // the refusal, which means nothing was delivered — the retry cannot
    // double-post.
    daemon.enqueueFail("prompt", "Unknown active session: sess_1");
    daemon.enqueueCreate({
      activeSessionId: "sess_2",
      sessionFile: "/tmp/prime/sessions/sess_2.jsonl",
    });
    daemon.enqueueAttach();
    daemon.enqueuePrompt({ events: textTurnEvents({ text: "back" }) });
    sendRequest("t2", "turn/start", {
      threadId: "thr_missed",
      providerThreadId: "prime_sess_1",
      input: [{ type: "text", text: "still there?", mentions: [] }],
      clientRequestId: CLIENT_REQUEST_ID,
      options: FULL_OPTIONS,
    });
    const reply = await waitForResponse("t2");
    expect(reply.error).toBeUndefined();

    const prompts = commandsOf("prompt");
    expect(prompts).toHaveLength(3);
    expect(prompts[0]).toMatchObject({ activeSessionId: "sess_1" }); // the thread's start
    expect(prompts[1]).toMatchObject({ activeSessionId: "sess_1" }); // refused
    expect(prompts[2]).toMatchObject({ activeSessionId: "sess_2" }); // the retry
    expect(commandsOf("create")).toHaveLength(2);
  });

  it("resumes a dead id through the saved-session catalog when this process never knew the file", async () => {
    // A fresh bridge process: no record, no remembered sessionFile — the
    // catalog lookup names the transcript by the "[bb] <threadId>" form.
    daemon.enqueueFail("attach", "Unknown active session: dead_sess");
    daemon.enqueueData("list_saved_sessions", {
      sessions: [
        {
          path: "/tmp/prime/sessions/dead_sess.jsonl",
          id: "dead_sess",
          name: "[bb] thr_gone",
        },
        {
          path: "/tmp/prime/sessions/unrelated.jsonl",
          id: "unrelated",
          name: "prime TUI session",
        },
      ],
    });
    daemon.enqueueCreate({
      activeSessionId: "sess_new",
      sessionFile: "/tmp/prime/sessions/dead_sess.jsonl",
    });
    daemon.enqueueAttach();
    sendRequest("t1", "thread/resume", {
      threadId: "thr_gone",
      providerThreadId: "prime_dead_sess",
      cwd,
      instructionMode: "append",
      options: FULL_OPTIONS,
    });
    const reply = await waitForResponse("t1");
    expect(reply.error).toBeUndefined();
    expect(reply.result).toMatchObject({ providerThreadId: "prime_sess_new" });

    const reopens = commandsOf("create");
    expect(reopens).toHaveLength(1);
    expect(reopens[0]).toMatchObject({
      sessionPath: "/tmp/prime/sessions/dead_sess.jsonl",
    });
    // The resume contract holds: identity + reset announced for the fresh
    // id-space boundary, and the adopted snapshot is replayed as content.
    expect(notifications("thread/identity").at(-1)?.params).toMatchObject({
      threadId: "thr_gone",
      providerThreadId: "prime_sess_new",
    });
    expect(
      deltas("thr_gone").filter((delta) => delta.kind === "session.reset"),
    ).toHaveLength(1);
  });

  it("answers a dead resume with a legible error when no transcript can be found", async () => {
    daemon.enqueueFail("attach", "Unknown active session: dead_sess");
    daemon.enqueueData("list_saved_sessions", {
      sessions: [
        {
          path: "/tmp/prime/sessions/unrelated.jsonl",
          id: "unrelated",
          name: "prime TUI session",
        },
      ],
    });
    sendRequest("t1", "thread/resume", {
      threadId: "thr_gone",
      providerThreadId: "prime_dead_sess",
      cwd,
      instructionMode: "append",
      options: FULL_OPTIONS,
    });
    const reply = await waitForResponse("t1");
    expect(reply.error?.message).toContain("no longer hosts this session");
    expect(reply.error?.message).toContain("transcript file could not be found");
    // The failed resume left no record behind.
    expect(sessionTableForTests().byThread("thr_gone")).toBeUndefined();
  });

  it("clears the goal on a reopened session when the push already arrived", async () => {
    await startThread("t1", "thr_goal");
    daemon.push({
      type: "session_closed",
      activeSessionId: "sess_1",
      reason: "killed",
    });

    daemon.enqueueCreate({
      activeSessionId: "sess_2",
      sessionFile: "/tmp/prime/sessions/sess_2.jsonl",
    });
    daemon.enqueueAttach();
    daemon.enqueueOk("prompt");
    sendRequest("t2", "thread/goal/clear", {
      threadId: "thr_goal",
      providerThreadId: "prime_sess_1",
    });
    const reply = await waitForResponse("t2");
    expect(reply.result).toEqual({ ok: true });
    // The `/goal clear` control prompt lands on the fresh session.
    expect(commandsOf("prompt")[1]).toMatchObject({ activeSessionId: "sess_2" });
  });
});

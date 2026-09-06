import { describe, expect, it } from "vitest";
import {
  FULL_OPTIONS,
  startBridgeHarness,
  type BridgeResponse,
} from "./test-support/bridge-harness.js";
import { type ScriptedDaemonHandle } from "./test-support/scripted-daemon.js";
import { childThreadMarkerInput } from "./src/child-threads.js";

/**
 * The marker thread-start (bbpa-b1m.11, ADR-0005): the child-thread spawn's
 * first input is an agent-only marker naming the child's daemon session. The
 * bridge consumes it — the marker never reaches prime or a model — and
 * attaches to the child session instead of creating one, so the spawned
 * thread's timeline is the child's transcript and later prompts reach the
 * child through the ordinary turn path.
 */

let daemon: ScriptedDaemonHandle;

const h = startBridgeHarness({
  session: {
    activeSessionId: "sess_child",
    sessionFile: "/tmp/prime/sessions/sess_child.jsonl",
    sessionName: "researcher",
    cwd: "/tmp/prime-workspace",
  },
  beforeEachExtra: (harness) => {
    daemon = harness.daemon;
  },
});

const { cwd, sendRequest, waitForResponse, deltas, forgetMessages } = h;

async function startWithMarker(
  id: string,
  threadId: string,
): Promise<BridgeResponse> {
  daemon.enqueueAttach({
    messages: [{ role: "user", content: "find the bug" }],
  });
  sendRequest(id, "thread/start", {
    threadId,
    cwd,
    instructionMode: "append",
    options: FULL_OPTIONS,
    input: [childThreadMarkerInput("sess_child")],
  });
  return waitForResponse(id);
}

describe("child-thread marker start (bbpa-b1m.11)", () => {
  it("attaches to the named session and never creates or prompts", async () => {
    const reply = await startWithMarker("t1", "thr_child");

    expect(reply.error).toBeUndefined();
    // The thread binds to the CHILD session — bb persists the identity, so
    // resumes and bridge restarts keep pointing at the child.
    expect(reply.result).toMatchObject({ providerThreadId: "prime_sess_child" });

    const sent = daemon.commands.map((command) => command.type);
    // attach (+ the lane's queue-state read) — never create, never prompt.
    expect(sent).not.toContain("create");
    expect(sent).not.toContain("prompt");
    expect(sent[0]).toBe("attach");

    // The child's transcript replayed into the fresh thread (adopted-session
    // semantics), and the marker turn settled so the spawn dispatch completes.
    const drained = deltas("thr_child");
    expect(drained).toContainEqual(
      expect.objectContaining({ kind: "input.provider", text: "find the bug" }),
    );
    expect(drained).toContainEqual({ kind: "turn.open" });
    expect(drained).toContainEqual(
      expect.objectContaining({
        kind: "turn.boundary",
        status: "completed",
      }),
    );
  });

  it("releases the child on discard: no kill, no transcript deletion", async () => {
    // ADR-0005: bb does not destroy work it did not start. The child's
    // session and transcript belong to prime's subagent — a user deleting
    // the thread only detaches.
    const reply = await startWithMarker("t3", "thr_discard");
    expect(reply.error).toBeUndefined();
    forgetMessages();

    daemon.enqueueOk("abort");
    daemon.enqueueOk("detach");
    sendRequest("t3b", "thread/discard", { threadId: "thr_discard" });
    await waitForResponse("t3b");

    const sent = daemon.commands.map((command) => command.type);
    expect(sent).not.toContain("kill");
    expect(sent).not.toContain("delete_saved_session");
  });

  it("releases the child on stop: the session only detaches", async () => {
    const reply = await startWithMarker("t4", "thr_stop");
    expect(reply.error).toBeUndefined();
    forgetMessages();

    daemon.enqueueOk("abort");
    daemon.enqueueOk("detach");
    sendRequest("t4b", "thread/stop", {
      threadId: "thr_stop",
      intent: "release",
      providerThreadId: "prime_sess_child",
      activeTurnId: null,
    });
    await waitForResponse("t4b");

    const sent = daemon.commands.map((command) => command.type);
    expect(sent).not.toContain("kill");
    expect(sent).not.toContain("delete_saved_session");
  });

  it("refuses a marker that would retarget an already-bound thread", async () => {
    const reply = await startWithMarker("t5", "thr_bound");
    expect(reply.result).toMatchObject({ providerThreadId: "prime_sess_child" });
    forgetMessages();

    const commandsBefore = daemon.commands.length;
    sendRequest("t5b", "thread/start", {
      threadId: "thr_bound",
      cwd,
      instructionMode: "append",
      options: FULL_OPTIONS,
      input: [childThreadMarkerInput("sess_other")],
    });
    const refused = await waitForResponse("t5b");
    expect(refused.error).toBeDefined();
    // The mismatched marker never reached prime as a prompt.
    expect(daemon.commands.length).toBe(commandsBefore);
  });

  it("answers a second start of the same thread with the same binding", async () => {
    const first = await startWithMarker("t2a", "thr_child2");
    expect(first.result).toMatchObject({ providerThreadId: "prime_sess_child" });
    forgetMessages();

    // bb never re-starts a live thread, but a redo after a failure must not
    // re-attach under a second identity or re-run the marker.
    daemon.enqueueAttach();
    sendRequest("t2b", "thread/start", {
      threadId: "thr_child2",
      cwd,
      instructionMode: "append",
      options: FULL_OPTIONS,
      input: [childThreadMarkerInput("sess_child")],
    });
    const reply = await waitForResponse("t2b");
    expect(reply.error).toBeUndefined();
    expect(reply.result).toMatchObject({ providerThreadId: "prime_sess_child" });
  });
});

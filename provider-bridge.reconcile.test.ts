import { afterEach, describe, expect, it } from "vitest";
import {
  CLIENT_REQUEST_ID,
  FULL_OPTIONS,
  startBridgeHarness,
} from "./test-support/bridge-harness.js";
import type { ScriptedDaemonHandle } from "./test-support/scripted-daemon.js";
import { sessionTableForTests } from "./src/provider-bridge.js";
import {
  reconcileTimingFromEnv,
  sessionSummaryIsIdle,
} from "./src/turn-reconciliation.js";

/**
 * Turn reconciliation (bbpa-uld): a bb turn must never hang in "Working..."
 * forever. When the turn-end signal is lost — a reaped provider-bridge worker
 * mid-turn, a missed daemon `agent_end` — the turn stays open on the bb side
 * while the daemon-side resident session has already settled. While a bb turn
 * is open, the bridge polls the daemon session state (`get_state`); when the
 * session is verifiably not working — not streaming, no running tools, no
 * running RLM children, not compacting — for a grace period, the bridge
 * settles the bb turn itself: interrupted (the run's real outcome is unknown),
 * with a feed note explaining the reconciliation.
 *
 * The reconcile works in a live worker (periodic check while the turn is open)
 * and on re-attach (a fresh worker after the reap runs one check shortly after
 * adopting the session — first wake-up closes an already-stuck turn).
 */

let daemon: ScriptedDaemonHandle;

const h = startBridgeHarness({
  session: {
    activeSessionId: "sess_1",
    sessionFile: "/tmp/prime/sessions/sess_1.jsonl",
    sessionName: "[bb] thr_reconcile",
  },
  beforeEachExtra: (harness) => {
    daemon = harness.daemon;
  },
});

const { cwd, sendRequest, waitForResponse, waitFor, deltas } = h;

let threadCounter = 0;

/** A fresh thread id per test: leftover lanes of an earlier test must never
 * share the timeline (or the scripted daemon's block queue) with this one. */
function nextThreadId(): string {
  threadCounter += 1;
  return `thr_reconcile_${threadCounter}`;
}

const RECONCILE_ENV = {
  BB_PRIME_AGENT_RECONCILE_POLL_MS: "50",
  BB_PRIME_AGENT_RECONCILE_GRACE_MS: "300",
  BB_PRIME_AGENT_RECONCILE_ATTACH_CHECK_DELAY_MS: "60",
};

function speedUpReconcile(): void {
  for (const [key, value] of Object.entries(RECONCILE_ENV)) {
    process.env[key] = value;
  }
}

afterEach(async () => {
  for (const key of Object.keys(RECONCILE_ENV)) {
    delete process.env[key];
  }
  // Release every lane this test created: a lane whose turn never settled
  // keeps its reconcile timer, and a leftover poller would eat the next
  // test's scripted `get_state` answers (and flake its windows).
  for (const record of sessionTableForTests().all()) {
    await record.session?.release({ interrupt: false }).catch(() => {});
  }
});

/** The `get_state` summary of a session that is verifiably not working. */
function idleSummary(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    sessionId: "sess_1",
    activeSessionId: "sess_1",
    activity: "idle",
    isSessionActive: false,
    isStreaming: false,
    isRunningTools: false,
    isBashRunning: false,
    hasRunningRlmChildren: false,
    isCompacting: false,
    attachedClients: 1,
    messageCount: 5,
    ...overrides,
  };
}

/** Enqueue N idle `get_state` answers: the reconcile polls consume them. */
function enqueueIdleReads(count: number): void {
  for (let index = 0; index < count; index += 1) {
    daemon.enqueueData("get_state", idleSummary());
  }
}

/** A turn that streams items and never settles: the `agent_end` was lost. */
function lostTurnEvents(): readonly unknown[] {
  return [
    { type: "agent_start" },
    {
      type: "message_update",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "partial answer" }],
      },
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "partial answer",
      },
    },
    {
      type: "message_update",
      assistantMessageEvent: {
        type: "text_end",
        contentIndex: 0,
        content: "partial answer",
      },
    },
  ];
}

/** The `agent_end` that settles a run, pushed out-of-band at the given clock. */
function pushAgentEnd(sequence: number, text = "done"): void {
  daemon.push({
    type: "session_event",
    activeSessionId: "sess_1",
    event: {
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text }],
          stopReason: "stop",
          usage: { input: 7, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 9 },
        },
      ],
    },
    meta: { sequence, cursor: { generation: "gen-0", sequence } },
  });
}

/** Re-bind a stuck thread the way a fresh bridge worker hears about it. */
function resumeStuckThread(threadId: string, id: string): void {
  daemon.enqueueAttach({
    messages: [{ role: "user", content: "what changed?" }],
  });
  sendRequest(id, "thread/resume", {
    threadId,
    providerThreadId: "prime_sess_1",
    cwd,
    instructionMode: "append",
    options: FULL_OPTIONS,
  });
}

/** Start a thread whose first turn streams but never settles (the loss). */
async function startThreadWithLostTurn(
  threadId: string,
): Promise<void> {
  daemon.enqueueCreate();
  daemon.enqueueAttach();
  daemon.enqueuePrompt({ events: lostTurnEvents() });
  sendRequest("t1", "thread/start", {
    threadId,
    cwd,
    instructionMode: "append",
    options: FULL_OPTIONS,
    input: [{ type: "text", text: "work on something", mentions: [] }],
  });
  // The prompt is admitted (and the lane live) once the daemon has the
  // command — pushes fired before that would find no listener at all.
  await h.waitForDaemonCommand("prompt");
}

function reconciledBoundary(threadId: string): Record<string, unknown> | undefined {
  return deltas(threadId).find(
    (delta) =>
      delta.kind === "turn.boundary" &&
      delta.status === "interrupted" &&
      delta.claimIfIdle === true,
  );
}

describe("turn reconciliation (bbpa-uld)", () => {
  it("settles a lost turn within the grace period, with the feed note, as interrupted", async () => {
    speedUpReconcile();
    const threadId = nextThreadId();
    const startedAt = Date.now();
    await startThreadWithLostTurn(threadId);

    // The loss: item events were delivered, no `agent_end` ever arrives, and
    // the session reads idle. The bridge settles the turn by itself — no user
    // action, no stop request.
    enqueueIdleReads(50);
    await waitFor("the reconciled turn boundary", () => reconciledBoundary(threadId) !== undefined);

    // The settle never jumps the grace window (small clock skew tolerated).
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(280);

    // Interrupted, never success: the run's real outcome is unknown.
    expect(reconciledBoundary(threadId)).toBeDefined();

    // The feed carries a system note explaining the reconciliation.
    const note = deltas(threadId).find((delta) => delta.kind === "provider.warning");
    expect(note).toMatchObject({ category: "general" });
    const summary = String((note as { summary?: string }).summary ?? "");
    expect(summary).toMatch(/end event was lost|closed by reconciliation/i);
    // The note names the idle span the verdict held (the reconcile clock's
    // honest figure, at least one second).
    expect(String((note as { details?: string }).details ?? "")).toMatch(
      /idle for [1-9]\d*s\b/,
    );

    // The reconcile read the daemon session state (get_state), more than once:
    // the idle verdict had to hold across the grace window.
    const reads = daemon.commands.filter((command) => command.type === "get_state");
    expect(reads.length).toBeGreaterThanOrEqual(2);
    for (const read of reads) {
      expect(read).toMatchObject({ activeSessionId: "sess_1" });
    }
  }, 10_000);

  it("holds the grace period: idle reads shorter than the window settle nothing", async () => {
    speedUpReconcile();
    // Grace far beyond this test's lifetime: polls happen, the window never fills.
    process.env.BB_PRIME_AGENT_RECONCILE_GRACE_MS = "5000";
    const threadId = nextThreadId();
    await startThreadWithLostTurn(threadId);
    enqueueIdleReads(20);
    await new Promise((resolve) => setTimeout(resolve, 350));

    expect(daemon.commands.some((command) => command.type === "get_state")).toBe(true);
    expect(reconciledBoundary(threadId)).toBeUndefined();
  }, 10_000);

  it("never settles while the session reports work: streaming, tools, bash, children, compaction", async () => {
    speedUpReconcile();
    const busy = [
      { activity: "working" },
      { isStreaming: true },
      { isRunningTools: true },
      { isBashRunning: true },
      { hasRunningRlmChildren: true },
      { isCompacting: true },
      { isSessionActive: true },
    ];
    for (const overrides of busy) {
      const threadId = nextThreadId();
      await startThreadWithLostTurn(threadId);
      // Busy answers with only brief idle gaps between them — each gap well
      // under the grace window, so the window never fills while the session
      // keeps reporting work. Never a false positive.
      for (let round = 0; round < 4; round += 1) {
        daemon.enqueueData("get_state", idleSummary(overrides));
        enqueueIdleReads(2);
      }
      daemon.enqueueData("get_state", idleSummary(overrides));
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(
        reconciledBoundary(threadId),
        `expected no reconcile for busy summary ${JSON.stringify(overrides)}`,
      ).toBeUndefined();
    }
  }, 20_000);

  it("still settles normally when agent_end arrives mid-window: no interrupted boundary", async () => {
    speedUpReconcile();
    process.env.BB_PRIME_AGENT_RECONCILE_GRACE_MS = "10000";
    // Idle reads flow (the reconciler sees a settled session), but the real
    // `agent_end` lands before the grace window fills: the normal path owns
    // the turn, and no interrupted boundary may appear.
    const threadId = nextThreadId();
    daemon.enqueueCreate();
    daemon.enqueueAttach();
    enqueueIdleReads(10);
    daemon.enqueuePrompt({ events: [] });
    sendRequest("t1", "thread/start", {
      threadId,
      cwd,
      instructionMode: "append",
      options: FULL_OPTIONS,
      input: [{ type: "text", text: "quick question", mentions: [] }],
    });
    // The lane must exist before a push can reach it.
    await h.waitForDaemonCommand("prompt");
    pushAgentEnd(500);
    await waitFor("the completed boundary", () =>
      deltas(threadId).some(
        (delta) => delta.kind === "turn.boundary" && delta.status === "completed",
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(reconciledBoundary(threadId)).toBeUndefined();
    expect(deltas(threadId).some((delta) => delta.kind === "provider.warning")).toBe(false);
  }, 10_000);

  it("a busy read inside the window resets it: settle lands only after idle holds", async () => {
    speedUpReconcile();
    const threadId = nextThreadId();
    await startThreadWithLostTurn(threadId);
    // Idle for a while, then busy again (work appeared), then idle for good.
    enqueueIdleReads(4);
    daemon.enqueueData("get_state", idleSummary({ isStreaming: true }));
    enqueueIdleReads(60);
    await waitFor("the reconciled turn boundary", () => reconciledBoundary(threadId) !== undefined);
    // The script was consumed in order: several idle reads, then the busy one,
    // then the idle stretch that finally filled the window.
    const reads = daemon.commands.filter((command) => command.type === "get_state");
    expect(reads.length).toBeGreaterThanOrEqual(5);
  }, 10_000);

  it("re-attach heals an already-stuck thread: the fresh worker's first check closes it (no note)", async () => {
    speedUpReconcile();
    // A fresh bridge process (the reap took the old one) adopts the resident
    // session by its daemon-derived id: bb re-binds the stuck thread with a
    // resume, and the lane's first reconciliation closes the turn.
    const threadId = nextThreadId();
    resumeStuckThread(threadId, "t2");
    const reply = await waitForResponse("t2");
    expect(reply.result).toMatchObject({ providerThreadId: "prime_sess_1" });

    enqueueIdleReads(30);
    await waitFor("the re-attach reconcile boundary", () => reconciledBoundary(threadId) !== undefined);
    // The attach path knows nothing about bb's open turn, so it stays quiet:
    // the claimIfIdle boundary does the talking, no fabricated note.
    expect(deltas(threadId).some((delta) => delta.kind === "provider.warning")).toBe(false);
  }, 10_000);

  it("re-attach heal retries past a wire-down window instead of giving up", async () => {
    speedUpReconcile();
    const threadId = nextThreadId();
    resumeStuckThread(threadId, "t2");
    await waitForResponse("t2");

    // The daemon blinks exactly when the check wakes up: the check waits for
    // the lane to be live again instead of standing down forever.
    daemon.drop({ cause: "scripted blink" });
    await h.waitFor("the wire to drop", () => daemon.isDropped());
    await new Promise((resolve) => setTimeout(resolve, 120));
    daemon.restore();
    daemon.enqueueAttach({
      messages: [{ role: "user", content: "what changed?" }],
    });
    enqueueIdleReads(40);
    await waitFor("the retried re-attach boundary", () => reconciledBoundary(threadId) !== undefined, 4_000);
  }, 10_000);

  it("re-attach stays quiet while the session reports work", async () => {
    speedUpReconcile();
    const threadId = nextThreadId();
    resumeStuckThread(threadId, "t2");
    await waitForResponse("t2");

    for (let index = 0; index < 20; index += 1) {
      daemon.enqueueData("get_state", idleSummary({ isStreaming: true }));
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(reconciledBoundary(threadId)).toBeUndefined();
  }, 10_000);

  it("re-attach stands down when a prompt is already running on the fresh lane", async () => {
    speedUpReconcile();
    process.env.BB_PRIME_AGENT_RECONCILE_ATTACH_CHECK_DELAY_MS = "400";
    const threadId = nextThreadId();
    resumeStuckThread(threadId, "t2");
    await waitForResponse("t2");

    // bb accepted a new turn right after the resume: the live turn owns the
    // timeline, and the attach-time check must not touch anything.
    daemon.enqueuePrompt({ events: [] });
    enqueueIdleReads(20);
    sendRequest("t3", "turn/start", {
      threadId,
      providerThreadId: "prime_sess_1",
      clientRequestId: CLIENT_REQUEST_ID,
      options: FULL_OPTIONS,
      input: [{ type: "text", text: "next turn", mentions: [] }],
    });
    await h.waitForDaemonCommand("prompt");
    pushAgentEnd(600);
    await waitFor("the completed boundary", () =>
      deltas(threadId).some(
        (delta) => delta.kind === "turn.boundary" && delta.status === "completed",
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(reconciledBoundary(threadId)).toBeUndefined();
  }, 10_000);
});

describe("sessionSummaryIsIdle (the verdict)", () => {
  it("accepts a verifiably idle summary", () => {
    expect(sessionSummaryIsIdle(idleSummary())).toBe(true);
    // The activity verdict plus one explicit flag is enough: a summary that
    // spells `isSessionActive: false` has proven it reports detail flags.
    expect(
      sessionSummaryIsIdle({ activity: "idle", isSessionActive: false }),
    ).toBe(true);
    expect(sessionSummaryIsIdle({ activity: "idle", isStreaming: false })).toBe(true);
    // Unknown fields ride along (passthrough wire).
    expect(sessionSummaryIsIdle({ ...idleSummary(), taskState: "needs_input" })).toBe(true);
  });

  it("refuses a bare activity verdict with no detail flags", () => {
    // "idle" without any spelled-out flag has not proven anything: an older
    // or partial wire must not settle a turn on its say-so alone.
    expect(sessionSummaryIsIdle({ activity: "idle" })).toBe(false);
  });

  it("refuses anything that could still be working", () => {
    expect(sessionSummaryIsIdle(undefined)).toBe(false);
    expect(sessionSummaryIsIdle("nope")).toBe(false);
    expect(sessionSummaryIsIdle({})).toBe(false);
    expect(sessionSummaryIsIdle(idleSummary({ activity: "working" }))).toBe(false);
    expect(sessionSummaryIsIdle({ isSessionActive: false })).toBe(false);
    expect(sessionSummaryIsIdle(idleSummary({ isSessionActive: true }))).toBe(false);
    expect(sessionSummaryIsIdle(idleSummary({ isStreaming: true }))).toBe(false);
    expect(sessionSummaryIsIdle(idleSummary({ isRunningTools: true }))).toBe(false);
    expect(sessionSummaryIsIdle(idleSummary({ isBashRunning: true }))).toBe(false);
    expect(sessionSummaryIsIdle(idleSummary({ hasRunningRlmChildren: true }))).toBe(false);
    expect(sessionSummaryIsIdle(idleSummary({ isCompacting: true }))).toBe(false);
  });
});

describe("reconcileTimingFromEnv", () => {
  it("defaults to the production cadence", () => {
    const timing = reconcileTimingFromEnv({});
    expect(timing).toMatchObject({
      pollMs: 15_000,
      graceMs: 60_000,
      attachCheckDelayMs: 5_000,
    });
  });

  it("reads overrides and clamps to a sane floor", () => {
    expect(
      reconcileTimingFromEnv({
        BB_PRIME_AGENT_RECONCILE_POLL_MS: "250",
        BB_PRIME_AGENT_RECONCILE_GRACE_MS: "1500",
        BB_PRIME_AGENT_RECONCILE_ATTACH_CHECK_DELAY_MS: "75",
      }),
    ).toMatchObject({ pollMs: 250, graceMs: 1500, attachCheckDelayMs: 75 });
    expect(
      reconcileTimingFromEnv({
        BB_PRIME_AGENT_RECONCILE_POLL_MS: "1",
        BB_PRIME_AGENT_RECONCILE_GRACE_MS: "-5",
      }),
    ).toMatchObject({ pollMs: 50, graceMs: 50 });
    // A nonsense value falls back to the default rather than inventing one.
    expect(
      reconcileTimingFromEnv({
        BB_PRIME_AGENT_RECONCILE_ATTACH_CHECK_DELAY_MS: "nonsense",
      }),
    ).toMatchObject({ attachCheckDelayMs: 5_000 });
  });
});

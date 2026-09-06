import { describe, expect, it } from "vitest";
import { createPrimeDeltaTranslator } from "./delta-translation.js";

/**
 * The thread goal row (bbpa-b1m.2): prime's `goal_update` events and the
 * attach snapshot's `state.goal` both answer the translator, which renders
 * one `prime-agent/goal` extension row per goal — opened on first sight,
 * progressed in place by prime's accounting ticks, closed when the goal
 * reaches a terminal state, and closing the row it supersedes when the user
 * sets a new goal.
 */

const THREAD = "thr_goal";

function context() {
  return { threadId: THREAD, cwd: "/tmp/prime-workspace" };
}

function goalUpdate(goal: Record<string, unknown>): unknown {
  return { type: "goal_update", goal };
}

const ACTIVE = {
  active: true,
  status: "active",
  goalId: "g-1",
  objective: "ship bbpa-b1m",
  tokenBudget: 5000,
  tokensUsed: 0,
  timeUsedSeconds: 0,
};

function kinds(deltas: readonly { kind: string }[]): string[] {
  return deltas.map((delta) => delta.kind);
}

describe("a live goal_update", () => {
  it("opens one goal row on the first sight of a goal", () => {
    const translator = createPrimeDeltaTranslator();
    const deltas = translator.translate(goalUpdate(ACTIVE), context());
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({
      kind: "item.open",
      key: { channel: "goal-g-1" },
      item: {
        type: "extension",
        kind: "prime-agent/goal",
        payload: {
          objective: "ship bbpa-b1m",
          status: "active",
          tokenBudget: 5000,
          tokensUsed: 0,
          timeUsedSeconds: 0,
        },
      },
      attach: "currentOrLast",
      presentation: {
        label: { pending: "Goal", completed: "Goal" },
        icon: { glyph: "Target" },
      },
    });
  });

  it("progresses the same row in place on accounting ticks", () => {
    const translator = createPrimeDeltaTranslator();
    translator.translate(goalUpdate(ACTIVE), context());
    const tick = translator.translate(
      goalUpdate({ ...ACTIVE, tokensUsed: 1234, timeUsedSeconds: 30 }),
      context(),
    );
    expect(kinds(tick)).toEqual(["item.progress"]);
    expect(tick[0]).toMatchObject({
      key: { channel: "goal-g-1" },
      message: "goal active · 1.2k tokens · 30s",
    });
  });

  it("closes the row when the goal completes", () => {
    const translator = createPrimeDeltaTranslator();
    translator.translate(goalUpdate(ACTIVE), context());
    const done = translator.translate(
      goalUpdate({
        ...ACTIVE,
        active: false,
        status: "complete",
        tokensUsed: 4800,
        timeUsedSeconds: 240,
      }),
      context(),
    );
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({
      kind: "item.close",
      key: { channel: "goal-g-1" },
      item: {
        kind: "prime-agent/goal",
        payload: { status: "complete", tokensUsed: 4800 },
      },
      status: "completed",
      resultText: "goal complete · 4.8k tokens · 240s",
    });
    // After the close, another accounting tick for the settled goal opens a
    // fresh row rather than resurrecting the closed one silently.
    const after = translator.translate(goalUpdate(ACTIVE), context());
    expect(kinds(after)).toEqual(["item.open"]);
  });

  it("closes with failed on a goal error and with interrupted on a clear", () => {
    const failed = createPrimeDeltaTranslator();
    failed.translate(goalUpdate(ACTIVE), context());
    expect(
      kinds(
        failed.translate(
          goalUpdate({ ...ACTIVE, active: false, status: "error" }),
          context(),
        ),
      ),
    ).toEqual(["item.close"]);
    // (the close's status is asserted below, shared shape)
    const cleared = createPrimeDeltaTranslator();
    cleared.translate(goalUpdate(ACTIVE), context());
    const deltas = cleared.translate(
      goalUpdate({ ...ACTIVE, active: false, status: "idle" }),
      context(),
    );
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({
      kind: "item.close",
      status: "interrupted",
      item: { payload: { status: "cleared" } },
    });
  });

  it("closes the superseded row when a new goal replaces a live one", () => {
    const translator = createPrimeDeltaTranslator();
    translator.translate(goalUpdate(ACTIVE), context());
    const deltas = translator.translate(
      goalUpdate({ ...ACTIVE, goalId: "g-2", objective: "the next thing" }),
      context(),
    );
    expect(kinds(deltas)).toEqual(["item.close", "item.open"]);
    expect(deltas[0]).toMatchObject({
      kind: "item.close",
      key: { channel: "goal-g-1" },
      status: "interrupted",
    });
    expect(deltas[1]).toMatchObject({
      kind: "item.open",
      key: { channel: "goal-g-2" },
      item: { payload: { objective: "the next thing", status: "active" } },
    });
  });

  it("maps prime's budget_limited status onto bb's vocabulary", () => {
    const translator = createPrimeDeltaTranslator();
    const deltas = translator.translate(
      goalUpdate({ ...ACTIVE, status: "budget_limited" }),
      context(),
    );
    expect(deltas[0]).toMatchObject({
      kind: "item.open",
      item: { payload: { status: "budgetLimited" } },
    });
  });

  it("treats an update without a goalId as the open goal, never a second row", () => {
    // prime omits goalId on states not tied to a new goal; the open row must
    // progress (or close), not be orphaned under a second row.
    const translator = createPrimeDeltaTranslator();
    translator.translate(goalUpdate(ACTIVE), context());
    const tick = translator.translate(
      goalUpdate({ status: "active", tokensUsed: 42, timeUsedSeconds: 2 }),
      context(),
    );
    expect(kinds(tick)).toEqual(["item.progress"]);
    expect(tick[0]).toMatchObject({ key: { channel: "goal-g-1" } });
  });

  it("renders nothing for an idle state or a malformed payload", () => {
    const translator = createPrimeDeltaTranslator();
    expect(
      translator.translate(
        goalUpdate({
          active: false,
          status: "idle",
          tokensUsed: 0,
          timeUsedSeconds: 0,
        }),
        context(),
      ),
    ).toEqual([]);
    expect(
      translator.translate(goalUpdate({ status: 42 }), context()),
    ).toEqual([]);
    expect(translator.translate({ type: "goal_update" }, context())).toEqual(
      [],
    );
  });

  it("renders a paused goal as an open row (it still exists)", () => {
    const translator = createPrimeDeltaTranslator();
    const deltas = translator.translate(
      goalUpdate({ ...ACTIVE, active: false, status: "paused" }),
      context(),
    );
    expect(kinds(deltas)).toEqual(["item.open"]);
    expect(deltas[0]).toMatchObject({
      item: { payload: { status: "paused" } },
    });
  });
});

describe("the snapshot seed", () => {
  it("answers goalDeltas with the same rows the event would", () => {
    const translator = createPrimeDeltaTranslator();
    const seeded = translator.goalDeltas(ACTIVE, THREAD);
    expect(kinds(seeded)).toEqual(["item.open"]);
    // The seed and the live event share thread state: the next live update
    // progresses the seeded row instead of opening a second one.
    const tick = translator.translate(goalUpdate(ACTIVE), context());
    expect(kinds(tick)).toEqual(["item.progress"]);
  });

  it("ignores an idle snapshot state (no goal, no row)", () => {
    const translator = createPrimeDeltaTranslator();
    expect(
      translator.goalDeltas(
        { active: false, status: "idle", tokensUsed: 0, timeUsedSeconds: 0 },
        THREAD,
      ),
    ).toEqual([]);
    expect(
      translator.goalDeltas(undefined, THREAD),
    ).toEqual([]);
  });
});

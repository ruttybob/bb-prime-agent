import { describe, expect, it } from "vitest";
import { createPrimeDeltaTranslator } from "./delta-translation.js";
import type { ThreadDelta } from "@get-bb/plugin-sdk/provider-bridge";

/**
 * The turn-throughput row (bbpa-b1m.10): tokens per second per turn, as a
 * `prime-agent/turn-usage` extension row opened and settled alongside the
 * boundary. The clock is injected per event (`context.now`) — the lane owns
 * it, the tests freeze it — and turns without usage render no row.
 */

const CONTEXT = {
  threadId: "thr_tps",
  cwd: "/tmp/prime-workspace",
  model: "zai/glm-5.3-flash",
  modelContextWindow: 1_000_000,
};

function assistant(args: { output: number; totalTokens?: number; stopReason?: string }) {
  return {
    role: "assistant",
    content: [{ type: "text", text: "working" }],
    stopReason: args.stopReason ?? "stop",
    usage: {
      input: 100,
      output: args.output,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: args.totalTokens ?? 100 + args.output,
    },
  };
}

function agentEnd(messages: unknown[]): unknown {
  return { type: "agent_end", messages };
}

/** A clock-stamped context: `start` stamps agent_start, `now` the boundary. */
function run(start: number | undefined, now: number | undefined, end?: unknown) {
  const translator = createPrimeDeltaTranslator();
  translator.translate(
    { type: "agent_start" },
    start === undefined ? CONTEXT : { ...CONTEXT, now: start },
  );
  return translator.translate(
    end ?? agentEnd([assistant({ output: 76 })]),
    now === undefined ? CONTEXT : { ...CONTEXT, now },
  );
}

function rows(deltas: readonly ThreadDelta[]): ThreadDelta[] {
  return deltas.filter((delta) => delta.kind === "item.open" || delta.kind === "item.close");
}

describe("the turn-throughput row on a live turn", () => {
  it("opens and closes with sane tps math from the frozen clock", () => {
    // 76 output tokens over exactly one second.
    const deltas = run(1_000, 2_000);
    const [open, close] = rows(deltas);
    expect(open).toEqual({
      kind: "item.open",
      key: { channel: "turn-usage-1" },
      item: {
        type: "extension",
        kind: "prime-agent/turn-usage",
        payload: { outputTokens: 76, durationMs: 1_000, tps: 76, model: "zai/glm-5.3-flash" },
      },
      attach: "currentOrLast",
      presentation: {
        label: { pending: "tokens", completed: "tokens" },
        icon: { glyph: "gauge" },
        title: "76 tok/s",
      },
    });
    expect(close).toMatchObject({
      kind: "item.close",
      key: { channel: "turn-usage-1" },
      status: "completed",
    });
  });

  it("sums output across a multi-round turn, unlike the usage row's last", () => {
    // The recorded live turn's shape: a tool-use round (51 tokens) plus the
    // final round (108) — the turn generated 159, `last` saw only 108.
    const translator = createPrimeDeltaTranslator();
    translator.translate({ type: "agent_start" }, { ...CONTEXT, now: 0 });
    const deltas = translator.translate(
      agentEnd([assistant({ output: 51 }), assistant({ output: 108, totalTokens: 208 })]),
      { ...CONTEXT, now: 3_000 },
    );
    expect(deltas.find((delta) => delta.kind === "usage")).toMatchObject({
      last: { outputTokens: 108 },
    });
    expect(deltas.find((delta) => delta.kind === "item.open")).toMatchObject({
      item: { payload: { outputTokens: 159, durationMs: 3_000, tps: 53 } },
    });
  });

  it("formats the headline: one decimal under 100, integer at 100+", () => {
    const cases: Array<{ output: number; ms: number; title: string }> = [
      { output: 384, ms: 10_000, title: "38.4 tok/s" },
      { output: 380, ms: 10_000, title: "38 tok/s" },
      { output: 13_766, ms: 100_000, title: "138 tok/s" },
      { output: 9_996, ms: 100_000, title: "100 tok/s" },
      { output: 0, ms: 5_000, title: "0 tok/s" },
    ];
    for (const { output, ms, title } of cases) {
      const translator = createPrimeDeltaTranslator();
      translator.translate({ type: "agent_start" }, { ...CONTEXT, now: 0 });
      const deltas = translator.translate(
        agentEnd([assistant({ output, totalTokens: output + 100 })]),
        { ...CONTEXT, now: ms },
      );
      expect(deltas.find((delta) => delta.kind === "item.open")).toMatchObject({
        presentation: { title },
      });
    }
  });

  it("closes interrupted when the turn was already settled locally (soft stop)", () => {
    // Prime's `agent_end` for the aborted run still carries usage, but the
    // boundary was suppressed: the row closes without claiming completion.
    const translator = createPrimeDeltaTranslator();
    translator.translate({ type: "agent_start" }, { ...CONTEXT, now: 1_000 });
    const deltas = translator.translate(
      agentEnd([assistant({ output: 20, stopReason: "aborted" })]),
      { ...CONTEXT, now: 2_000, suppressTurnBoundary: true },
    );
    expect(rows(deltas)).toHaveLength(2);
    expect(deltas.find((delta) => delta.kind === "item.close")).toMatchObject({
      status: "interrupted",
    });
    expect(deltas.find((delta) => delta.kind === "turn.boundary")).toBeUndefined();
  });

  it("mints a fresh ordinal per turn", () => {
    const translator = createPrimeDeltaTranslator();
    translator.translate({ type: "agent_start" }, { ...CONTEXT, now: 0 });
    translator.translate(agentEnd([assistant({ output: 10 })]), { ...CONTEXT, now: 1_000 });
    translator.translate({ type: "agent_start" }, { ...CONTEXT, now: 5_000 });
    const second = translator.translate(
      agentEnd([assistant({ output: 10 })]),
      { ...CONTEXT, now: 6_000 },
    );
    expect(second.find((delta) => delta.kind === "item.open")).toMatchObject({
      key: { channel: "turn-usage-2" },
    });
  });

  it("clamps a clock that runs backwards to a zero-duration row", () => {
    const deltas = run(2_000, 1_000);
    expect(deltas.find((delta) => delta.kind === "item.open")).toMatchObject({
      item: { payload: { durationMs: 0, tps: 0 } },
      presentation: { title: "0 tok/s" },
    });
  });
});

describe("turns that render no throughput row", () => {
  it("renders no row without usage", () => {
    const translator = createPrimeDeltaTranslator();
    translator.translate({ type: "agent_start" }, { ...CONTEXT, now: 0 });
    const deltas = translator.translate(
      agentEnd([
        { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
      ]),
      { ...CONTEXT, now: 1_000 },
    );
    expect(rows(deltas)).toEqual([]);
    expect(deltas.find((delta) => delta.kind === "usage")).toBeUndefined();
  });

  it("renders no row when the turn opened without a clock", () => {
    const translator = createPrimeDeltaTranslator();
    translator.translate({ type: "agent_start" }, CONTEXT);
    const deltas = translator.translate(
      agentEnd([assistant({ output: 76 })]),
      { ...CONTEXT, now: 1_000 },
    );
    expect(rows(deltas)).toEqual([]);
  });

  it("renders no rows from a snapshot replay — timing cannot be honestly rebuilt", () => {
    const translator = createPrimeDeltaTranslator();
    const deltas = translator.snapshotDeltas([
      { role: "user", content: "count" },
      assistant({ output: 76 }),
    ]);
    expect(
      deltas.filter(
        (delta) =>
          delta.kind === "item.open" &&
          (delta as { item?: { kind?: string } }).item?.kind ===
            "prime-agent/turn-usage",
      ),
    ).toEqual([]);
  });
});

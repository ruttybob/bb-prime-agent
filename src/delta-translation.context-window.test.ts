import { describe, expect, it } from "vitest";
import { createPrimeDeltaTranslator } from "./delta-translation.js";
import type { ThreadDelta } from "@get-bb/plugin-sdk/provider-bridge";

/**
 * The context window on the timeline (bbpa-b1m.9): the usage row carries the
 * active model's window, and a dedicated `contextWindow` row meters how full
 * that window is. Rows ride `agent_end`'s usage — the last assistant
 * message's tokens — and a model without a known window invents nothing.
 */

const CONTEXT = (window?: number) => ({
  threadId: "thr_window",
  cwd: "/tmp/prime-workspace",
  modelContextWindow: window,
});

function turnEnd(args: {
  input?: number;
  output?: number;
  totalTokens?: number;
}): unknown {
  return {
    type: "agent_end",
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        stopReason: "stop",
        usage: {
          input: args.input ?? 5,
          output: args.output ?? 2,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: args.totalTokens ?? 7,
        },
      },
    ],
  };
}

describe("a usage event with a known context window", () => {
  it("fills modelContextWindow and emits the contextWindow row", () => {
    const translator = createPrimeDeltaTranslator();
    const deltas = translator.translate(turnEnd({}), CONTEXT(1_000_000));
    // The agent_end boundary rides along; only the usage pair is asserted here.
    const relevant = deltas.filter(
      (delta) => delta.kind === "usage" || delta.kind === "contextWindow",
    );
    expect(relevant.map((delta) => delta.kind)).toEqual(["usage", "contextWindow"]);
    expect(relevant[0]).toMatchObject({
      kind: "usage",
      total: { totalTokens: 7 },
      last: { totalTokens: 7 },
      modelContextWindow: 1_000_000,
    });
    expect(relevant[1]).toEqual({
      kind: "contextWindow",
      used: 7,
      size: 1_000_000,
      estimated: true,
      attach: "currentOrLast",
    });
  });

  it("meters the last turn's tokens, not the session's cumulative sum", () => {
    const translator = createPrimeDeltaTranslator();
    translator.translate(turnEnd({ input: 100, totalTokens: 102 }), CONTEXT(1_000_000));
    const second = translator.translate(
      turnEnd({ input: 50, totalTokens: 52 }),
      CONTEXT(1_000_000),
    );
    // The usage row's `total` accumulates (102 + 52), but the context row
    // keeps metering the window's fill: the latest turn's tokens.
    expect(second[0]).toMatchObject({
      kind: "usage",
      total: { totalTokens: 154 },
      last: { totalTokens: 52 },
    });
    expect(second[1]).toMatchObject({
      kind: "contextWindow",
      used: 52,
      size: 1_000_000,
    });
  });

  it("attaches the row to the current or last turn, like the usage row", () => {
    const translator = createPrimeDeltaTranslator();
    const deltas = translator.translate(turnEnd({}), CONTEXT(200_000));
    const row = deltas.find(
      (delta: ThreadDelta) => delta.kind === "contextWindow",
    ) as { attach: string } | undefined;
    expect(row?.attach).toBe("currentOrLast");
  });
});

describe("a session without a known context window", () => {
  it("keeps modelContextWindow null and emits no contextWindow row", () => {
    const translator = createPrimeDeltaTranslator();
    const deltas = translator.translate(turnEnd({}), CONTEXT(undefined));
    // The unknown-window shape is exactly today's: one usage row, window
    // null, nothing invented. (The agent_end turn boundary rides along as
    // before and is not part of this assertion.)
    expect(deltas.filter((delta) => delta.kind !== "turn.boundary")).toEqual([
      {
        kind: "usage",
        total: { totalTokens: 7, inputTokens: 5, cachedInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0 },
        last: { totalTokens: 7, inputTokens: 5, cachedInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0 },
        modelContextWindow: null,
      },
    ]);
  });
});

describe("a turn without usage", () => {
  it("renders neither a usage nor a contextWindow row", () => {
    const translator = createPrimeDeltaTranslator();
    const deltas = translator.translate(
      {
        type: "agent_end",
        messages: [
          { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
        ],
      },
      CONTEXT(1_000_000),
    );
    expect(deltas.filter((delta) => delta.kind === "contextWindow")).toEqual([]);
    expect(deltas.filter((delta) => delta.kind === "usage")).toEqual([]);
  });
});

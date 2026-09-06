import { describe, expect, it } from "vitest";
import { createPrimeDeltaTranslator } from "./delta-translation.js";

/**
 * The autonomous-status row (bbpa-b1m.6): every `/autonomous` command writes
 * one durable `autonomous_status` custom message — the only wire-visible
 * autonomous status (no RPC, no connection-state field) — and the bridge
 * renders it as a settled `prime-agent/autonomous` row carrying the budgets.
 */

const CONTEXT = { threadId: "thr_auto", cwd: "/tmp/prime-workspace" };

function statusMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    role: "custom",
    customType: "autonomous_status",
    content:
      "Autonomous mode: on. Continuations: 3/8. Turns: 12/40. Tokens: 45000/1000000.",
    display: true,
    details: {
      enabled: true,
      continuationsUsed: 3,
      turnsUsed: 12,
      tokensUsed: 45000,
      limits: {
        maxContinuations: 8,
        maxTurns: 40,
        maxTokens: 1000000,
        timeoutMs: 1800000,
      },
      gates: { commands: [], maxRetries: 3, timeoutMs: 60000 },
      gateAttempts: {},
    },
    timestamp: 1725600000000,
    ...overrides,
  };
}

describe("an autonomous_status message", () => {
  it("renders one settled row carrying the budgets", () => {
    const translator = createPrimeDeltaTranslator();
    const deltas = translator.translate(
      { type: "message_start", message: statusMessage() },
      CONTEXT,
    );
    expect(deltas.map((delta) => delta.kind)).toEqual([
      "item.open",
      "item.close",
    ]);
    expect(deltas[0]).toMatchObject({
      kind: "item.open",
      key: { channel: "autonomous-1" },
      item: {
        type: "extension",
        kind: "prime-agent/autonomous",
        payload: {
          enabled: true,
          continuationsUsed: 3,
          turnsUsed: 12,
          tokensUsed: 45000,
          maxContinuations: 8,
          maxTurns: 40,
          maxTokens: 1000000,
        },
      },
      attach: "currentOrLast",
    });
    expect(deltas[1]).toMatchObject({
      kind: "item.close",
      key: { channel: "autonomous-1" },
      status: "completed",
      resultText: "autonomous on · 3/8 continuations · 12/40 turns · 45000/1000000 tokens",
    });
  });

  it("labels an off status without numbers", () => {
    const translator = createPrimeDeltaTranslator();
    const deltas = translator.translate(
      {
        type: "message_start",
        message: statusMessage({
          content: "Autonomous mode: off. Continuations: 0/8.",
          details: {
            enabled: false,
            continuationsUsed: 0,
            turnsUsed: 0,
            tokensUsed: 0,
            limits: { maxContinuations: 8, maxTurns: 40, maxTokens: 1000000 },
          },
        }),
      },
      CONTEXT,
    );
    expect(deltas[0]).toMatchObject({
      item: { payload: { enabled: false } },
      presentation: { title: "Autonomous off" },
    });
    expect(deltas[1]).toMatchObject({
      status: "completed",
      resultText: "autonomous off",
    });
  });

  it("keys successive rows distinctly and leaves message_end silent", () => {
    const translator = createPrimeDeltaTranslator();
    const first = translator.translate(
      { type: "message_start", message: statusMessage() },
      CONTEXT,
    );
    const second = translator.translate(
      { type: "message_start", message: statusMessage() },
      CONTEXT,
    );
    expect(first[0]).toMatchObject({ key: { channel: "autonomous-1" } });
    expect(second[0]).toMatchObject({ key: { channel: "autonomous-2" } });
    expect(
      translator.translate(
        { type: "message_end", message: statusMessage() },
        CONTEXT,
      ),
    ).toEqual([]);
  });

  it("renders nothing when the details are missing or malformed", () => {
    const translator = createPrimeDeltaTranslator();
    expect(
      translator.translate(
        {
          type: "message_start",
          message: statusMessage({ details: undefined }),
        },
        CONTEXT,
      ),
    ).toEqual([]);
    expect(
      translator.translate(
        {
          type: "message_start",
          message: statusMessage({ details: { enabled: "yes" } }),
        },
        CONTEXT,
      ),
    ).toEqual([]);
  });
});

describe("an autonomous_status in snapshot replay", () => {
  it("replays the settled row", () => {
    const translator = createPrimeDeltaTranslator();
    const deltas = translator.snapshotDeltas([
      { role: "user", content: "/autonomous on" },
      statusMessage(),
    ]);
    expect(deltas.map((delta) => delta.kind)).toEqual([
      "input.provider",
      "item.open",
      "item.close",
    ]);
    expect(deltas[1]).toMatchObject({
      item: { kind: "prime-agent/autonomous", payload: { enabled: true } },
    });
  });
});

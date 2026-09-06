import { describe, expect, it } from "vitest";
import {
  boundTranscript,
  entriesFromWireMessages,
  transcriptEntrySchema,
} from "./transcript.js";

/**
 * The transcript view model, from the wire messages an attach snapshot (and
 * `message_end` pushes) carry.
 *
 * The panel renders roles, not prime's raw message JSON: a user prompt, what
 * the child answered, and each tool call paired with its result. Pairing is
 * the part that must be honest — a tool row without its result (or the
 * reverse) reads as the child hiding something. The parse may carry pairing
 * glue (`toolCallId`) for the tracker; the contract schema is what the panel
 * actually receives, so the assertions here go through it.
 */

/** The panel-facing shape: parse → bound → the contract's schema. */
function panelEntries(messages: readonly unknown[]): unknown[] {
  return boundedShape(entriesFromWireMessages(messages));
}

function boundedShape(entries: ReturnType<typeof entriesFromWireMessages>) {
  return boundTranscript(entries, {
    maxEntries: 10_000,
    maxTotalBytes: Number.MAX_SAFE_INTEGER,
  }).entries.map((entry) => transcriptEntrySchema.parse(entry));
}

describe("entriesFromWireMessages", () => {
  it("renders a user prompt, the answer text and a tool call with its result", () => {
    // A worked example in pi's durable message shapes: the three roles a
    // child session actually writes, with the result arriving as its own
    // `toolResult` message after the assistant's `toolCall` block.
    const messages = [
      { role: "user", content: "scout the repo" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "where to look…" },
          { type: "text", text: "checking the manifest" },
          { type: "toolCall", id: "tc_1", name: "bash", arguments: { command: "ls" } },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "tc_1",
        toolName: "bash",
        content: [{ type: "text", text: "README\nsrc\n" }],
        isError: false,
      },
    ];
    expect(panelEntries(messages)).toEqual([
      { kind: "user", text: "scout the repo" },
      { kind: "thinking", text: "where to look…" },
      { kind: "assistant", text: "checking the manifest" },
      {
        kind: "tool",
        toolName: "bash",
        argsPreview: '{"command":"ls"}',
        resultText: "README\nsrc",
        isError: false,
      },
    ]);
  });

  it("leaves a tool row open when its result has not arrived yet", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "tc_1", name: "read", arguments: { path: "x" } }],
      },
    ];
    expect(panelEntries(messages)).toEqual([
      { kind: "tool", toolName: "read", argsPreview: '{"path":"x"}' },
    ]);
  });
});

describe("boundTranscript", () => {
  const huge = "x".repeat(50);

  function entries(...kinds: string[]) {
    return kinds.map((kind, index) => ({
      kind,
      text: `${kind}-${index}`,
      ...(kind === "tool" ? { resultText: huge } : {}),
    })) as ReturnType<typeof entriesFromWireMessages>;
  }

  it("drops the oldest rows first and says so once anything was dropped", () => {
    const bounded = boundTranscript(entries("user", "assistant", "tool", "user"), {
      maxEntries: 2,
      maxTotalBytes: Number.MAX_SAFE_INTEGER,
    });
    expect(bounded.entries.map((entry) => entry.text)).toEqual(["tool-2", "user-3"]);
    expect(bounded.truncated).toBe(true);
  });

  it("is honest about bytes, not only rows", () => {
    const bounded = boundTranscript(entries("tool", "user"), {
      maxEntries: 100,
      maxTotalBytes: 8,
    });
    // Both rows are far under the row cap, but the tool row alone (its 50-byte
    // result) blows the byte cap, so the oldest row goes first.
    expect(bounded.entries.map((entry) => entry.kind)).toEqual(["user"]);
    expect(bounded.truncated).toBe(true);
  });

  it("caps one oversized text so a single huge result cannot evict everything", () => {
    const messages = [
      {
        role: "toolResult",
        toolCallId: "tc_1",
        content: [{ type: "text", text: "y".repeat(5000) }],
      },
      { role: "assistant", content: [{ type: "toolCall", id: "tc_1", name: "bash", arguments: {} }] },
    ];
    const [toolEntry] = panelEntries(messages);
    const resultText = (toolEntry as { resultText?: string }).resultText ?? "";
    expect(resultText.startsWith("y".repeat(10))).toBe(true);
    expect(resultText.endsWith("…")).toBe(true);
    expect(resultText.length).toBeLessThanOrEqual(2001);
  });
});

describe("entriesFromWireMessages tolerance", () => {
  it("skips messages it cannot render instead of failing the transcript", () => {
    const messages = [
      { role: "custom_thing", content: "prime 0.8 invented this" },
      { role: "user", content: "still works" },
      "not even an object",
      undefined,
    ];
    expect(panelEntries(messages)).toEqual([{ kind: "user", text: "still works" }]);
  });

  it("renders an empty transcript honestly when the session has no messages", () => {
    expect(panelEntries([])).toEqual([]);
  });
});

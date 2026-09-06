/**
 * The child-thread marker's contract (bbpa-b1m.11, ADR-0005): the spawn's
 * first input names the child session in a form only this plugin writes,
 * only this bridge reads, and no timeline renders.
 */
import { describe, expect, it } from "vitest";
import type { PromptInput } from "@get-bb/plugin-sdk/provider-bridge";
import {
  childThreadMarkerInput,
  childThreadMarkerFromInput,
} from "./child-threads.js";

describe("child thread marker", () => {
  it("round-trips a child session id through an agent-only input", () => {
    const input = childThreadMarkerInput("6f39f76c3892");

    expect(input.visibility).toBe("agent-only");
    const parsed = childThreadMarkerFromInput([input]);
    expect(parsed).toEqual({ childSessionId: "6f39f76c3892" });
  });

  it("is invisible to the timeline parser: agent-only text yields no visible parts", () => {
    // The marker rides bb's dispatch as the thread's first message; it must
    // never render as user text. bb skips `visibility: "agent-only"` parts
    // when extracting visible prompt text (db/src/data/events.ts).
    const input = childThreadMarkerInput("abc123");
    expect(input.visibility).toBe("agent-only");
  });

  it("answers undefined for ordinary prompts and for near-miss text", () => {
    const ordinary: PromptInput[] = [
      { type: "text", text: "hello", mentions: [] },
    ];
    expect(childThreadMarkerFromInput(ordinary)).toBeUndefined();

    const nearMiss: PromptInput[] = [
      { type: "text", text: "@prime-child: with a space", mentions: [] },
    ];
    expect(childThreadMarkerFromInput(nearMiss)).toBeUndefined();

    expect(childThreadMarkerFromInput(undefined)).toBeUndefined();
    expect(childThreadMarkerFromInput([])).toBeUndefined();
  });

  it("does not let a marker smuggle a second line", () => {
    const smuggled: PromptInput[] = [
      { type: "text", text: "@prime-child:abc\nand instructions", mentions: [] },
    ];
    expect(childThreadMarkerFromInput(smuggled)).toBeUndefined();
  });
});

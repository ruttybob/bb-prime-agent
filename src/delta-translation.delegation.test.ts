import { describe, expect, it } from "vitest";
import { createPrimeDeltaTranslator } from "./delta-translation.js";
import type { ThreadDelta } from "@get-bb/plugin-sdk/provider-bridge";

/**
 * prime's RLM children → bb delegation items (bbpa-ggf.9).
 *
 * A child appearing, progressing and settling is one delegation item keyed by
 * the child id: opened once, progressed by prime's repeated updates, settled
 * exactly once by a terminal status. A snapshot's children (the only record a
 * resumed session has of subagents spawned outside bb) rebuild the same items.
 */

const CONTEXT = { threadId: "thr_children", cwd: "/tmp/prime-workspace" };

function childUpdate(child: Record<string, unknown>): unknown {
  return { type: "rlm_child_update", child: { sessionDir: "/tmp/prime/children", ...child } };
}

function delegationKinds(deltas: readonly ThreadDelta[]): string[] {
  return deltas.map((delta) => delta.kind);
}

describe("a live child stream", () => {
  it("opens a delegation item once and progresses the repeats", () => {
    const translator = createPrimeDeltaTranslator();
    const queued = translator.translate(
      childUpdate({ id: "child_1", label: "scout", status: "queued" }),
      CONTEXT,
    );
    expect(delegationKinds(queued)).toEqual(["item.open", "item.progress"]);
    expect(queued[0]).toMatchObject({
      kind: "item.open",
      key: { providerItemId: "child_1", channel: "delegation" },
      item: { type: "delegation", childRef: "child_1", label: "scout", background: true },
    });

    const running = translator.translate(
      childUpdate({
        id: "child_1",
        label: "scout",
        status: "running",
        activeSessionId: "sess_child_1",
        model: "zai/glm-5.3-flash",
        tokenCount: 4321,
        toolUseCount: 3,
      }),
      CONTEXT,
    );
    // No second open: bb would mint a duplicate started row for one item.
    expect(delegationKinds(running)).toEqual(["item.progress"]);
    expect(running[0]).toMatchObject({
      kind: "item.progress",
      key: { providerItemId: "child_1", channel: "delegation" },
      snapshot: {
        type: "delegation",
        childRef: "sess_child_1",
        label: "scout",
        background: true,
      },
    });
  });

  it("carries prime's recap, else the activity, as the progress line", () => {
    const translator = createPrimeDeltaTranslator();
    const recap = translator.translate(
      childUpdate({
        id: "child_1",
        label: "scout",
        status: "running",
        recap: "reading the daemon protocol",
      }),
      CONTEXT,
    );
    expect(recap.at(-1)).toMatchObject({
      kind: "item.progress",
      message: "reading the daemon protocol",
    });

    const activity = translator.translate(
      childUpdate({
        id: "child_1",
        label: "scout",
        status: "running",
        activity: { kind: "executing", toolName: "bash" },
      }),
      CONTEXT,
    );
    expect(activity.at(-1)).toMatchObject({
      kind: "item.progress",
      message: "executing bash",
    });
  });

  it("settles done as completed with prime's answer, and settles only once", () => {
    const translator = createPrimeDeltaTranslator();
    translator.translate(
      childUpdate({ id: "child_1", label: "scout", status: "running" }),
      CONTEXT,
    );
    const done = translator.translate(
      childUpdate({
        id: "child_1",
        label: "scout",
        status: "done",
        answerPreview: "found three call sites",
      }),
      CONTEXT,
    );
    expect(delegationKinds(done)).toEqual(["item.close"]);
    expect(done[0]).toMatchObject({
      kind: "item.close",
      key: { providerItemId: "child_1", channel: "delegation" },
      item: { type: "delegation", label: "scout" },
      status: "completed",
      resultText: "found three call sites",
    });
  });

  it("settles error as failed with the failure reason, cancelled as interrupted", () => {
    const translator = createPrimeDeltaTranslator();
    const failed = translator.translate(
      childUpdate({
        id: "child_1",
        label: "scout",
        status: "error",
        recap: "was reading the transcript",
        error: "the daemon ran out of memory",
      }),
      CONTEXT,
    );
    // A child this bridge never saw running is opened on the way past, so the
    // settled row exists at all.
    expect(delegationKinds(failed)).toEqual(["item.open", "item.close"]);
    expect(failed.at(-1)).toMatchObject({
      kind: "item.close",
      status: "failed",
      resultText: "the daemon ran out of memory",
    });

    const cancelled = translator.translate(
      childUpdate({ id: "child_2", label: "dup", status: "cancelled" }),
      CONTEXT,
    );
    expect(cancelled.at(-1)).toMatchObject({ kind: "item.close", status: "interrupted" });
  });

  it("answers an unreadable child with unhandled rather than an invented item", () => {
    const translator = createPrimeDeltaTranslator();
    const deltas = translator.translate(
      { type: "rlm_child_update", child: { status: "running" } },
      CONTEXT,
    );
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({ kind: "unhandled", rawType: "prime/session_event" });
  });
});

describe("a snapshot's children (an adopted session)", () => {
  it("rebuilds finished children as opened-and-settled items", () => {
    const translator = createPrimeDeltaTranslator();
    const deltas = translator.childrenDeltas(
      [
        {
          id: "child_1",
          label: "scout",
          status: "done",
          activeSessionId: "sess_child_1",
          answerPreview: "found three call sites",
          sessionDir: "/tmp/prime/children",
        },
      ],
      CONTEXT.threadId,
    );
    expect(delegationKinds(deltas)).toEqual(["item.open", "item.close"]);
    expect(deltas[0]).toMatchObject({ kind: "item.open", attach: "currentOrLast" });
    expect(deltas[1]).toMatchObject({ kind: "item.close", status: "completed" });
  });

  it("leaves live children open, and a later update does not re-open them", () => {
    const translator = createPrimeDeltaTranslator();
    const snapshot = translator.childrenDeltas(
      [
        {
          id: "child_1",
          label: "scout",
          status: "running",
          activeSessionId: "sess_child_1",
          sessionDir: "/tmp/prime/children",
        },
      ],
      CONTEXT.threadId,
    );
    expect(delegationKinds(snapshot)).toEqual(["item.open", "item.progress"]);

    const update = translator.translate(
      childUpdate({
        id: "child_1",
        label: "scout",
        status: "running",
        recap: "still reading",
      }),
      CONTEXT,
    );
    expect(delegationKinds(update)).toEqual(["item.progress"]);
  });

  it("skips unreadable entries instead of inventing items", () => {
    const translator = createPrimeDeltaTranslator();
    const deltas = translator.childrenDeltas(
      [{ status: "done" }, "not a child", null],
      CONTEXT.threadId,
    );
    expect(deltas).toEqual([]);
  });
});

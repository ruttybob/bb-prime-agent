import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  experimental_assembleCapturedThreadEvents as assembleCapturedThreadEvents,
  experimental_captureBridgeJsonRpcOutput as captureBridgeJsonRpcOutput,
  type CapturedBridgeJsonRpcOutput,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import type { ThreadDelta } from "@get-bb/plugin-sdk/provider-bridge";
import { handleLine, resetDaemonForTests, sessionTableForTests } from "./src/provider-bridge.js";
import { setPrimeDaemonTransportFactoryForTests } from "./src/daemon/connection.js";
import {
  createScriptedDaemon,
  textTurnEvents,
  type ScriptedDaemonHandle,
} from "./test-support/scripted-daemon.js";

/**
 * Subagents on the timeline (bbpa-ggf.9).
 *
 * A prime child becomes a delegation item keyed by the child id — one open,
 * progress from prime's repeated updates, one settle — and an adopted
 * session's snapshot children rebuild the same items after a reopen. The live
 * stream is assembled by the runtime's own assembler, so those assertions are
 * what a bb timeline actually holds; the snapshot replay is asserted at the
 * delta level, which is where the rest of the snapshot story (bbpa-ggf.4) is
 * pinned too.
 */

let output: CapturedBridgeJsonRpcOutput;
let daemon: ScriptedDaemonHandle;
const collected: unknown[] = [];
const cwd = "/tmp/prime-workspace";

beforeEach(() => {
  output = captureBridgeJsonRpcOutput();
  collected.length = 0;
  daemon = createScriptedDaemon({
    session: {
      activeSessionId: "sess_children",
      sessionFile: "/tmp/prime/sessions/sess_children.jsonl",
      sessionName: "[bb] children",
      cwd,
    },
  });
  setPrimeDaemonTransportFactoryForTests(() => daemon.transport);
});

afterEach(() => {
  output.restore();
  setPrimeDaemonTransportFactoryForTests(undefined);
  resetDaemonForTests();
  sessionTableForTests().clear();
});

function sendRequest(id: string, method: string, params: unknown): void {
  handleLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
}

function drain(): unknown[] {
  collected.push(...output.takeMessages());
  return collected;
}

function deltas(threadId: string): ThreadDelta[] {
  return drain().flatMap(
    (message): ThreadDelta[] => {
      if (
        typeof message !== "object" ||
        message === null ||
        (message as { method?: unknown }).method !== "thread/delta" ||
        (message as { params?: { threadId?: unknown } }).params?.threadId !==
          threadId
      ) {
        return [];
      }
      return ((message as { params: { deltas?: ThreadDelta[] } }).params
        .deltas ?? []) as ThreadDelta[];
    },
  );
}

function delegationRows(
  events: readonly unknown[],
  type: "item/started" | "item/completed" | "item/delegation/completed",
): Array<{ item: { type: string; label?: string }; status?: string; resultText?: string }> {
  return events.flatMap((event) => {
    const item = (event as { item?: { type?: string } }).item;
    return (event as { type?: unknown }).type === type && item?.type === "delegation"
      ? [(event as { item: { type: string; label?: string } } & Record<string, unknown>)]
      : [];
  });
}

function assembled(threadId: string): ReturnType<typeof assembleCapturedThreadEvents> {
  return assembleCapturedThreadEvents(
    drain().filter(
      (message): message is { method: string; params: Record<string, unknown> } =>
        typeof message === "object" &&
        message !== null &&
        (message as { method?: unknown }).method === "thread/delta" &&
        (message as { params?: Record<string, unknown> }).params?.threadId === threadId,
    ),
    "prime-agent",
  );
}

async function waitFor(
  label: string,
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const FULL_OPTIONS = {
  permissionMode: "full",
  permissionScope: "full",
  approvalReviewer: null,
  permissionEscalation: null,
};

function scoutChild(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "child_1",
    label: "scout",
    status: "running",
    activeSessionId: "sess_child_1",
    model: "zai/glm-5.3-flash",
    tokenCount: 4321,
    sessionDir: "/tmp/prime/children",
    ...overrides,
  };
}

function childUpdate(overrides: Record<string, unknown>): unknown {
  return { type: "rlm_child_update", child: scoutChild(overrides) };
}

describe("a live child stream, assembled", () => {
  it("opens one delegation item, progresses it, and settles it once", async () => {
    daemon.enqueueCreate();
    daemon.enqueueAttach();
    daemon.enqueuePrompt({
      events: [
        ...textTurnEvents({ text: "spawning a scout", usage: { input: 5, output: 2, totalTokens: 7 } }),
        childUpdate({ status: "queued" }),
        childUpdate({ recap: "reading the transcript" }),
        childUpdate({ tokenCount: 9000 }),
        childUpdate({ status: "done", answerPreview: "found three call sites" }),
      ],
    });
    sendRequest("a", "thread/start", {
      threadId: "thr_children",
      cwd,
      instructionMode: "append",
      options: FULL_OPTIONS,
      input: [{ type: "text", text: "spawn a scout", mentions: [] }],
    });
    await waitFor("the child to settle", () =>
      delegationRows(assembled("thr_children"), "item/delegation/completed")
        .length > 0,
    );

    // What the bridge emits: one open (however many updates follow), prime's
    // progress lines, one settle.
    const child = deltas("thr_children");
    expect(
      child.filter(
        (delta) =>
          delta.kind === "item.open" && JSON.stringify(delta.item).includes("scout"),
      ),
    ).toHaveLength(1);
    const progress = child.filter((delta) => delta.kind === "item.progress");
    expect(progress).toHaveLength(3);
    expect(progress.map((delta) => delta.message)).toEqual([
      "subagent is running",
      "reading the transcript",
      "subagent is running",
    ]);
    const closes = child.filter((delta) => delta.kind === "item.close");
    expect(closes).toHaveLength(1);
    expect(closes[0]).toMatchObject({
      status: "completed",
      resultText: "found three call sites",
    });

    // What the timeline holds: the assembler throttles the progress rows, so
    // the user-visible truth is one row, opened once and settled once.
    const events = assembled("thr_children");
    const started = delegationRows(events, "item/started");
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ item: { type: "delegation", label: "scout" } });
    // A background delegation settles as its own thread-scoped event.
    const settled = delegationRows(events, "item/delegation/completed");
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({
      // The child's answer rides the delegation item itself.
      item: { summary: "found three call sites" },
    });
  });
});

describe("snapshot children of an adopted session", () => {
  it("rebuilds delegation items: finished ones settle, live ones stay open", async () => {
    daemon.enqueueAttach({
      children: [
        scoutChild(),
        scoutChild({
          id: "child_2",
          label: "auditor",
          status: "done",
          activeSessionId: "sess_child_2",
          answerPreview: "nothing to report",
        }),
      ],
    });
    sendRequest("a", "thread/resume", {
      threadId: "thr_children",
      providerThreadId: "prime_sess_children",
      cwd,
      instructionMode: "append",
      options: FULL_OPTIONS,
    });
    await waitFor("the resumed roster to arrive", () => {
      const opens = deltas("thr_children").filter(
        (delta) => delta.kind === "item.open" && JSON.stringify(delta.item).includes("child_2"),
      );
      return opens.length > 0;
    });

    const opens = deltas("thr_children").filter((delta) => delta.kind === "item.open");
    const delegated = opens.filter((delta) =>
      JSON.stringify(delta.item).includes("delegation"),
    );
    expect(delegated).toHaveLength(2);
    // Both opens are placed on the session's own history, not on a fabricated
    // current turn.
    for (const open of delegated) {
      expect(open).toMatchObject({ attach: "currentOrLast" });
    }
    const closes = deltas("thr_children").filter((delta) => delta.kind === "item.close");
    // Only the finished child settles, with its answer as the result text.
    expect(closes).toHaveLength(1);
    expect(closes[0]).toMatchObject({
      status: "completed",
      resultText: "nothing to report",
    });
    const progress = deltas("thr_children").filter((delta) => delta.kind === "item.progress");
    expect(progress).toHaveLength(1);
    expect(progress[0]!.key).toMatchObject({ providerItemId: "child_1" });
  });
});

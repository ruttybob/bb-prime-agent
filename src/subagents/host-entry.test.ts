import {
  experimental_createHostEntryHarness as createHostEntryHarness,
} from "@get-bb/plugin-sdk/testing/host";
import { describe, expect, it } from "vitest";
import type { DaemonCommandResult } from "../daemon/client.js";
import type { DaemonPushMessage } from "../daemon/protocol.js";
import type { SubagentsBackendConnection } from "./backend-connection.js";
import { primeSubagentsHostContract } from "./contract.js";
import { createPrimeSubagentsHostEntry } from "./host-entry.js";

/**
 * The host entry behind the Subagents panel, in-process: the SDK's host-entry
 * harness gives the same validation, signal and retention boundaries the
 * daemon worker applies, over a scripted daemon connection. The control
 * actions (bbpa-ggf.10) are pinned to prime's command shapes exactly as the
 * protocol spike documents them.
 */

function child(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "child_1",
    label: "scout",
    status: "running",
    sessionDir: "/tmp/prime/children",
    ...overrides,
  };
}

interface ScriptedConnectionHandle {
  connection: SubagentsBackendConnection;
  readonly commands: Array<Record<string, unknown>>;
  push(message: DaemonPushMessage): void;
}

function scriptedConnection(
  args: {
    children?: unknown[];
    /** Answers beyond the attach snapshot, by command type. */
    answers?: Record<string, DaemonCommandResult>;
    /** Attach answers by the session they name (a child's transcript seed). */
    attachAnswers?: Record<string, DaemonCommandResult>;
  } = {},
): ScriptedConnectionHandle {
  const commands: Array<Record<string, unknown>> = [];
  const listeners = new Set<(message: DaemonPushMessage) => void>();
  const connection: SubagentsBackendConnection = {
    describe: "scripted prime-agent daemon",
    async request(command) {
      commands.push(command);
      if (command.type === "attach") {
        const targeted = args.attachAnswers?.[String(command.activeSessionId)];
        if (targeted !== undefined) {
          return targeted;
        }
        return (
          args.answers?.attach ?? {
            command: "attach",
            success: true,
            data: { snapshot: { children: args.children ?? [] } },
          } satisfies DaemonCommandResult
        );
      }
      return (
        args.answers?.[String(command.type)] ?? {
          command: String(command.type),
          success: true,
        }
      );
    },
    subscribePush(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onReconnect(listener) {
      // The roster re-attaches on its own schedule; the scripted daemon never
      // drops, so the subscription is only collected here.
      return () => {};
    },
    dispose() {},
  };
  return {
    commands,
    push(message) {
      for (const listener of listeners) {
        listener(message);
      }
    },
    connection,
  };
}

/** A `send_message` receipt, as prime answers one. */
function receipt(deliveryStatus: string): DaemonCommandResult {
  return {
    command: "send_message",
    success: true,
    data: { deliveryStatus, deliveryMode: "steer" },
  };
}

describe("the prime subagents host entry", () => {
  it("answers a roster question from the daemon's snapshot children", async () => {
    const scripted = scriptedConnection({
      children: [child(), child({ id: "child_2", status: "done" })],
    });
    const harness = createHostEntryHarness(
      createPrimeSubagentsHostEntry({ createConnection: () => scripted.connection }),
    );

    const answer = await harness.experimental_call("subagents.roster", {
      activeSessionId: "sess_parent",
    });
    expect(answer.children.map((entry) => entry.id)).toEqual(["child_1", "child_2"]);
    expect(scripted.commands).toEqual([
      {
        type: "attach",
        activeSessionId: "sess_parent",
        capabilities: expect.any(Array),
      },
    ]);
    await harness.experimental_dispose();
  });

  it("watches a session without a panel and keeps the pushes flowing", async () => {
    // The child-threads service (bbpa-b1m.11) watches through this proc so a
    // spawn surfaces as a bb thread even when no Subagents panel is open.
    const scripted = scriptedConnection({ children: [child()] });
    const harness = createHostEntryHarness(
      createPrimeSubagentsHostEntry({ createConnection: () => scripted.connection }),
    );

    const answer = await harness.experimental_call("subagents.watch", {
      activeSessionId: "sess_parent",
    });
    expect(answer.children.map((entry) => entry.id)).toEqual(["child_1"]);

    // The watch lends the worker retention exactly like a panel question:
    // pushes keep flowing with no window open.
    scripted.push({
      type: "session_event",
      activeSessionId: "sess_parent",
      event: { type: "rlm_child_update", child: child({ id: "child_2", label: "new" }) },
      meta: { sequence: 1, cursor: { generation: "gen-0", sequence: 1 } },
    } as unknown as DaemonPushMessage);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const pushed = harness
      .experimental_getSignals()
      .filter((signal) => signal.signal === "subagents.changed");
    expect(
      pushed.some((signal) =>
        (signal.payload.children as Array<{ id: string }>).some(
          (entry) => entry.id === "child_2",
        ),
      ),
    ).toBe(true);
    await harness.experimental_dispose();
  });

  it("pushes a validated signal when a watched roster changes", async () => {
    const scripted = scriptedConnection({ children: [] });
    const harness = createHostEntryHarness(
      createPrimeSubagentsHostEntry({ createConnection: () => scripted.connection }),
    );
    await harness.experimental_call("subagents.roster", { activeSessionId: "sess_parent" });

    scripted.push({
      type: "session_event",
      activeSessionId: "sess_parent",
      event: { type: "rlm_child_update", child: child({ status: "done" }) },
      meta: { sequence: 1, cursor: { generation: "gen-0", sequence: 1 } },
    } as unknown as DaemonPushMessage);

    // The push travels out of band (roster → signal), so it settles a tick
    // later than the attach's own seed signal.
    await vi_waitFor(() => {
      const signals = harness.experimental_getSignals();
      expect(signals.at(-1)).toMatchObject({
        signal: "subagents.changed",
        payload: {
          activeSessionId: "sess_parent",
          children: [{ id: "child_1", status: "done" }],
        },
      });
    });
    await harness.experimental_dispose();
  });

  it("holds the worker only while a roster is watched", async () => {
    const scripted = scriptedConnection({ children: [] });
    const harness = createHostEntryHarness(
      createPrimeSubagentsHostEntry({ createConnection: () => scripted.connection }),
    );
    expect(harness.experimental_getRetainedWorkerLeaseCount()).toBe(0);

    await harness.experimental_call("subagents.roster", { activeSessionId: "sess_parent" });
    expect(harness.experimental_getRetainedWorkerLeaseCount()).toBe(1);

    // Roster changes reach the lease decision even when no call is in flight.
    scripted.push({
      type: "session_closed",
      activeSessionId: "sess_parent",
      reason: "killed",
    } as unknown as DaemonPushMessage);
    await vi_waitFor(() => expect(harness.experimental_getRetainedWorkerLeaseCount()).toBe(0));
    await harness.experimental_dispose();
  });

  it("answers the server's failure path legibly when the daemon refuses", async () => {
    const scripted = scriptedConnection({ children: [] });
    scripted.connection.request = async () => ({
      command: "attach",
      success: false,
      error: "no such session",
    });
    const harness = createHostEntryHarness(
      createPrimeSubagentsHostEntry({ createConnection: () => scripted.connection }),
    );
    await expect(
      harness.experimental_call("subagents.roster", { activeSessionId: "sess_missing" }),
    ).rejects.toThrow(/sess_missing/);
    await harness.experimental_dispose();
  });
});

describe("steering a subagent from the panel", () => {
  it("sends prime's send_message to the child, signed by the parent session", async () => {
    const scripted = scriptedConnection({
      children: [
        child({ activeSessionId: "sess_child_1" }),
        child({ id: "child_2", status: "running", activeSessionId: "sess_child_2" }),
      ],
      answers: { send_message: receipt("delivered") },
    });
    const harness = createHostEntryHarness(
      createPrimeSubagentsHostEntry({ createConnection: () => scripted.connection }),
    );

    await expect(
      harness.experimental_call("subagents.steer", {
        activeSessionId: "sess_parent",
        childId: "child_1",
        message: "Focus on the parser, skip the benchmarks",
      }),
    ).resolves.toEqual({ delivery: "delivered" });
    // Exactly one command, shaped exactly as the spike documents it: the
    // target is the child, the sender is the parent session (so the child
    // reads the steer as coming from its parent), and nothing else is set.
    expect(scripted.commands).toEqual([
      { type: "attach", activeSessionId: "sess_parent", capabilities: expect.any(Array) },
      {
        type: "send_message",
        targetActiveSessionId: "sess_child_1",
        message: "Focus on the parser, skip the benchmarks",
        fromActiveSessionId: "sess_parent",
      },
    ]);
    await harness.experimental_dispose();
  });

  it("steers a child that has not booted yet by its child id", async () => {
    const scripted = scriptedConnection({
      children: [child({ id: "child_1", status: "queued" })],
      answers: { send_message: receipt("queued") },
    });
    const harness = createHostEntryHarness(
      createPrimeSubagentsHostEntry({ createConnection: () => scripted.connection }),
    );
    await expect(
      harness.experimental_call("subagents.steer", {
        activeSessionId: "sess_parent",
        childId: "child_1",
        message: "start with the failing test",
      }),
    ).resolves.toEqual({ delivery: "queued" });
    expect(scripted.commands[1]).toMatchObject({
      type: "send_message",
      targetActiveSessionId: "child_1",
    });
    await harness.experimental_dispose();
  });

  it("reports a queued steer as queued instead of delivered", async () => {
    const scripted = scriptedConnection({
      children: [child()],
      answers: { send_message: receipt("queued") },
    });
    const harness = createHostEntryHarness(
      createPrimeSubagentsHostEntry({ createConnection: () => scripted.connection }),
    );
    await expect(
      harness.experimental_call("subagents.steer", {
        activeSessionId: "sess_parent",
        childId: "child_1",
        message: "hold on",
      }),
    ).resolves.toEqual({ delivery: "queued" });
    await harness.experimental_dispose();
  });

  it("refuses to steer a child prime already finished — waking it is a side effect", async () => {
    const scripted = scriptedConnection({
      children: [child({ status: "done", answerPreview: "all clear" })],
    });
    const harness = createHostEntryHarness(
      createPrimeSubagentsHostEntry({ createConnection: () => scripted.connection }),
    );
    await expect(
      harness.experimental_call("subagents.steer", {
        activeSessionId: "sess_parent",
        childId: "child_1",
        message: "one more thing",
      }),
    ).rejects.toThrow(/is done, not running/u);
    // The refusal happened here, not on the wire: prime never saw a message.
    expect(scripted.commands.map((command) => command.type)).toEqual(["attach"]);
    await harness.experimental_dispose();
  });

  it("refuses to steer a child the watched session does not have", async () => {
    const scripted = scriptedConnection({
      children: [child()],
      answers: { send_message: receipt("delivered") },
    });
    const harness = createHostEntryHarness(
      createPrimeSubagentsHostEntry({ createConnection: () => scripted.connection }),
    );
    await expect(
      harness.experimental_call("subagents.steer", {
        activeSessionId: "sess_parent",
        childId: "child_other",
        message: "hello",
      }),
    ).rejects.toThrow(/no subagent "child_other" in session sess_parent/u);
    expect(scripted.commands.map((command) => command.type)).toEqual(["attach"]);
    await harness.experimental_dispose();
  });

  it("surfaces prime's refusal to deliver as an error", async () => {
    const scripted = scriptedConnection({
      children: [child()],
      answers: {
        send_message: {
          command: "send_message",
          success: false,
          error: "Agent messaging rate limit exceeded; retry after 400ms",
        },
      },
    });
    const harness = createHostEntryHarness(
      createPrimeSubagentsHostEntry({ createConnection: () => scripted.connection }),
    );
    await expect(
      harness.experimental_call("subagents.steer", {
        activeSessionId: "sess_parent",
        childId: "child_1",
        message: "hello",
      }),
    ).rejects.toThrow(/refused to steer "scout".*rate limit/u);
    await harness.experimental_dispose();
  });
});

describe("stopping a subagent from the panel", () => {
  it("sends exactly one cancel_rlm_child for the chosen child", async () => {
    const scripted = scriptedConnection({
      // A sibling on the roster, so a stop that leaked would be visible here.
      children: [
        child(),
        child({ id: "child_2", label: "digger", activeSessionId: "sess_child_2" }),
      ],
      answers: { cancel_rlm_child: { command: "cancel_rlm_child", success: true, data: { cancelled: true } } },
    });
    const harness = createHostEntryHarness(
      createPrimeSubagentsHostEntry({ createConnection: () => scripted.connection }),
    );

    await expect(
      harness.experimental_call("subagents.stop", {
        activeSessionId: "sess_parent",
        childId: "child_1",
      }),
    ).resolves.toEqual({ cancelled: true });
    // One command, prime's own shape: the parent session and A's child id.
    // No second cancel, no child session id, no sibling, no parent abort.
    expect(scripted.commands).toEqual([
      { type: "attach", activeSessionId: "sess_parent", capabilities: expect.any(Array) },
      {
        type: "cancel_rlm_child",
        activeSessionId: "sess_parent",
        childId: "child_1",
      },
    ]);
    await harness.experimental_dispose();
  });

  it("refuses to report a stop prime did not perform", async () => {
    const scripted = scriptedConnection({
      children: [child({ status: "done", answerPreview: "all clear" })],
      answers: { cancel_rlm_child: { command: "cancel_rlm_child", success: true, data: { cancelled: false } } },
    });
    const harness = createHostEntryHarness(
      createPrimeSubagentsHostEntry({ createConnection: () => scripted.connection }),
    );
    await expect(
      harness.experimental_call("subagents.stop", {
        activeSessionId: "sess_parent",
        childId: "child_1",
      }),
    ).rejects.toThrow(/cancelled:false.*nothing was stopped/u);
    await harness.experimental_dispose();
  });

  it("surfaces the daemon's refusal to cancel as an error", async () => {
    const scripted = scriptedConnection({
      children: [child()],
      answers: {
        cancel_rlm_child: {
          command: "cancel_rlm_child",
          success: false,
          error: "no such session",
        },
      },
    });
    const harness = createHostEntryHarness(
      createPrimeSubagentsHostEntry({ createConnection: () => scripted.connection }),
    );
    await expect(
      harness.experimental_call("subagents.stop", {
        activeSessionId: "sess_parent",
        childId: "child_1",
      }),
    ).rejects.toThrow(/refused to stop "scout".*no such session/u);
    await harness.experimental_dispose();
  });

  it("refuses to stop a child the watched session does not have", async () => {
    const scripted = scriptedConnection({ children: [] });
    const harness = createHostEntryHarness(
      createPrimeSubagentsHostEntry({ createConnection: () => scripted.connection }),
    );
    await expect(
      harness.experimental_call("subagents.stop", {
        activeSessionId: "sess_parent",
        childId: "child_9",
      }),
    ).rejects.toThrow(/no subagent "child_9"/u);
    expect(scripted.commands.map((command) => command.type)).toEqual(["attach"]);
    await harness.experimental_dispose();
  });
});

describe("the control surface's limits", () => {
  it("answers a roster, a steer and a stop — and nothing that deletes a subagent", async () => {
    // The whole panel surface, driven end to end over one scripted daemon.
    const scripted = scriptedConnection({
      children: [child(), child({ id: "child_2", label: "digger", activeSessionId: "sess_child_2" })],
      answers: {
        send_message: receipt("delivered"),
        cancel_rlm_child: { command: "cancel_rlm_child", success: true, data: { cancelled: true } },
      },
    });
    const harness = createHostEntryHarness(
      createPrimeSubagentsHostEntry({ createConnection: () => scripted.connection }),
    );
    await harness.experimental_call("subagents.roster", { activeSessionId: "sess_parent" });
    await harness.experimental_call("subagents.steer", {
      activeSessionId: "sess_parent",
      childId: "child_1",
      message: "wrap it up",
    });
    await harness.experimental_call("subagents.stop", {
      activeSessionId: "sess_parent",
      childId: "child_1",
    });
    await harness.experimental_call("subagents.stop", {
      activeSessionId: "sess_parent",
      childId: "child_2",
    });

    // Stopping is cancelling: a tombstoned ledger row and a kept transcript.
    // prime's delete_rlm_subagent (the ledger *delete*) is never spelled.
    expect(scripted.commands.map((command) => command.type)).toEqual([
      "attach",
      "send_message",
      "cancel_rlm_child",
      "cancel_rlm_child",
    ]);
    expect(
      scripted.commands.some((command) => command.type === "delete_rlm_subagent"),
    ).toBe(false);
    await harness.experimental_dispose();
  });

  it("exposes no ledger-deleting host method", () => {
    expect(Object.keys(primeSubagentsHostContract).sort()).toEqual([
      "subagents.roster",
      "subagents.steer",
      "subagents.stop",
      "subagents.transcript",
      "subagents.watch",
    ]);
  });
});

async function vi_waitFor(predicate: () => void): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (true) {
    try {
      predicate();
      return;
    } catch (error) {
      if (Date.now() > deadline) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

describe("reading a child's transcript from the panel", () => {
  it("attaches to the child's own session and answers its bounded transcript", async () => {
    const scripted = scriptedConnection({
      children: [child({ activeSessionId: "sess_child_1" })],
      attachAnswers: {
        sess_child_1: {
          command: "attach",
          success: true,
          data: {
            snapshot: {
              messages: [
                { role: "user", content: "scout" },
                { role: "assistant", content: [{ type: "text", text: "all clear" }] },
              ],
            },
          },
        },
      },
    });
    // The parent attach seeds the roster; the child's attach (keyed by the
    // child's own session) carries the transcript — mirroring how the daemon
    // splits resident rosters from a subagent snapshot's messages.
    const harness = createHostEntryHarness(
      createPrimeSubagentsHostEntry({ createConnection: () => scripted.connection }),
    );
    await expect(
      harness.experimental_call("subagents.transcript", {
        activeSessionId: "sess_parent",
        childId: "child_1",
      }),
    ).resolves.toEqual({
      state: "ready",
      entries: [
        { kind: "user", text: "scout" },
        { kind: "assistant", text: "all clear" },
      ],
      truncated: false,
    });
    // The second command on the wire is the child attach — the parent attach
    // only seeded the roster, the transcript attach names the child's session.
    expect(scripted.commands[1]).toMatchObject({
      type: "attach",
      activeSessionId: "sess_child_1",
    });
    await harness.experimental_dispose();
  });

  it("answers no_session for a child that has not booted, without attaching", async () => {
    const scripted = scriptedConnection({
      children: [child({ id: "child_1", status: "queued" })],
    });
    const harness = createHostEntryHarness(
      createPrimeSubagentsHostEntry({ createConnection: () => scripted.connection }),
    );
    await expect(
      harness.experimental_call("subagents.transcript", {
        activeSessionId: "sess_parent",
        childId: "child_1",
      }),
    ).resolves.toEqual({ state: "no_session", entries: [], truncated: false });
    const attaches = scripted.commands.filter((command) => command.type === "attach");
    expect(attaches).toHaveLength(1); // the roster's parent attach only
    await harness.experimental_dispose();
  });

  it("refuses a child this session does not have", async () => {
    const scripted = scriptedConnection({ children: [child()] });
    const harness = createHostEntryHarness(
      createPrimeSubagentsHostEntry({ createConnection: () => scripted.connection }),
    );
    await expect(
      harness.experimental_call("subagents.transcript", {
        activeSessionId: "sess_parent",
        childId: "child_other",
      }),
    ).rejects.toThrow(/no subagent "child_other"/);
    await harness.experimental_dispose();
  });
});

import {
  experimental_createHostEntryHarness as createHostEntryHarness,
} from "@get-bb/plugin-sdk/testing/host";
import { describe, expect, it } from "vitest";
import type { DaemonCommandResult } from "../daemon/client.js";
import type { DaemonPushMessage } from "../daemon/protocol.js";
import type { SubagentsBackendConnection } from "./backend-connection.js";
import { createPrimeSubagentsHostEntry } from "./host-entry.js";

/**
 * The host entry behind the Subagents panel, in-process: the SDK's host-entry
 * harness gives the same validation, signal and retention boundaries the
 * daemon worker applies, over a scripted daemon connection.
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

function scriptedConnection(args: { children?: unknown[] } = {}): ScriptedConnectionHandle {
  const commands: Array<Record<string, unknown>> = [];
  const listeners = new Set<(message: DaemonPushMessage) => void>();
  const connection: SubagentsBackendConnection = {
    describe: "scripted prime-agent daemon",
    async request(command) {
      commands.push(command);
      const answer: DaemonCommandResult =
        command.type === "attach"
          ? {
              command: "attach",
              success: true,
              data: { snapshot: { children: args.children ?? [] } },
            }
          : { command: String(command.type), success: true };
      return answer;
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

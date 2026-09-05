import { describe, expect, it, vi } from "vitest";
import type { DaemonCommandResult } from "../daemon/client.js";
import type { DaemonPushMessage } from "../daemon/protocol.js";
import type { SubagentsRosterSeams } from "./roster.js";
import { SubagentsRoster, type RosterChange } from "./roster.js";

/**
 * The backend roster, against a scripted daemon.
 *
 * This is the part that must not double-attach: one `attach` per session per
 * backend process, seeded by the snapshot's `children`, kept live by
 * `rlm_child_update` pushes, and given up on a sweep (or a close) so panels
 * that came and went do not leave attaches behind.
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

function pushMessage(activeSessionId: string, event: unknown): DaemonPushMessage {
  return {
    type: "session_event",
    activeSessionId,
    event,
    meta: { sequence: 1, cursor: { generation: "gen-0", sequence: 1 } },
  } as unknown as DaemonPushMessage;
}

interface ScriptedBackend {
  /** Every command the roster sent, in order. */
  readonly commands: Array<Record<string, unknown>>;
  push(message: DaemonPushMessage): void;
  /** The connection came back up. */
  reconnect(): void;
  /** Make the next attach answer a daemon-side refusal. */
  failNextAttach(reason: string): void;
}

function scriptedBackend(
  args: { children?: unknown[] } = {},
): { backend: ScriptedBackend; seams: SubagentsRosterSeams } {
  const commands: Array<Record<string, unknown>> = [];
  const listeners = new Set<(message: DaemonPushMessage) => void>();
  const reconnectListeners = new Set<() => void>();
  let attachFailure: string | undefined;
  function answerFor(command: Record<string, unknown>): DaemonCommandResult {
    if (command.type === "attach") {
      if (attachFailure !== undefined) {
        return { command: "attach", success: false, error: attachFailure };
      }
      return {
        command: "attach",
        success: true,
        data: { snapshot: { children: args.children ?? [] } },
      };
    }
    return { command: String(command.type), success: true };
  }
  const backend: ScriptedBackend = {
    commands,
    push(message) {
      for (const listener of listeners) {
        listener(message);
      }
    },
    reconnect() {
      for (const listener of [...reconnectListeners]) {
        listener();
      }
    },
    failNextAttach(reason) {
      attachFailure = reason;
    },
  };
  const seams: SubagentsRosterSeams = {
    async request(command) {
      commands.push(command);
      return answerFor(command);
    },
    subscribePush(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onReconnect(listener) {
      reconnectListeners.add(listener);
      return () => {
        reconnectListeners.delete(listener);
      };
    },
  };
  return { backend, seams };
}

function makeRoster(
  seams: SubagentsRosterSeams,
  args: { interestTtlMs?: number } = {},
): SubagentsRoster {
  // The sweep timer is not under test (it would need fake timers to be
  // anything but noise); `sweepIdle` is driven directly instead.
  return new SubagentsRoster(seams, { sweepIntervalMs: 0, ...args });
}

describe("the subagents roster", () => {
  it("attaches once per session and seeds from the snapshot's children", async () => {
    const { backend, seams } = scriptedBackend({
      children: [child(), child({ id: "child_2", status: "done" })],
    });
    const roster = makeRoster(seams);

    const first = await roster.watch("sess_parent");
    expect(first.map((entry) => entry.id)).toEqual(["child_1", "child_2"]);
    expect(backend.commands).toEqual([
      {
        type: "attach",
        activeSessionId: "sess_parent",
        capabilities: expect.any(Array),
      },
    ]);

    // A second panel question is answered from the roster, not the wire.
    await roster.watch("sess_parent");
    expect(backend.commands).toHaveLength(1);
    await roster.dispose();
  });

  it("applies rlm_child_update pushes for watched sessions only", async () => {
    const { backend, seams } = scriptedBackend({ children: [] });
    const roster = makeRoster(seams);
    const changes: RosterChange[] = [];
    roster.onChange((change) => changes.push(change));
    await roster.watch("sess_parent");

    backend.push(
      pushMessage("sess_parent", {
        type: "rlm_child_update",
        child: child({ status: "done", tokenCount: 100 }),
      }),
    );
    // A session this backend never watched is none of its business.
    backend.push(
      pushMessage("sess_other", {
        type: "rlm_child_update",
        child: child({ id: "child_9" }),
      }),
    );

    expect(roster.childrenOf("sess_parent")).toHaveLength(1);
    expect(roster.childrenOf("sess_parent")[0]).toMatchObject({
      id: "child_1",
      status: "done",
      tokenCount: 100,
    });
    expect(roster.childrenOf("sess_other")).toEqual([]);
    // One change for the attach's seed, one for the update.
    expect(changes.map((change) => change.activeSessionId)).toEqual([
      "sess_parent",
      "sess_parent",
    ]);
    expect(changes[1].children[0]).toMatchObject({ id: "child_1", status: "done" });
    await roster.dispose();
  });

  it("gives a session up when the daemon closes it or sweeps it idle", async () => {
    const { backend, seams } = scriptedBackend({ children: [child()] });
    const roster = makeRoster(seams, { interestTtlMs: 10 * 60_000 });
    await roster.watch("sess_parent");

    backend.push({
      type: "session_closed",
      activeSessionId: "sess_parent",
      reason: "killed",
    } as unknown as DaemonPushMessage);
    expect(roster.watched()).toEqual([]);

    // The sweep detaches on the wire as well: an attached client must not be
    // left behind on a session nobody asks about.
    await roster.watch("sess_parent");
    const swept = await roster.sweepIdle(Date.now() + 11 * 60_000);
    expect(swept).toEqual(["sess_parent"]);
    expect(roster.watched()).toEqual([]);
    expect(backend.commands.at(-1)).toMatchObject({
      type: "detach",
      activeSessionId: "sess_parent",
    });
    await roster.dispose();
  });

  it("keeps a session the sweep has not outlived", async () => {
    const { backend, seams } = scriptedBackend({ children: [] });
    const roster = makeRoster(seams, { interestTtlMs: 10 * 60_000 });
    await roster.watch("sess_parent");
    // Watching refreshed the interest stamp moments ago; a sweep shortly
    // after keeps the session.
    await roster.sweepIdle(Date.now() + 60_000);
    expect(roster.watched()).toEqual(["sess_parent"]);
    expect(backend.commands).toHaveLength(1);
    await roster.dispose();
  });

  it("re-attaches every watched session after the connection comes back", async () => {
    const { backend, seams } = scriptedBackend({ children: [child()] });
    const roster = makeRoster(seams);
    await roster.watch("sess_parent");
    expect(backend.commands).toHaveLength(1);

    backend.reconnect();
    await vi.waitFor(() => expect(backend.commands).toHaveLength(2));
    expect(backend.commands.at(-1)).toMatchObject({ type: "attach" });
    // The roster survived the reconnect, reseeded from the fresh attach.
    expect(roster.childrenOf("sess_parent")).toHaveLength(1);
    await roster.dispose();
  });

  it("drops a session whose re-attach fails after a reconnect", async () => {
    const { backend, seams } = scriptedBackend({ children: [child()] });
    const roster = makeRoster(seams);
    await roster.watch("sess_parent");
    backend.failNextAttach("no such session");
    backend.reconnect();
    await vi.waitFor(() => expect(roster.watched()).toEqual([]));
    await roster.dispose();
  });

  it("refuses an unknown session legibly instead of answering an empty roster", async () => {
    const { seams } = scriptedBackend();
    const roster = makeRoster(seams);
    scriptedRefuseAttach(seams);
    await expect(roster.watch("sess_missing")).rejects.toThrow(/sess_missing/);
    await roster.dispose();
  });

  it("detaches everything on dispose and stops listening", async () => {
    const { backend, seams } = scriptedBackend({ children: [child()] });
    const roster = makeRoster(seams);
    await roster.watch("sess_parent");
    await roster.dispose();
    expect(backend.commands.at(-1)).toMatchObject({ type: "detach" });
    await expect(roster.watch("sess_parent")).rejects.toThrow(/disposed/);
  });
});

/**
 * Makes the scripted daemon refuse the next attach — the "session unknown"
 * answer a daemon gives after it lost the session.
 */
function scriptedRefuseAttach(seams: SubagentsRosterSeams): void {
  const failing: SubagentsRosterSeams = {
    ...seams,
    async request(command) {
      if (command.type === "attach") {
        return { command: "attach", success: false, error: "no such session" };
      }
      return { command: String(command.type), success: true };
    },
  };
  Object.assign(seams, failing);
}

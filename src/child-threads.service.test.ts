import { describe, expect, it, vi } from "vitest";
import { createChildThreadService, type ChildThreadServiceDeps } from "./child-threads.js";
import type { PrimeChild } from "./subagents/children.js";

/**
 * The server half of child threads (bbpa-b1m.11): the `subagents.changed`
 * signal names a parent session and its children; for every live child with
 * its own daemon session the service mints one bb thread — once. The watch
 * sweep keeps parents watched so spawns are seen with no panel open.
 */

function child(overrides: Partial<PrimeChild> = {}): PrimeChild {
  return {
    id: "child_1",
    label: "researcher",
    status: "running",
    ...overrides,
  };
}

function deps(overrides: Partial<ChildThreadServiceDeps> = {}): ChildThreadServiceDeps & {
  spawned: Array<{ title: string; childSessionId: string; parentThreadId: string }>;
  watched: string[];
} {
  const spawned: Array<{ title: string; childSessionId: string; parentThreadId: string }> = [];
  const watched: string[] = [];
  const base: ChildThreadServiceDeps = {
    log: { info: () => {}, warn: () => {} },
    resolveParentThreadId: async () => "thr_parent",
    resolveThreadSession: async () => undefined,
    getParentThread: async () => ({ projectId: "proj_1", environmentId: "env_1" }),
    findExistingChildThread: async () => false,
    spawnChildThread: async (args) => {
      spawned.push({
        title: args.title,
        childSessionId: args.childSessionId,
        parentThreadId: args.parentThreadId,
      });
    },
    watchSession: async (sessionId) => {
      watched.push(sessionId);
    },
    listRecentPrimeThreadIds: async () => [],
  };
  return { ...base, ...overrides, spawned, watched };
}

describe("child thread service", () => {
  it("spawns one thread for a live child that has its own session", async () => {
    const d = deps();
    const service = createChildThreadService(d);
    await service.onChildren("sess_parent", [child({ activeSessionId: "sess_kid" })]);

    expect(d.spawned).toEqual([
      { title: "researcher", childSessionId: "sess_kid", parentThreadId: "thr_parent" },
    ]);
  });

  it("flattens a prime task-text label into a one-line capped title", async () => {
    const d = deps();
    const service = createChildThreadService(d);
    await service.onChildren("sess_parent", [
      child({
        activeSessionId: "sess_kid",
        label: "You are the SPEC reviewer for a code change in the git repo at /x — run git diff, then report",
      }),
    ]);
    // Prime labels unnamed children with their whole task text; the title is
    // one line, capped, and points at the task rather than dumping it.
    expect(d.spawned[0]?.title).toBe(
      "You are the SPEC reviewer for a code change in the git repo at …",
    );
  });

  it("prefers the child's prime session name over the task-text label", async () => {
    const d = deps();
    const service = createChildThreadService(d);
    await service.onChildren("sess_parent", [
      child({
        activeSessionId: "sess_kid",
        sessionName: "impl-7c4-1",
        label: "You are an implementer agent for ticket bb-sys-prompt-7c4.1",
      }),
    ]);
    expect(d.spawned[0]?.title).toBe("impl-7c4-1");
  });

  it("never spawns twice for the same child session", async () => {
    const d = deps();
    const service = createChildThreadService(d);
    const kids = [child({ activeSessionId: "sess_kid" })];
    await service.onChildren("sess_parent", kids);
    await service.onChildren("sess_parent", kids);
    expect(d.spawned).toHaveLength(1);
  });

  it("skips children without their own session and finished ones", async () => {
    const d = deps();
    const service = createChildThreadService(d);
    await service.onChildren("sess_parent", [
      child({ id: "c1", label: "unbooted" }),
      child({ id: "c2", label: "done", status: "done", activeSessionId: "sess_done" }),
    ]);
    expect(d.spawned).toEqual([]);
  });

  it("skips when a thread for this child already exists (server restart)", async () => {
    const d = deps({ findExistingChildThread: async () => true });
    const service = createChildThreadService(d);
    await service.onChildren("sess_parent", [child({ activeSessionId: "sess_kid" })]);
    expect(d.spawned).toEqual([]);
  });

  it("skips silently when the parent thread cannot be resolved", async () => {
    const d = deps({ resolveParentThreadId: async () => undefined });
    const service = createChildThreadService(d);
    await service.onChildren("sess_parent", [child({ activeSessionId: "sess_kid" })]);
    expect(d.spawned).toEqual([]);
  });

  it("retries the next signal after a failed spawn", async () => {
    let fail = true;
    const d = deps({
      spawnChildThread: async (args) => {
        if (fail) {
          throw new Error("spawn failed");
        }
        d.spawned.push({
          title: args.title,
          childSessionId: args.childSessionId,
          parentThreadId: args.parentThreadId,
        });
      },
    });
    const service = createChildThreadService(d);
    const kids = [child({ activeSessionId: "sess_kid" })];
    await service.onChildren("sess_parent", kids);
    expect(d.spawned).toEqual([]);
    fail = false;
    await service.onChildren("sess_parent", kids);
    expect(d.spawned).toHaveLength(1);
  });

  it("watches the sessions of recent prime threads on the sweep", async () => {
    const d = deps({
      listRecentPrimeThreadIds: async () => ["thr_a", "thr_b"],
      resolveThreadSession: async (threadId) =>
        threadId === "thr_a" ? "sess_a" : undefined,
    });
    const service = createChildThreadService(d);
    await service.watchRecentThreads();
    expect(d.watched).toEqual(["sess_a"]);
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PrimeDaemonClient } from "../daemon/client.js";
import { resolveDaemonSocketPath } from "../daemon/socket.js";
import { createSubagentsBackendConnection } from "./backend-connection.js";
import { SubagentsRoster } from "./roster.js";

/**
 * The live Subagents lane, gated behind `BBPA_LIVE_DAEMON=1`.
 *
 * Spawned subagents are a live-turn expense, so this lane does NOT spawn one —
 * the first live subagent spawn is exercised by bbpa-ggf.14's smoke. What it
 * does prove against the real daemon is the read-only half the panel rests on:
 * the backend's own connection attaches to a session it did not create the
 * turn for, the roster answers empty for a childless session, and the detach
 * on dispose leaves the daemon exactly as it found it. Cleanup removes exactly
 * the throwaway session this test created (`kill` + `delete_saved_session`),
 * from an ops client with a fresh clientId per connection.
 */

const LIVE = process.env.BBPA_LIVE_DAEMON === "1";

describe("the subagents roster against the real daemon", () => {
  let cleanupSession:
    | { activeSessionId: string; sessionFile?: string; name: string }
    | undefined;
  const workspaceDir = LIVE ? mkdtempSync(join(tmpdir(), "bb-prime-roster-")) : "";

  afterEach(async () => {
    if (!LIVE) {
      return;
    }
    const stale = cleanupSession;
    if (stale !== undefined) {
      cleanupSession = undefined;
      try {
        await withTestClient(async (client) => {
          await client.request({ type: "kill", activeSessionId: stale.activeSessionId });
          if (stale.sessionFile !== undefined) {
            await client.request({
              type: "delete_saved_session",
              sessionPath: stale.sessionFile,
            });
          }
        });
      } catch {
        // A daemon that disappeared already took the resident session with it.
      }
    }
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("attaches read-only and answers an empty roster for a childless session", async () => {
    if (!LIVE) {
      return;
    }
    const name = `bbpa-roster-test-${Math.random().toString(36).slice(2, 8)}`;
    await withTestClient(async (client) => {
      const created = await client.request({
        type: "create",
        name: `[bb] ${name}`,
        cwd: workspaceDir,
        lifecycle: "resident",
      });
      const activeSessionId = (created.data as { activeSessionId?: string })
        ?.activeSessionId;
      const sessionFile = (created.data as { sessionFile?: string })?.sessionFile;
      expect(activeSessionId, "the daemon answered create").toBeTypeOf("string");
      cleanupSession = { activeSessionId: activeSessionId!, sessionFile, name };
    });

    const connection = createSubagentsBackendConnection();
    const roster = new SubagentsRoster({
      request: (command, args) => connection.request(command, args),
      subscribePush: (listener) => connection.subscribePush(listener),
      onReconnect: (listener) => connection.onReconnect(listener),
    });
    try {
      const children = await roster.watch(cleanupSession!.activeSessionId!);
      expect(children).toEqual([]);
      expect(roster.watched()).toEqual([cleanupSession!.activeSessionId]);

      // A second question is answered from the roster, not a second attach.
      expect(await roster.watch(cleanupSession!.activeSessionId!)).toEqual([]);
      expect(connection.describe).toContain(resolveDaemonSocketPath());
    } finally {
      await roster.dispose();
      connection.dispose();
    }
  });
});

async function withTestClient(
  run: (client: PrimeDaemonClient) => Promise<void>,
): Promise<void> {
  // A fresh clientId per connection: the daemon journals mutating commands by
  // (clientId, envelope id) and replays a recorded response on a repeat, so a
  // fixed id could turn this run's cleanup into a previous run's answer.
  const client = new PrimeDaemonClient({
    socketPath: resolveDaemonSocketPath(),
    clientId: `bbpa-roster-test-${Math.random().toString(36).slice(2, 10)}`,
  });
  try {
    await client.connect();
    await run(client);
  } finally {
    client.close();
  }
}

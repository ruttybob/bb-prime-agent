import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  experimental_createHostEntryHarness as createHostEntryHarness,
} from "@get-bb/plugin-sdk/testing/host";
import { afterEach, describe, expect, it } from "vitest";
import { PrimeDaemonClient } from "../daemon/client.js";
import { resolveDaemonSocketPath } from "../daemon/socket.js";
import { createSubagentsBackendConnection } from "./backend-connection.js";
import type { SubagentsBackendConnection } from "./backend-connection.js";
import { createPrimeSubagentsHostEntry } from "./host-entry.js";

/**
 * Subagent control against the real daemon, gated behind `BBPA_LIVE_DAEMON=1`.
 *
 * What this lane proves live is the cheap half of bbpa-ggf.10: this machine's
 * daemon *admits* both control commands (a drifted prime could have gated
 * either of them off), `cancel_rlm_child` answers the `{cancelled}` shape the
 * panel's honesty rests on, and a steer or stop aimed at a child the session
 * does not have is refused here before a single control command is sent. It
 * does NOT spawn a subagent — a live child is a live-turn expense, and the
 * steer-into-a-real-child / cancel-a-real-child round trip is bbpa-ggf.14's
 * smoke. Cleanup removes exactly the throwaway session this test created
 * (`kill` + `delete_saved_session`), from an ops client with a fresh clientId
 * per connection.
 */

const LIVE = process.env.BBPA_LIVE_DAEMON === "1";

describe("subagent control against the real daemon", () => {
  let cleanupSession:
    | { activeSessionId: string; sessionFile?: string }
    | undefined;
  const workspaceDir = LIVE ? mkdtempSync(join(tmpdir(), "bb-prime-control-")) : "";

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

  it("admits the control commands and refuses actions on children it does not have", async () => {
    if (!LIVE) {
      return;
    }
    const name = `bbpa-control-test-${Math.random().toString(36).slice(2, 8)}`;
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
      cleanupSession = { activeSessionId: activeSessionId!, sessionFile };
    });
    const session = cleanupSession!.activeSessionId!;

    // The panel's own road in: the host entry, over this machine's connection.
    // The recorded wrapper is how the lane asserts what was (not) sent.
    const sent: Array<Record<string, unknown>> = [];
    const upstream = createSubagentsBackendConnection();
    const connection: SubagentsBackendConnection = new Proxy(upstream, {
      get(target, property, receiver) {
        if (property === "request") {
          return (
            command: { type: string } & Record<string, unknown>,
            args?: { timeoutMs?: number },
          ) => {
            sent.push(command);
            return target.request(command, args);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const harness = createHostEntryHarness(
      createPrimeSubagentsHostEntry({ createConnection: () => connection }),
    );
    try {
      // The attach is also the readiness gate: the session is registered
      // before anything below probes it.
      await harness.experimental_call("subagents.roster", { activeSessionId: session });

      // A steer of a child the roster does not name is refused in the host,
      // so prime never sees a send_message and never gets a chance to wake
      // anything; equally, nothing that deletes a ledger row can be spelled.
      await expect(
        harness.experimental_call("subagents.steer", {
          activeSessionId: session,
          childId: "child_absent",
          message: "anyone there?",
        }),
      ).rejects.toThrow(/no subagent "child_absent"/u);
      await expect(
        harness.experimental_call("subagents.stop", {
          activeSessionId: session,
          childId: "child_absent",
        }),
      ).rejects.toThrow(/no subagent "child_absent"/u);
      // Whatever the daemon's own resyncing did in between, nothing control-
      // shaped crossed the wire: no steer, no cancel, and no delete.
      expect(sent.every((command) => command.type === "attach")).toBe(true);
      expect(sent.some((command) => command.type === "delete_rlm_subagent")).toBe(false);

      // The daemon itself, on the real wire: `cancel_rlm_child` is admitted
      // and answers the `{cancelled}` shape — false for a child that does not
      // exist, which is exactly the answer the panel must not report as a stop.
      await withTestClient(async (client) => {
        const cancelled = await client.request({
          type: "cancel_rlm_child",
          activeSessionId: session,
          childId: "child_absent",
        });
        expect(cancelled.success).toBe(true);
        expect(cancelled.data).toEqual({ cancelled: false });

        // And `send_message` is admitted too: prime refuses a session
        // targeting itself, which proves the command ran to its own semantics.
        const selfTargeted = await client.request({
          type: "send_message",
          targetActiveSessionId: session,
          message: "bbpa-ggf.10 wire probe",
          fromActiveSessionId: session,
        });
        expect(selfTargeted.success).toBe(false);
        expect(selfTargeted.error ?? "").toMatch(/target the sending session|Unknown active session/u);
      });
    } finally {
      await harness.experimental_dispose();
      upstream.dispose();
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
    clientId: `bbpa-control-test-${Math.random().toString(36).slice(2, 10)}`,
  });
  try {
    await client.connect();
    await run(client);
  } finally {
    client.close();
  }
}

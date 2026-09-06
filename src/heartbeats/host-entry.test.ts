import {
  experimental_createHostEntryHarness as createHostEntryHarness,
} from "@get-bb/plugin-sdk/testing/host";
import { describe, expect, it, vi } from "vitest";
import type { DaemonCommandResult } from "../daemon/client.js";
import type { DaemonPushMessage } from "../daemon/protocol.js";
import type { SubagentsBackendConnection } from "../subagents/backend-connection.js";
import { createPrimeHeartbeatsHostEntry } from "./host-entry.js";

/**
 * The host entry behind the Heartbeats panel, in-process (bbpa-b1m.3,
 * schedules bbpa-b1m.4): the SDK's host-entry harness gives the same
 * validation, signal and retention boundaries the daemon worker applies,
 * over a scripted daemon connection. The command shapes are pinned to what
 * the probes against prime 0.7.3 answered.
 */

function heartbeatJob(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "hb_1",
    status: "active",
    source: "heartbeat",
    deliveryMode: "steer",
    prompt: "probe heartbeat",
    schedule: { kind: "interval", expression: "every 5m", intervalMs: 300000 },
    nextRunAt: "2026-09-06T10:48:30.636Z",
    runCount: 0,
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
    answers?: Record<string, DaemonCommandResult>;
  } = {},
): ScriptedConnectionHandle {
  const commands: Array<Record<string, unknown>> = [];
  const listeners = new Set<(message: DaemonPushMessage) => void>();
  const connection: SubagentsBackendConnection = {
    describe: "scripted prime-agent daemon",
    async request(command) {
      commands.push(command);
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
    onReconnect() {
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

const vi_waitFor = vi.waitFor;

describe("the prime heartbeats host entry", () => {
  it("answers a list question with the session's heartbeats and schedules", async () => {
    const scripted = scriptedConnection({
      answers: {
        heartbeats_list: {
          command: "heartbeats_list",
          success: true,
          data: {
            heartbeats: [
              {
                job: heartbeatJob(),
                sessionName: "[bb] scripted thread",
              },
              {
                job: heartbeatJob({ id: "hb_2", source: "rlm_heartbeat" }),
              },
            ],
          },
        },
        cron_list: {
          command: "cron_list",
          success: true,
          data: {
            jobs: [
              heartbeatJob({
                id: "cron_1",
                source: "cron",
                deliveryMode: undefined,
                prompt: "probe cron",
                schedule: { kind: "interval", expression: "every 10m" },
              }),
              // A heartbeat-sourced job on the cron list is NOT a schedule.
              heartbeatJob({ id: "hb_1" }),
            ],
          },
        },
      },
    });
    const harness = createHostEntryHarness(
      createPrimeHeartbeatsHostEntry({ createConnection: () => scripted.connection }),
    );

    const answer = await harness.experimental_call("heartbeats.list", {
      activeSessionId: "sess_1",
    });
    expect(answer.heartbeats.map((entry: { id: string }) => entry.id)).toEqual([
      "hb_1",
      "hb_2",
    ]);
    expect(answer.schedules.map((entry: { id: string }) => entry.id)).toEqual([
      "cron_1",
    ]);
    expect(scripted.commands).toEqual([
      { type: "heartbeats_list", activeSessionId: "sess_1" },
      { type: "cron_list", activeSessionId: "sess_1" },
    ]);
  });

  it("sends heartbeat_set with the delivery mode the panel chose", async () => {
    const scripted = scriptedConnection({
      answers: {
        heartbeat_set: {
          command: "heartbeat_set",
          success: true,
          data: { heartbeat: heartbeatJob({ deliveryMode: "follow_up" }) },
        },
      },
    });
    const harness = createHostEntryHarness(
      createPrimeHeartbeatsHostEntry({ createConnection: () => scripted.connection }),
    );

    const answer = await harness.experimental_call("heartbeats.set", {
      activeSessionId: "sess_1",
      schedule: "every 5m",
      prompt: "check the build",
      deliveryMode: "follow_up",
    });
    expect(answer.heartbeat).toMatchObject({ id: "hb_1", deliveryMode: "follow_up" });
    expect(scripted.commands[0]).toEqual({
      type: "heartbeat_set",
      activeSessionId: "sess_1",
      schedule: "every 5m",
      prompt: "check the build",
      deliveryMode: "follow_up",
    });
  });

  it("maps pause/resume/stop onto heartbeat_manage by job id", async () => {
    const scripted = scriptedConnection({
      answers: {
        heartbeat_manage: {
          command: "heartbeat_manage",
          success: true,
          data: { heartbeat: heartbeatJob({ status: "paused" }) },
        },
      },
    });
    const harness = createHostEntryHarness(
      createPrimeHeartbeatsHostEntry({ createConnection: () => scripted.connection }),
    );

    const answer = await harness.experimental_call("heartbeats.manage", {
      activeSessionId: "sess_1",
      jobId: "hb_1",
      action: "pause",
    });
    expect(answer.heartbeat).toMatchObject({ status: "paused" });
    expect(scripted.commands[0]).toEqual({
      type: "heartbeat_manage",
      activeSessionId: "sess_1",
      jobId: "hb_1",
      action: "pause",
    });
  });

  it("refuses a daemon refusal with its error, never a quiet success", async () => {
    const scripted = scriptedConnection({
      answers: {
        heartbeat_manage: {
          command: "heartbeat_manage",
          success: false,
          error: "no such job",
        },
      },
    });
    const harness = createHostEntryHarness(
      createPrimeHeartbeatsHostEntry({ createConnection: () => scripted.connection }),
    );

    await expect(
      harness.experimental_call("heartbeats.manage", {
        activeSessionId: "sess_1",
        jobId: "hb_missing",
        action: "stop",
      }),
    ).rejects.toThrow(/prime-agent refused heartbeat stop: no such job/);
  });

  it("adds and cancels prime-side schedules over cron_add/cron_cancel", async () => {
    const scripted = scriptedConnection({
      answers: {
        cron_add: {
          command: "cron_add",
          success: true,
          data: {
            job: heartbeatJob({ id: "cron_1", source: "cron", prompt: "run the sweep" }),
          },
        },
        cron_cancel: {
          command: "cron_cancel",
          success: true,
          data: {
            job: heartbeatJob({ id: "cron_1", source: "cron", status: "cancelled" }),
          },
        },
      },
    });
    const harness = createHostEntryHarness(
      createPrimeHeartbeatsHostEntry({ createConnection: () => scripted.connection }),
    );

    const added = await harness.experimental_call("heartbeats.scheduleAdd", {
      activeSessionId: "sess_1",
      schedule: "every 10m",
      prompt: "run the sweep",
    });
    expect(added.job).toMatchObject({ id: "cron_1", source: "cron" });
    expect(scripted.commands[0]).toEqual({
      type: "cron_add",
      activeSessionId: "sess_1",
      schedule: "every 10m",
      prompt: "run the sweep",
    });

    await harness.experimental_call("heartbeats.scheduleCancel", {
      activeSessionId: "sess_1",
      jobId: "cron_1",
    });
    expect(scripted.commands[1]).toEqual({
      type: "cron_cancel",
      activeSessionId: "sess_1",
      jobId: "cron_1",
    });
  });

  it("republishes prime's global heartbeats_changed push as a host signal", async () => {
    const scripted = scriptedConnection();
    const harness = createHostEntryHarness(
      createPrimeHeartbeatsHostEntry({ createConnection: () => scripted.connection }),
    );
    await harness.experimental_call("heartbeats.list", { activeSessionId: "sess_1" });

    scripted.push({ type: "heartbeats_changed" } as DaemonPushMessage);
    // The push travels out of band (connection → signal), so it settles a
    // tick later than the question.
    await vi_waitFor(() => {
      const signals = harness.experimental_getSignals();
      expect(signals.at(-1)).toMatchObject({
        signal: "heartbeats.changed",
        payload: { at: expect.any(Number) },
      });
    });
    await harness.experimental_dispose();
  });
});

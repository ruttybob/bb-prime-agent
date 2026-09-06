import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import type { ExperimentalHostRpcContext } from "@get-bb/plugin-sdk";
import {
  primeHeartbeatsHostContract,
  primeHeartbeatsHostSignals,
  type HeartbeatsListHostResult,
} from "./contract.js";
import {
  cronAddCommand,
  cronCancelCommand,
  cronListCommand,
  heartbeatManageCommand,
  heartbeatSetCommand,
  heartbeatsListCommand,
  parseHeartbeatEntries,
  parseHeartbeatJob,
  parseCronJob,
  parseScheduleJobs,
} from "./wire.js";
import {
  createSubagentsBackendConnection,
  type SubagentsBackendConnection,
} from "../subagents/backend-connection.js";

/**
 * The `bb.host` entry's Heartbeats half (bbpa-b1m.3, schedules bbpa-b1m.4):
 * one per-machine daemon client shared with the Subagents half, the reads and
 * actions the panel's server half fans out to, and the `heartbeats_changed`
 * push republished as a host signal so open panels can refetch.
 *
 * The connection arrives through `createConnection` — host.ts hands both
 * panel halves one memoized connection, because a second socket per worker
 * would be two clients doing one client's job. (The connection's `dispose`
 * is idempotent; whichever half tears down first wins, the other's dispose
 * is a no-op.)
 *
 * prime's `heartbeats_changed` push is global — no session id, no payload
 * (wire fact, probe 2026-09-06) — so the signal carries only a timestamp and
 * every open panel refetches its own session. The watches that keep the
 * worker (and the pushes) alive expire on a TTL: a panel that stopped asking
 * stops keeping the daemon client warm, and the next question re-registers.
 */

const WATCH_TTL_MS = 5 * 60_000;

export interface PrimeHeartbeatsHostEntryArgs {
  /** Test seam and the shared-connection seam: hand the entry its client. */
  createConnection?: () => SubagentsBackendConnection;
}

export function createPrimeHeartbeatsHostEntry(
  args: PrimeHeartbeatsHostEntryArgs = {},
) {
  let built: SubagentsBackendConnection | undefined;
  /** The worker-retention lease, held while any session's watches are fresh. */
  let lease: ReturnType<ExperimentalHostRpcContext<typeof primeHeartbeatsHostSignals>["experimental_retainWorker"]> | undefined;
  let retain:
    | (() => ReturnType<ExperimentalHostRpcContext<typeof primeHeartbeatsHostSignals>["experimental_retainWorker"]>)
    | undefined;
  let emit:
    | ((
        signal: keyof typeof primeHeartbeatsHostSignals,
        payload: { at: number },
      ) => Promise<void>)
    | undefined;
  /** sessionId → the moment it was last asked about. */
  const watched = new Map<string, number>();
  let sweeper: ReturnType<typeof setInterval> | undefined;

  function connectionFor(): SubagentsBackendConnection {
    if (built === undefined) {
      const connection = args.createConnection?.() ?? createSubagentsBackendConnection();
      // The global change push → host signal. The connection may be shared
      // with the Subagents half; subscribing twice is fine, this listener is
      // the only one that knows this signal's name.
      connection.subscribePush((push) => {
        if ((push as { type?: string }).type !== "heartbeats_changed") {
          return;
        }
        if (emit === undefined) {
          return;
        }
        emit("heartbeats.changed", { at: Date.now() }).catch(() => {});
      });
      built = connection;
    }
    return built;
  }

  function syncLease(): void {
    if (watched.size > 0) {
      lease ??= retain?.();
    } else {
      lease?.dispose();
      lease = undefined;
    }
  }

  function ensureSweeper(): void {
    sweeper ??= setInterval(() => {
      const now = Date.now();
      for (const [sessionId, touchedAt] of watched) {
        if (now - touchedAt > WATCH_TTL_MS) {
          watched.delete(sessionId);
        }
      }
      syncLease();
    }, 60_000);
    // A host worker must not be kept alive by the sweeper alone.
    sweeper.unref?.();
  }

  function touch(activeSessionId: string, context: ExperimentalHostRpcContext<typeof primeHeartbeatsHostSignals>): SubagentsBackendConnection {
    const connection = connectionFor();
    retain ??= () => context.experimental_retainWorker();
    emit ??= (signal, payload) => context.experimental_emitSignal(signal, payload);
    watched.set(activeSessionId, Date.now());
    ensureSweeper();
    syncLease();
    return connection;
  }

  /** The daemon answered, or the caller hears why not — never silence. */
  function assertSuccess(
    answer: { success: boolean; error?: string; data?: unknown },
    what: string,
  ): unknown {
    if (!answer.success) {
      throw new Error(`prime-agent refused ${what}: ${answer.error ?? "unknown daemon error"}`);
    }
    return answer.data;
  }

  /**
   * The shape every mutating handler shares: send the command, demand the
   * daemon's success, parse the job out of the answer — a refusal or a
   * malformed answer is an error naming the action, never a quiet success.
   */
  async function mutateAndParse<Output>(
    context: ExperimentalHostRpcContext<typeof primeHeartbeatsHostSignals>,
    activeSessionId: string,
    command: { type: string } & Record<string, unknown>,
    what: string,
    parse: (data: unknown) => Output | undefined,
    missing: string,
  ): Promise<Output> {
    const connection = touch(activeSessionId, context);
    const answer = await connection.request(command);
    const parsed = parse(assertSuccess(answer, what));
    if (parsed === undefined) {
      throw new Error(missing);
    }
    return parsed;
  }

  return experimental_defineHostEntry({
    contract: primeHeartbeatsHostContract,
    experimental_signals: primeHeartbeatsHostSignals,
    handlers: {
      "heartbeats.list": async (input, context): Promise<HeartbeatsListHostResult> => {
        const connection = touch(input.activeSessionId, context);
        const [heartbeatsAnswer, cronAnswer] = await Promise.all([
          connection.request(heartbeatsListCommand({ activeSessionId: input.activeSessionId })),
          connection.request(cronListCommand({ activeSessionId: input.activeSessionId })),
        ]);
        // A refusal fails the read — the panel shows it (an old daemon
        // without the catalog capability refuses client-side with a legible
        // error); a malformed answer degrades to empty lists, costing rows
        // rather than the panel.
        assertSuccess(heartbeatsAnswer, "heartbeats_list");
        assertSuccess(cronAnswer, "cron_list");
        return {
          heartbeats: parseHeartbeatEntries(heartbeatsAnswer.data).map((entry) => entry.job),
          schedules: parseScheduleJobs(cronAnswer.data),
        };
      },

      "heartbeats.set": async (input, context) => ({
        heartbeat: await mutateAndParse(
          context,
          input.activeSessionId,
          heartbeatSetCommand({
            activeSessionId: input.activeSessionId,
            schedule: input.schedule,
            prompt: input.prompt,
            ...(input.deliveryMode === undefined ? {} : { deliveryMode: input.deliveryMode }),
          }),
          "heartbeat_set",
          parseHeartbeatJob,
          "prime-agent answered heartbeat_set without a heartbeat",
        ),
      }),

      "heartbeats.manage": async (input, context) => ({
        heartbeat: await mutateAndParse(
          context,
          input.activeSessionId,
          heartbeatManageCommand({
            activeSessionId: input.activeSessionId,
            jobId: input.jobId,
            action: input.action,
          }),
          `heartbeat ${input.action}`,
          parseHeartbeatJob,
          `prime-agent answered heartbeat ${input.action} without a heartbeat`,
        ),
      }),

      "heartbeats.scheduleAdd": async (input, context) => ({
        job: await mutateAndParse(
          context,
          input.activeSessionId,
          cronAddCommand({
            activeSessionId: input.activeSessionId,
            schedule: input.schedule,
            prompt: input.prompt,
          }),
          "cron_add",
          parseCronJob,
          "prime-agent answered cron_add without a job",
        ),
      }),

      "heartbeats.scheduleCancel": async (input, context) => ({
        job: await mutateAndParse(
          context,
          input.activeSessionId,
          cronCancelCommand({
            activeSessionId: input.activeSessionId,
            jobId: input.jobId,
          }),
          "cron_cancel",
          parseCronJob,
          "prime-agent answered cron_cancel without a job",
        ),
      }),
    },
    async dispose() {
      lease?.dispose();
      lease = undefined;
      retain = undefined;
      if (sweeper !== undefined) {
        clearInterval(sweeper);
        sweeper = undefined;
      }
      watched.clear();
      const connection = built;
      built = undefined;
      connection?.dispose();
    },
  });
}

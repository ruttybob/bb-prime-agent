import { z } from "zod";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { primeCronJobSchema } from "./wire.js";

/**
 * The Heartbeats panel's two contracts (bbpa-b1m.3, schedules in bbpa-b1m.4),
 * laid out exactly like the Subagents panel's:
 *
 * - `primeHeartbeatsHostContract` is what the plugin's `bb.server` entry asks
 *   this machine's `bb.host` worker for — reads and actions on the daemon the
 *   host worker owns (one per machine, where the bridge and the daemon live).
 * - `primeHeartbeatsRpcContract` is what the panel asks the plugin server for,
 *   keyed by bb thread id; the server resolves the thread's prime session and
 *   fans the question out to the connected hosts.
 *
 * The host signals carry no session id on purpose: prime's
 * `heartbeats_changed` push is global (wire fact), so the server republishes a
 * bare "something changed" and every open panel refetches its own session.
 * The frontend imports the schemas type-only — nothing here is bundled into
 * `app.js`.
 */

/** The answer a `heartbeats.list` host read gives: both lists, one round trip. */
export const heartbeatsListHostResultSchema = z.object({
  /** User and agent heartbeats (prime's `heartbeats_list`). */
  heartbeats: z.array(primeCronJobSchema),
  /** Prime-side schedules, source `cron` (prime's `cron_list`, filtered). */
  schedules: z.array(primeCronJobSchema),
});
export type HeartbeatsListHostResult = z.infer<
  typeof heartbeatsListHostResultSchema
>;

/** The list answer's schema, so the panel's view derives from one definition. */
export const heartbeatsListResultSchema = z.object({
  /**
   * `ready` — the session's lists answered; `unknown_thread` — bb has no
   * prime session identity for this thread yet; `unavailable` — no connected
   * host holds the session. The panel renders the three differently.
   */
  state: z.enum(["ready", "unknown_thread", "unavailable"]),
  activeSessionId: z.string().nullable(),
  heartbeats: z.array(primeCronJobSchema),
  schedules: z.array(primeCronJobSchema),
});

/** The ready state of the panel's list answer, shared by the server contract. */
export type HeartbeatsList = z.infer<typeof heartbeatsListResultSchema>;

/**
 * Host contract: the reads and the actions, each naming the prime session.
 * Control actions are refusals when the daemon lacks the capability (an old
 * prime without `heartbeat_catalog`/`heartbeat_management`) or the job —
 * errors, never quiet successes.
 */
export const primeHeartbeatsHostContract = defineRpcContract({
  "heartbeats.list": {
    input: z.object({ activeSessionId: z.string().min(1) }),
    output: heartbeatsListHostResultSchema,
  },
  "heartbeats.set": {
    input: z.object({
      activeSessionId: z.string().min(1),
      schedule: z.string().min(1).max(200),
      prompt: z.string().min(1).max(8000),
      deliveryMode: z.enum(["steer", "follow_up"]).optional(),
    }),
    output: z.object({ heartbeat: primeCronJobSchema }),
  },
  "heartbeats.manage": {
    input: z.object({
      activeSessionId: z.string().min(1),
      jobId: z.string().min(1),
      action: z.enum(["pause", "resume", "stop"]),
    }),
    output: z.object({ heartbeat: primeCronJobSchema }),
  },
  "heartbeats.scheduleAdd": {
    input: z.object({
      activeSessionId: z.string().min(1),
      schedule: z.string().min(1).max(200),
      prompt: z.string().min(1).max(8000),
    }),
    output: z.object({ job: primeCronJobSchema }),
  },
  "heartbeats.scheduleCancel": {
    input: z.object({
      activeSessionId: z.string().min(1),
      jobId: z.string().min(1),
    }),
    output: z.object({ job: primeCronJobSchema }),
  },
});

/** Host → server push: prime said `heartbeats_changed` (global, no payload). */
export const primeHeartbeatsHostSignals = {
  "heartbeats.changed": {
    payload: z.object({ at: z.number() }),
  },
} as const;

/**
 * Server contract, served at `/api/v1/plugins/prime-agent/rpc/<method>`.
 * Reads answer states the panel renders as-is; actions throw — a control
 * action that silently did nothing would be worse than one that visibly
 * failed (the Subagents panel's rule).
 */
export const primeHeartbeatsRpcContract = defineRpcContract({
  list: {
    input: z.object({
      threadId: z.string().min(1),
      /** The prime session an earlier call resolved; spares a lookup. */
      activeSessionId: z.string().min(1).optional(),
    }),
    output: heartbeatsListResultSchema,
  },
  set: {
    input: z.object({
      threadId: z.string().min(1),
      schedule: z.string().min(1).max(200),
      prompt: z.string().min(1).max(8000),
      deliveryMode: z.enum(["steer", "follow_up"]).optional(),
      activeSessionId: z.string().min(1).optional(),
    }),
    output: z.object({
      activeSessionId: z.string(),
      heartbeat: primeCronJobSchema,
    }),
  },
  manage: {
    input: z.object({
      threadId: z.string().min(1),
      jobId: z.string().min(1),
      action: z.enum(["pause", "resume", "stop"]),
      activeSessionId: z.string().min(1).optional(),
    }),
    output: z.object({ activeSessionId: z.string() }),
  },
  scheduleAdd: {
    input: z.object({
      threadId: z.string().min(1),
      schedule: z.string().min(1).max(200),
      prompt: z.string().min(1).max(8000),
      activeSessionId: z.string().min(1).optional(),
    }),
    output: z.object({ activeSessionId: z.string() }),
  },
  scheduleCancel: {
    input: z.object({
      threadId: z.string().min(1),
      jobId: z.string().min(1),
      activeSessionId: z.string().min(1).optional(),
    }),
    output: z.object({ activeSessionId: z.string() }),
  },
});

import { z } from "zod";

/**
 * The daemon wire facts the Heartbeats panel speaks (bbpa-b1m.3, schedules in
 * bbpa-b1m.4), read as loosely as every other wire view in this plugin: the
 * daemon protocol is not a published contract (ADR-0002), so anything we
 * render is optional-and-passthrough, and a prime that reshapes a payload
 * costs a row's fields, never a throw.
 *
 * Commands (prime 0.7.3 `daemon-protocol.js`, probed live 2026-09-06):
 *
 * - `heartbeats_list {activeSessionId?}` → `{heartbeats: [{job, sessionName?,
 *   firstMessage?}]}` — capability `heartbeat_catalog`;
 * - `heartbeat_set {activeSessionId, schedule, prompt, deliveryMode?}` →
 *   `{heartbeat: job}` — creates or replaces the session's USER heartbeat;
 * - `heartbeat_manage {activeSessionId, jobId, action: pause|resume|stop}` →
 *   `{heartbeat: job}` — one job, user or agent (capability
 *   `heartbeat_management`);
 * - `cron_list {activeSessionId?}` → `{jobs}` / `cron_add {activeSessionId,
 *   schedule, prompt}` → `{job}` / `cron_cancel {activeSessionId, jobId}` →
 *   `{job}` — prime-side schedules (source `cron`), session-resident by
 *   construction (ADR-0004).
 *
 * Live changes arrive as a GLOBAL `heartbeats_changed` push with no session
 * id and no payload — the answer to b1m.3's open question (daemon events,
 * not polling): the host republishes it and panels refetch their own session.
 */

/**
 * prime's `AgentCronJobStatus` (`active` | `paused` | `completed` |
 * `cancelled`), read as the string it is: this schema only gates what the
 * panel can render, and the values are named here, not enforced.
 */
export const primeCronJobStatusSchema = z.string();
/**
 * prime's `AgentCronJobSource` — `heartbeat` (the session's user heartbeat),
 * `rlm_heartbeat` (an agent's), `cron` (a schedule) — same loose read.
 */
export const primeCronJobSourceSchema = z.string();
/** How a heartbeat prompt lands when the session is busy (prime's default: steer). */
export const primeDeliveryModeSchema = z.enum(["steer", "follow_up"]);

/** prime's `AgentCronJob`, read loosely — exactly what a row renders. */
export const primeCronJobSchema = z
  .object({
    id: z.string(),
    status: primeCronJobStatusSchema,
    source: primeCronJobSourceSchema.optional(),
    runtimeKind: z.string().optional(),
    deliveryMode: primeDeliveryModeSchema.optional(),
    prompt: z.string().optional(),
    label: z.string().optional(),
    schedule: z
      .object({
        kind: z.string().optional(),
        expression: z.string().optional(),
        intervalMs: z.number().optional(),
      })
      .passthrough()
      .optional(),
    nextRunAt: z.string().optional(),
    lastRunAt: z.string().optional(),
    lastError: z.string().optional(),
    runCount: z.number().optional(),
    createdAt: z.string().optional(),
  })
  .passthrough();
export type PrimeCronJob = z.infer<typeof primeCronJobSchema>;

/** prime's `heartbeats_list` answer: jobs plus the display name of their session. */
export const primeHeartbeatEntrySchema = z
  .object({
    job: primeCronJobSchema,
    sessionName: z.string().optional(),
    firstMessage: z.string().optional(),
  })
  .passthrough();
export type PrimeHeartbeatEntry = z.infer<typeof primeHeartbeatEntrySchema>;

export const heartbeatsListAnswerSchema = z
  .object({ heartbeats: z.array(primeHeartbeatEntrySchema) })
  .passthrough();

export const cronListAnswerSchema = z
  .object({ jobs: z.array(primeCronJobSchema) })
  .passthrough();

/** The `{heartbeat: job}` shape `heartbeat_set` and `heartbeat_manage` answer. */
export const heartbeatJobAnswerSchema = z
  .object({ heartbeat: primeCronJobSchema })
  .passthrough();

/** The `{job}` shape `cron_add` and `cron_cancel` answer. */
export const cronJobAnswerSchema = z
  .object({ job: primeCronJobSchema })
  .passthrough();

/** `heartbeats_list`, for the session the panel names. */
export function heartbeatsListCommand(args: {
  activeSessionId: string;
}): { type: "heartbeats_list"; activeSessionId: string } {
  return { type: "heartbeats_list", activeSessionId: args.activeSessionId };
}

/** `heartbeat_set`: create or replace the session's user heartbeat. */
export function heartbeatSetCommand(args: {
  activeSessionId: string;
  schedule: string;
  prompt: string;
  deliveryMode?: "steer" | "follow_up";
}): {
  type: "heartbeat_set";
  activeSessionId: string;
  schedule: string;
  prompt: string;
  deliveryMode?: "steer" | "follow_up";
} {
  return {
    type: "heartbeat_set",
    activeSessionId: args.activeSessionId,
    schedule: args.schedule,
    prompt: args.prompt,
    ...(args.deliveryMode === undefined ? {} : { deliveryMode: args.deliveryMode }),
  };
}

/** `heartbeat_manage`: pause, resume, or stop one job by id. */
export function heartbeatManageCommand(args: {
  activeSessionId: string;
  jobId: string;
  action: "pause" | "resume" | "stop";
}): {
  type: "heartbeat_manage";
  activeSessionId: string;
  jobId: string;
  action: "pause" | "resume" | "stop";
} {
  return {
    type: "heartbeat_manage",
    activeSessionId: args.activeSessionId,
    jobId: args.jobId,
    action: args.action,
  };
}

/** `cron_list`, for the session the panel names. */
export function cronListCommand(args: {
  activeSessionId: string;
}): { type: "cron_list"; activeSessionId: string } {
  return { type: "cron_list", activeSessionId: args.activeSessionId };
}

/** `cron_add`: one prime-side schedule for this session (ADR-0004). */
export function cronAddCommand(args: {
  activeSessionId: string;
  schedule: string;
  prompt: string;
}): { type: "cron_add"; activeSessionId: string; schedule: string; prompt: string } {
  return {
    type: "cron_add",
    activeSessionId: args.activeSessionId,
    schedule: args.schedule,
    prompt: args.prompt,
  };
}

/** `cron_cancel`: cancel one schedule by id. */
export function cronCancelCommand(args: {
  activeSessionId: string;
  jobId: string;
}): { type: "cron_cancel"; activeSessionId: string; jobId: string } {
  return {
    type: "cron_cancel",
    activeSessionId: args.activeSessionId,
    jobId: args.jobId,
  };
}

/**
 * The heartbeats a list answer carries: jobs whose source says heartbeat (the
 * session's user heartbeat and any agent `rlm_heartbeat` jobs), each with its
 * entry's display fields. A job that fails to parse is skipped — a prime that
 * reshapes the payload costs a row, never the panel.
 */
export function parseHeartbeatEntries(
  answer: unknown,
): Array<PrimeHeartbeatEntry> {
  const parsed = heartbeatsListAnswerSchema.safeParse(answer);
  return parsed.success ? parsed.data.heartbeats : [];
}

/**
 * The schedules a list answer carries: jobs with source `cron` (and, for a
 * prime that stops naming sources, nothing — an unnamed job is ambiguous, so
 * it is not offered a schedule's cancel button).
 */
export function parseScheduleJobs(answer: unknown): Array<PrimeCronJob> {
  const parsed = cronListAnswerSchema.safeParse(answer);
  return parsed.success
    ? parsed.data.jobs.filter((job) => job.source === "cron")
    : [];
}

/** The job a `heartbeat_set`/`heartbeat_manage` answer carries, or `undefined`. */
export function parseHeartbeatJob(answer: unknown): PrimeCronJob | undefined {
  const parsed = heartbeatJobAnswerSchema.safeParse(answer);
  return parsed.success ? parsed.data.heartbeat : undefined;
}

/** The job a `cron_add`/`cron_cancel` answer carries, or `undefined`. */
export function parseCronJob(answer: unknown): PrimeCronJob | undefined {
  const parsed = cronJobAnswerSchema.safeParse(answer);
  return parsed.success ? parsed.data.job : undefined;
}

import type { DaemonCommandResult } from "./client.js";

/**
 * Reading daemon answers, once for every lane that does it.
 *
 * prime's wire is loose (ADR-02) and its refusals are plain strings, so the
 * two things every caller needs — a legible error when the daemon refuses a
 * command, and a legible error when the answer is not the shape it expected —
 * live here rather than being re-spelled per module. The error texts are the
 * bridge's contract with its tests and its timeline: do not reword them.
 */

/** The seam both the session lane and the fork choreography ask through. */
export type DaemonRequest = (
  command: { type: string } & Record<string, unknown>,
  args?: { timeoutMs?: number },
) => Promise<DaemonCommandResult>;

/**
 * The daemon's refusal for a session id it no longer hosts: the supervisor and
 * every worker spell it identically (`resolveActiveSessionState`,
 * `findWorker`), and it is the one refusal that means "the resident session is
 * gone, the transcript file is not" — the daemon evicts idle sessions, and
 * `create {sessionPath}` re-hosts the same transcript under a fresh id.
 */
const UNKNOWN_ACTIVE_SESSION = "Unknown active session";

/** Whether a daemon refusal (raw or `readCommandData`-formatted) says gone. */
export function isUnknownActiveSessionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(UNKNOWN_ACTIVE_SESSION);
}

/** What an answer parser reports: the typed read, or why it could not read. */
export type AnswerRead<T> =
  | { success: true; data: T }
  | { success: false; issues: string };

/** Read one answered command, with prime's refusals and shapes legible. */
export function readCommandData<T>(
  result: DaemonCommandResult,
  command: string,
  parse: (data: unknown) => AnswerRead<T>,
): T {
  if (!result.success) {
    throw new Error(
      `prime-agent refused "${command}": ${result.error ?? "unknown daemon error"}`,
    );
  }
  const parsed = parse(result.data);
  if (!parsed.success) {
    throw new Error(
      `prime-agent answered "${command}" with something this bridge cannot read (${parsed.issues})`,
    );
  }
  return parsed.data;
}

/** Send one command through a request seam and read its answer. */
export async function ask<T>(
  request: DaemonRequest,
  command: { type: string } & Record<string, unknown>,
  parse: (data: unknown) => AnswerRead<T>,
): Promise<T> {
  return readCommandData(await request(command), command.type, parse);
}

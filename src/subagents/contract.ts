import { z } from "zod";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { primeChildSchema } from "./children.js";
import { MAX_STEER_MESSAGE_CHARS } from "./control.js";

/**
 * The Subagents panel's two contracts (bbpa-ggf.9, control added in .10).
 *
 * - `primeSubagentsHostContract` is what the plugin's `bb.server` entry asks
 *   this machine's `bb.host` worker for: a roster of one daemon session's
 *   children, plus the two control actions on one of them (steer, stop). The
 *   host worker owns the per-machine daemon client, because the prime daemon
 *   lives on the host machine where the bridge processes run — the same reason
 *   the provider bridge itself lives there.
 * - `primeSubagentsRpcContract` is what the panel (a `bb.app` frontend) asks
 *   the plugin server for, keyed by bb thread id; the server resolves the
 *   thread's prime session and fans the question out to the connected hosts.
 *
 * Both share the child schema and the roster answer, so a value flowing from
 * the daemon through the host worker into a window is validated by exactly one
 * shape. The frontend imports this module *type-only* — nothing here is
 * bundled into `app.js`.
 */

export const subagentsRosterResultSchema = z.object({
  /**
   * `ready` — a prime session was resolved and its roster answered;
   * `unknown_thread` — bb has no prime session identity for this thread yet
   * (never started, or started by another provider);
   * `unavailable` — prime's daemon answered for no connected host (stopped,
   * or the session is gone after a daemon restart).
   */
  state: z.enum(["ready", "unknown_thread", "unavailable"]),
  activeSessionId: z.string().nullable(),
  children: z.array(primeChildSchema),
});

export type SubagentsRosterResult = z.infer<typeof subagentsRosterResultSchema>;

/**
 * The two control answers, stated as the panel may show them. `delivery`
 * mirrors prime's `send_message` receipt (`delivered` = injected into the
 * child's run, `queued` = joins its steering lane); `unknown` is a future
 * prime reporting a status this calibration does not name.
 */
export const subagentsSteerResultSchema = z.object({
  delivery: z.enum(["delivered", "queued", "unknown"]),
});
export type SubagentsSteerResult = z.infer<typeof subagentsSteerResultSchema>;

/**
 * A stop that reached the panel is a stop that happened: prime answering
 * `cancelled:false` is an error in the handler, so `true` is the only value
 * this contract can carry.
 */
export const subagentsStopResultSchema = z.object({
  cancelled: z.literal(true),
});
export type SubagentsStopResult = z.infer<typeof subagentsStopResultSchema>;

/**
 * Host contract: the read-only roster question, and the two control actions
 * (bbpa-ggf.10) that map to prime's `send_message` and `cancel_rlm_child`.
 * Both control actions name the child inside the session the panel is already
 * watching — prime routes agent messages within the nuclear family only, and
 * the parent session is the panel's vantage point. prime's
 * `delete_rlm_subagent` has no method here on purpose: stopping a subagent
 * cancels it, it never deletes the ledger row.
 */
export const primeSubagentsHostContract = defineRpcContract({
  "subagents.roster": {
    input: z.object({
      activeSessionId: z.string().min(1),
    }),
    output: z.object({
      children: z.array(primeChildSchema),
    }),
  },
  "subagents.steer": {
    input: z.object({
      activeSessionId: z.string().min(1),
      childId: z.string().min(1),
      message: z.string().min(1).max(MAX_STEER_MESSAGE_CHARS),
    }),
    output: subagentsSteerResultSchema,
  },
  "subagents.stop": {
    input: z.object({
      activeSessionId: z.string().min(1),
      childId: z.string().min(1),
    }),
    output: subagentsStopResultSchema,
  },
});

/** Host → server push: a watched session's roster changed. */
export const primeSubagentsHostSignals = {
  "subagents.changed": {
    payload: z.object({
      activeSessionId: z.string(),
      children: z.array(primeChildSchema),
    }),
  },
} as const;

/**
 * The session plus action a control answer is about, so a panel can match the
 * answer to its own thread and (as with the roster) skip the server's
 * thread-identity lookup afterwards.
 */
const subagentsControlOutput = z.object({
  activeSessionId: z.string(),
});

/** Server contract, served at `/api/v1/plugins/prime-agent/rpc/<method>`. */
export const primeSubagentsRpcContract = defineRpcContract({
  roster: {
    input: z.object({
      threadId: z.string().min(1),
      /**
       * The prime session resolved by an earlier call. Absent on a panel's
       * first question; sending it spares the server the thread-identity
       * lookup and keeps a roster refresh to one hop.
       */
      activeSessionId: z.string().min(1).optional(),
    }),
    output: subagentsRosterResultSchema,
  },
  /**
   * The control questions carry the thread id instead of a session id (the
   * panel may not have resolved one yet) and refuse — with an rpc error, not a
   * quiet `state:` — when no host can act: a control action that silently did
   * nothing would be worse than one that visibly failed.
   */
  steer: {
    input: z.object({
      threadId: z.string().min(1),
      childId: z.string().min(1),
      message: z.string().min(1).max(MAX_STEER_MESSAGE_CHARS),
      activeSessionId: z.string().min(1).optional(),
    }),
    output: subagentsControlOutput.extend(subagentsSteerResultSchema.shape),
  },
  stop: {
    input: z.object({
      threadId: z.string().min(1),
      childId: z.string().min(1),
      activeSessionId: z.string().min(1).optional(),
    }),
    output: subagentsControlOutput.extend(subagentsStopResultSchema.shape),
  },
});

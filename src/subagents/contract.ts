import { z } from "zod";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { primeChildSchema } from "./children.js";

/**
 * The Subagents panel's two contracts (bbpa-ggf.9).
 *
 * - `primeSubagentsHostContract` is what the plugin's `bb.server` entry asks
 *   this machine's `bb.host` worker for: a roster of one daemon session's
 *   children. The host worker owns the per-machine daemon client, because the
 *   prime daemon lives on the host machine where the bridge processes run —
 *   the same reason the provider bridge itself lives there.
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
 * Host contract. One method, read-only: prime's `cancel_rlm_child` and
 * `send_message` are deliberately absent — subagent control is bbpa-ggf.10.
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
});

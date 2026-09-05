import { z } from "zod";
import { PRIME_PLUGIN_ID } from "./vocabulary.js";

/**
 * The bb-side representation of prime's message queue (bbpa-ggf.5).
 *
 * Prime keeps two waiting lanes per session — steering (delivered after the
 * current tool round, before the next model call) and follow-ups (delivered
 * only after the run ends) — and announces every change as a
 * `session_action_update` session event carrying the queued previews. The
 * delta grammar has no dedicated queue kind, so the queue is surfaced as the
 * thread's `extension.state` under the `prime-agent/queue` extension kind: the
 * same state channel bb's assembler already accepts and persists (codex uses
 * it for its goal). The declaration in `src/declaration.ts` must keep
 * declaring the kind, or the server demotes the payload to
 * `provider/unhandled` at ingest.
 */

/** The local name of the extension kind (the server prefixes the plugin id). */
export const PRIME_QUEUE_EXTENSION_KIND_NAME = "queue";

/** The namespaced extension kind the deltas carry. */
export const PRIME_QUEUE_EXTENSION_KIND = `${PRIME_PLUGIN_ID}/${PRIME_QUEUE_EXTENSION_KIND_NAME}`;

/** What waits in prime's lanes right now (the previews prime shows itself). */
export interface PrimeQueueState {
  steering: readonly string[];
  followUps: readonly string[];
}

/**
 * The declared `state` schema for the queue extension kind: the payload while
 * something waits, or `null` once both lanes are empty. Validated by bb's
 * server at ingest.
 */
export const primeQueueStateSchema = z.union([
  z.object({
    steering: z.array(z.string()),
    followUps: z.array(z.string()),
  }),
  z.null(),
]);

export type PrimeQueueStatePayload = z.infer<typeof primeQueueStateSchema>;

/**
 * The queue-state payload for a queue snapshot: the lane contents while
 * messages wait, `null` once the queue is drained.
 */
export function queueStatePayload(
  queue: PrimeQueueState,
): PrimeQueueStatePayload {
  return queue.steering.length === 0 && queue.followUps.length === 0
    ? null
    : { steering: [...queue.steering], followUps: [...queue.followUps] };
}

import { z } from "zod";

/**
 * prime's thread goal state on the bb timeline (bbpa-b1m.2).
 *
 * prime keeps a per-session goal (`/goal …`; `GoalState` in its
 * `dist/core/goals.js`) and reports it two ways this bridge can read:
 *
 * - live: a `goal_update` session event carrying the full state, emitted on
 *   every mutation AND on the periodic accounting ticks while the goal's
 *   continuation turns run (tokens/time used move without a mutation);
 * - at attach: the snapshot's `state.goal` (`AgentConnectionState.goal`),
 *   which prime fills from the session's persisted `thread_goal_state`.
 *
 * The two are the answer to the ticket's open question ("snapshot field vs
 * session_slash_command results"): the snapshot field seeds the timeline row
 * when a thread is adopted, the event keeps it current afterwards. Parsing
 * the command rows is deliberately not a thing.
 *
 * bb has no native goal surface a third-party provider can feed yet (bb
 * 0.42.1 extracts thread goal state only from the hardcoded
 * `provider-codex/goal` extension kind — see the ticket comment), so the
 * state renders as a `prime-agent/goal` extension ITEM row: open while the
 * goal lives, updated in place by the accounting ticks, closed when the goal
 * reaches a terminal state.
 */

/**
 * prime's `GoalState`, read loosely: every field we render is optional so a
 * prime that reshapes its shape costs a row, never a translator throw.
 * `status` is prime's own spelling (`idle` | `active` | `paused` |
 * `budget_limited` | `complete` | `error`).
 */
export const primeGoalStateSchema = z
  .object({
    active: z.boolean().optional(),
    status: z.string().optional(),
    goalId: z.string().optional(),
    objective: z.string().optional(),
    tokenBudget: z.number().optional(),
    tokensUsed: z.number().optional(),
    timeUsedSeconds: z.number().optional(),
  })
  .passthrough();
export type PrimeGoalState = z.infer<typeof primeGoalStateSchema>;

/**
 * The goal-state words this bridge puts in row payloads. The first four are
 * bb's own timeline goal vocabulary (`active` | `paused` | `budgetLimited` |
 * `complete`, prime's `budget_limited` respelled); `cleared` and `error` are
 * the prime-only tails — bb's union cannot say them, and the row closes with
 * the payload carrying the last state either way.
 */
export type PrimeGoalRowStatus =
  | "active"
  | "paused"
  | "budgetLimited"
  | "complete"
  | "error"
  | "cleared";

/**
 * prime status → the row's status word. `idle` is prime's "no goal" (the
 * empty state, and what a `/goal clear` leaves); `error` is a goal whose
 * continuation failed hard. Both are terminal for the row, and both close it.
 */
export function goalRowStatus(status: string | undefined): PrimeGoalRowStatus {
  switch (status) {
    case "active":
      return "active";
    case "paused":
      return "paused";
    case "budget_limited":
      return "budgetLimited";
    case "complete":
      return "complete";
    case "error":
      return "error";
    default:
      return "cleared";
  }
}

/** Terminal: the goal no longer runs, so its row closes. */
export function goalStatusIsTerminal(status: PrimeGoalRowStatus): boolean {
  return status === "complete" || status === "error" || status === "cleared";
}

/** Parse a wire value into a goal state; `undefined` when it is not one. */
export function parsePrimeGoalState(value: unknown): PrimeGoalState | undefined {
  const parsed = primeGoalStateSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Whether a parsed state describes a goal worth a row: prime's empty state is
 * `active: false, status: "idle"` with no objective, and it rides every
 * snapshot. Seeding an idle state would open a row for nothing.
 */
export function goalStateHasContent(goal: PrimeGoalState): boolean {
  return goalRowStatus(goal.status) !== "cleared";
}

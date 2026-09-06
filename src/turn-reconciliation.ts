/**
 * Turn reconciliation facts (bbpa-uld): the one verdict and the one clock the
 * reconciling lane needs.
 *
 * A bb turn must never hang in "Working..." forever. When the turn-end signal
 * is lost — a reaped provider-bridge worker mid-turn, a missed daemon
 * `agent_end` — the turn stays open on the bb side while the daemon-side
 * resident session has already settled (observed twice in one evening on one
 * thread: session idle, `taskState: needs_input`, the bb turn spinning for 20+
 * minutes). The lane polls the daemon session state (`get_state`) while its
 * turn is open and settles the turn itself when the session is verifiably not
 * working for a grace period.
 */

/**
 * The daemon's `SessionSummary` (`get_state` answer, read loosely — ADR-0002):
 * the fields that decide "verifiably not working". `activity` is the daemon's
 * own busy fold (working/idle, held at "working" until its idle verdict is
 * current); the explicit flags are the individual work signals the ticket
 * names — streaming, running tools, running bash, running RLM children, and an
 * in-progress compaction.
 */
export function sessionSummaryIsIdle(summary: unknown): boolean {
  if (typeof summary !== "object" || summary === null) {
    return false;
  }
  const record = summary as Record<string, unknown>;
  // The daemon's own verdict is the load-bearing bit: it folds in everything
  // it knows (including holding at "working" until the idle read is current).
  // A summary without it is not evidence of anything.
  if (record.activity !== "idle") {
    return false;
  }
  // Each named signal vetoes on `true` and is simply absent on older wires —
  // the daemon verdict above already carries them when present.
  const busyFlags = [
    "isSessionActive",
    "isStreaming",
    "isRunningTools",
    "isBashRunning",
    "hasRunningRlmChildren",
    "isCompacting",
  ] as const;
  if (!busyFlags.every((flag) => record[flag] !== true)) {
    return false;
  }
  // The verdict alone is not enough: a summary that spells none of the
  // detail flags has not proven the session is idle, it has only said so.
  // The calibrated daemon always spells `isStreaming`/`isCompacting`; a wire
  // that carries neither (nor any other flag) is not evidence to settle on.
  return busyFlags.some((flag) => record[flag] === false);
}

/**
 * The lane's reconcile clock: the poll timer that reads `get_state` while a
 * turn is open, the moment the session first read verifiably idle in the
 * current window, the one attach-time check a fresh worker schedules, and how
 * many turns settled since that attach (any settled turn proves the lane is
 * live — the attach-time check stands down).
 */
export interface ReconcileClock {
  pollTimer: ReturnType<typeof setTimeout> | undefined;
  attachTimer: ReturnType<typeof setTimeout> | undefined;
  /** The attach check's second phase: the confirming read after the grace. */
  attachConfirmTimer: ReturnType<typeof setTimeout> | undefined;
  idleSince: number | undefined;
  settledSinceAttach: number;
}

/** The reconcile cadence: how often to read, how long idle must hold. */
export interface ReconcileTiming {
  /** How often the lane reads `get_state` while a turn is open. */
  pollMs: number;
  /** How long the session must read verifiably idle before the settle. */
  graceMs: number;
  /** How long after an adopt-attach the one attach-time check waits. */
  attachCheckDelayMs: number;
}

export const RECONCILE_POLL_ENV = "BB_PRIME_AGENT_RECONCILE_POLL_MS";
export const RECONCILE_GRACE_ENV = "BB_PRIME_AGENT_RECONCILE_GRACE_MS";
export const RECONCILE_ATTACH_CHECK_ENV =
  "BB_PRIME_AGENT_RECONCILE_ATTACH_CHECK_DELAY_MS";

/**
 * Production cadence. The ticket's observed stuck turn spanned 20+ minutes; a
 * one-minute grace closes it over a minute after the loss while staying far
 * clear of a slow model round (a working session never reads idle at all).
 */
const DEFAULT_TIMING: ReconcileTiming = {
  pollMs: 15_000,
  graceMs: 60_000,
  attachCheckDelayMs: 5_000,
};

/** Nothing polls faster than this, whatever the override says. */
const MIN_WAIT_MS = 50;

function readMs(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number(value);
  // A number clamps to the floor; anything else falls back to the default.
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(MIN_WAIT_MS, parsed);
}

/**
 * The reconcile cadence from the environment (tests shorten it; production
 * runs the defaults). Read per call, so a test process can retune between
 * tests without re-importing the module.
 */
export function reconcileTimingFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ReconcileTiming {
  return {
    pollMs: readMs(env[RECONCILE_POLL_ENV], DEFAULT_TIMING.pollMs),
    graceMs: readMs(env[RECONCILE_GRACE_ENV], DEFAULT_TIMING.graceMs),
    attachCheckDelayMs: readMs(
      env[RECONCILE_ATTACH_CHECK_ENV],
      DEFAULT_TIMING.attachCheckDelayMs,
    ),
  };
}

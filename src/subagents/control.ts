import type { PrimeChild } from "./children.js";

/**
 * Subagent control (bbpa-ggf.10): the two daemon commands the panel's actions
 * map to, and the honest reading of their answers.
 *
 * Wire facts are prime-agent 0.7.3 (`docs/spikes/0001-prime-daemon-protocol.md`,
 * verdict b; `daemon-mode.js` `case "send_message"` / `case "cancel_rlm_child"`):
 *
 * - `send_message {targetActiveSessionId, message, fromActiveSessionId?}`
 *   (minProtocol 7, no capability) puts one agent message into one target
 *   session and answers a receipt whose `deliveryStatus` is `delivered`
 *   (injected into the target's run) or `queued` (it joins the target's
 *   steering lane for its next prompt boundary). `fromActiveSessionId` is the
 *   parent session, so the child reads the steer as coming *from parent*.
 * - `cancel_rlm_child {activeSessionId, childId}` (minProtocol 7, no
 *   capability) soft-aborts that child of the named session and answers
 *   `{cancelled}` — `false` when there was nothing running to cancel. The
 *   child's ledger row gets a "revoked" tombstone and the transcript is kept;
 *   siblings and the parent turn are untouched.
 *
 * Cancel-only by design: prime's `delete_rlm_subagent` (the ledger *delete*)
 * is deliberately unreachable from here, so the panel cannot wipe a subagent's
 * history no matter what it sends.
 */

/** prime's own cap on one agent message (`DEFAULT_AGENT_MESSAGE_MAX_CHARS`). */
export const MAX_STEER_MESSAGE_CHARS = 16_384;

/**
 * The selector prime resolves for this child. A booted child owns a daemon
 * session, and that session id is the direct route (prime resolves selectors
 * by session id or name, never by RLM child id); a child that has not booted
 * yet has no session, so the child id goes instead and prime resolves it
 * through the ledger.
 */
export function steerTarget(child: PrimeChild): string {
  const ownSession = child.activeSessionId;
  return ownSession !== undefined && ownSession.length > 0
    ? ownSession
    : child.id;
}

/** `send_message`, shaped exactly as the spike documents it. */
export function steerCommand(args: {
  targetActiveSessionId: string;
  message: string;
  /** The parent session: the child reads the steer as coming from its parent. */
  fromActiveSessionId: string;
}): { type: "send_message" } & Record<string, unknown> {
  return {
    type: "send_message",
    targetActiveSessionId: args.targetActiveSessionId,
    message: args.message,
    fromActiveSessionId: args.fromActiveSessionId,
  };
}

/** `cancel_rlm_child`, shaped exactly as the spike documents it. */
export function stopCommand(args: {
  activeSessionId: string;
  childId: string;
}): { type: "cancel_rlm_child" } & Record<string, unknown> {
  return {
    type: "cancel_rlm_child",
    activeSessionId: args.activeSessionId,
    childId: args.childId,
  };
}

/**
 * How prime says a steer landed. `unknown` covers a future prime that reports
 * a third status: the message was accepted either way, so refusing it would be
 * a false negative — the panel just says less about it.
 */
export type SteerDelivery = "delivered" | "queued" | "unknown";

/** Read the receipt prime answers `send_message` with. */
export function steerDelivery(receipt: unknown): SteerDelivery {
  const status = (receipt as { deliveryStatus?: unknown } | undefined)
    ?.deliveryStatus;
  if (status === "delivered" || status === "queued") {
    return status;
  }
  if (typeof status === "string" && status.length > 0) {
    return "unknown";
  }
  throw new Error(
    'prime-agent answered "send_message" without a delivery status, so the steer cannot be confirmed',
  );
}

/**
 * Read `{cancelled}` from a `cancel_rlm_child` answer, refusing to call a stop
 * confirmed when prime says otherwise: `false` means nothing was running (the
 * child finished, or was already cancelled), and the panel must hear that.
 */
export function stopCancelled(answer: unknown): true {
  if ((answer as { cancelled?: unknown } | undefined)?.cancelled === true) {
    return true;
  }
  throw new Error(
    'prime-agent answered "cancel_rlm_child" with cancelled:false — the subagent was not running, so nothing was stopped',
  );
}

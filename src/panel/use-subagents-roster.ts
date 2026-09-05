import { useCallback, useEffect, useRef, useState } from "react";
import {
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { PrimeChild } from "../subagents/children.js";
import type {
  SubagentsRosterResult,
  primeSubagentsRpcContract,
} from "../subagents/contract.js";
import { SUBAGENTS_REALTIME_CHANNEL } from "../vocabulary.js";

/**
 * One panel's live subagent roster, plus the control actions on it
 * (bbpa-ggf.9, control in bbpa-ggf.10).
 *
 * The flow is question-and-answer all the way down: the hook asks the plugin
 * server for the roster, and every signal that *something* changed — a host
 * push republished on the realtime channel, or the shared connection coming
 * back after a gap — asks again. The server's answer is the only state kept,
 * so the panel cannot drift from the daemon: a steer or a stop shows as a
 * *pending* state only, and the change itself always arrives through a
 * refreshed roster, never as a local edit.
 */

export type RosterStatus =
  | { kind: "loading" }
  | { kind: "roster"; children: readonly PrimeChild[] }
  | { kind: "unavailable"; message: string };

/** The one action a row can have in flight. */
export type SubagentAction = "steer" | "stop";

/** A control action the daemon refused, shown next to the row it was for. */
export interface SubagentActionFailure {
  childId: string;
  action: SubagentAction;
  message: string;
}

export interface SubagentsPanel {
  status: RosterStatus;
  /** Child id → the action in flight for it (cleared when the call settles). */
  pending: ReadonlyMap<string, SubagentAction>;
  /** The last refusal, per the row that raised it; cleared by the next try. */
  failure: SubagentActionFailure | undefined;
  /** prime's word on where a steer landed, for the row that just sent one. */
  delivery:
    | { childId: string; delivery: "delivered" | "queued" | "unknown" }
    | undefined;
  /** `false` when prime refused, so a row can keep what the user typed. */
  steer(childId: string, message: string): Promise<boolean>;
  stop(childId: string): Promise<boolean>;
}

export function useSubagentsRoster(threadId: string): SubagentsPanel {
  const rpc = useRpc<typeof primeSubagentsRpcContract>();
  const [status, setStatus] = useState<RosterStatus>({ kind: "loading" });
  /**
   * The prime session the first answer named. A refresh then skips the
   * server's thread-identity lookup, realtime payloads are matched by it, and
   * control actions ride it instead of re-resolving the thread.
   */
  const activeSessionIdRef = useRef<string | null>(null);
  /** Set when a signal lands mid-request: that request's answer may be stale. */
  const dirtyRef = useRef(false);
  const inFlightRef = useRef(false);
  const [pending, setPending] = useState<ReadonlyMap<string, SubagentAction>>(
    () => new Map(),
  );
  const [failure, setFailure] = useState<SubagentActionFailure | undefined>();
  const [delivery, setDelivery] = useState<
    SubagentsPanel["delivery"] | undefined
  >();

  const fetchRoster = useCallback(async () => {
    if (inFlightRef.current) {
      dirtyRef.current = true;
      return;
    }
    inFlightRef.current = true;
    try {
      // A loop, not a recursion: changes asked for mid-request rerun against
      // the freshest state instead of stacking requests.
      do {
        dirtyRef.current = false;
        const activeSessionId = activeSessionIdRef.current ?? undefined;
        const answer: SubagentsRosterResult = await rpc.call("roster", {
          threadId,
          ...(activeSessionId === undefined ? {} : { activeSessionId }),
        });
        if (answer.activeSessionId !== null) {
          activeSessionIdRef.current = answer.activeSessionId;
        }
        setStatus(toStatus(answer));
      } while (dirtyRef.current);
    } catch (error) {
      setStatus({
        kind: "unavailable",
        message:
          error instanceof Error
            ? error.message
            : "The Subagents panel could not read the roster.",
      });
    } finally {
      inFlightRef.current = false;
    }
  }, [rpc, threadId]);

  useEffect(() => {
    void fetchRoster();
  }, [fetchRoster]);

  useRealtime(
    SUBAGENTS_REALTIME_CHANNEL,
    useCallback(
      (payload: unknown) => {
        const payloadSession = (
          payload as { activeSessionId?: unknown } | null
        )?.activeSessionId;
        if (
          typeof payloadSession === "string" &&
          payloadSession !== activeSessionIdRef.current
        ) {
          return;
        }
        void fetchRoster();
      },
      [fetchRoster],
    ),
  );

  // Roster signals are ephemeral by design, so a reconnect is a gap: the only
  // catch-up is asking again.
  const connectionState = useRealtimeConnectionState();
  const missedSignals = useRef(false);
  useEffect(() => {
    if (connectionState !== "connected") {
      missedSignals.current = true;
      return;
    }
    if (!missedSignals.current) {
      return;
    }
    missedSignals.current = false;
    void fetchRoster();
  }, [connectionState, fetchRoster]);

  /**
   * One control call: a pending state while it runs, the roster as the only
   * source of the change itself. A refusal is surfaced to the row it was for,
   * and reported to that row as `false`.
   */
  const control = useCallback(
    async (
      action: SubagentAction,
      childId: string,
      run: (activeSessionId: string) => Promise<void>,
    ): Promise<boolean> => {
      const activeSessionId = activeSessionIdRef.current;
      if (activeSessionId === null) {
        setFailure({
          childId,
          action,
          message: "No prime session to act on yet.",
        });
        return false;
      }
      setFailure(undefined);
      setDelivery(undefined);
      setPending((current) => new Map(current).set(childId, action));
      try {
        await run(activeSessionId);
        void fetchRoster();
        return true;
      } catch (error) {
        setFailure({
          childId,
          action,
          message:
            error instanceof Error
              ? error.message
              : "prime-agent refused the action.",
        });
        return false;
      } finally {
        setPending((current) => {
          const next = new Map(current);
          next.delete(childId);
          return next;
        });
      }
    },
    [fetchRoster],
  );

  const steer = useCallback(
    async (childId: string, message: string) =>
      control("steer", childId, async (activeSessionId) => {
        const answer = await rpc.call("steer", {
          threadId,
          childId,
          message,
          activeSessionId,
        });
        setDelivery({ childId, delivery: answer.delivery });
      }),
    [control, rpc, threadId],
  );

  const stop = useCallback(
    async (childId: string) =>
      control("stop", childId, async (activeSessionId) => {
        await rpc.call("stop", { threadId, childId, activeSessionId });
      }),
    [control, rpc, threadId],
  );

  return { status, pending, failure, delivery, steer, stop };
}

function toStatus(answer: SubagentsRosterResult): RosterStatus {
  if (answer.state === "unavailable") {
    return {
      kind: "unavailable",
      message:
        "prime-agent has no roster for this session. Is prime-agent running on this machine?",
    };
  }
  // `unknown_thread` means bb has no prime session identity for the thread yet
  // (never started, or another provider's): an empty roster is the honest read.
  return { kind: "roster", children: answer.children };
}

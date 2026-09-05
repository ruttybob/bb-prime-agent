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
 * One panel's live subagent roster (bbpa-ggf.9).
 *
 * The flow is question-and-answer all the way down: the hook asks the plugin
 * server for the roster, and every signal that *something* changed — a host
 * push republished on the realtime channel, or the shared connection coming
 * back after a gap — asks again. The server's answer is the only state kept,
 * so the panel cannot drift from the daemon: a read-only surface has no
 * optimistic edits to reconcile, and a refresh that races a push converges on
 * the next one.
 *
 * The contracts module is imported type-only: nothing here bundles zod.
 */

export type RosterStatus =
  | { kind: "loading" }
  | { kind: "roster"; children: readonly PrimeChild[] }
  | { kind: "unavailable"; message: string };

export function useSubagentsRoster(threadId: string): RosterStatus {
  const rpc = useRpc<typeof primeSubagentsRpcContract>();
  const [status, setStatus] = useState<RosterStatus>({ kind: "loading" });
  /**
   * The prime session the first answer named. A refresh then skips the
   * server's thread-identity lookup, and realtime payloads are matched by it —
   * a panel never reacts to another thread's roster change.
   */
  const activeSessionIdRef = useRef<string | null>(null);
  /** Set when a signal lands mid-request: that request's answer may be stale. */
  const dirtyRef = useRef(false);
  const inFlightRef = useRef(false);

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

  return status;
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

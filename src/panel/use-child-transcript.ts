import { useCallback, useEffect, useRef, useState } from "react";
import {
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { TranscriptEntry } from "../subagents/transcript.js";
import type { primeSubagentsRpcContract } from "../subagents/contract.js";
import { SUBAGENTS_REALTIME_CHANNEL } from "../vocabulary.js";

/**
 * One child's transcript while its panel section is open (bbpa-b1m.8).
 *
 * Read-only, and question-and-answer like the roster hook it mirrors: the hook
 * asks the plugin server for the bounded transcript and keeps asking — on a
 * slow poll while the section is open (v1-honest: the wire's push surface
 * keeps the host's cache current, but a window's view of it is a poll), on the
 * roster signals that already announce child activity, and after a realtime
 * gap. The server's answer is the only state kept, so the view cannot drift
 * from the daemon.
 */

export type TranscriptStatus =
  | { kind: "loading" }
  | { kind: "ready"; entries: readonly TranscriptEntry[]; truncated: boolean }
  | { kind: "no_session" }
  | { kind: "unavailable"; message: string };

export interface ChildTranscriptView {
  status: TranscriptStatus;
}

/** How often an open transcript re-asks while nothing else nudges it. */
const TRANSCRIPT_POLL_MS = 5_000;

export function useChildTranscript(
  threadId: string,
  childId: string,
  activeSessionId: string | undefined,
): ChildTranscriptView {
  const rpc = useRpc<typeof primeSubagentsRpcContract>();
  const [status, setStatus] = useState<TranscriptStatus>({ kind: "loading" });
  /** Set when a signal lands mid-request: that request's answer may be stale. */
  const dirtyRef = useRef(false);
  const inFlightRef = useRef(false);

  const fetchTranscript = useCallback(async () => {
    if (inFlightRef.current) {
      dirtyRef.current = true;
      return;
    }
    inFlightRef.current = true;
    try {
      do {
        dirtyRef.current = false;
        const answer = await rpc.call("transcript", {
          threadId,
          childId,
          ...(activeSessionId === undefined ? {} : { activeSessionId }),
        });
        if (answer.state === "no_session") {
          setStatus({ kind: "no_session" });
        } else if (answer.state === "ready") {
          setStatus({
            kind: "ready",
            entries: answer.entries,
            truncated: answer.truncated,
          });
        } else {
          setStatus({ kind: "unavailable", message: TRANSCRIPT_UNAVAILABLE });
        }
      } while (dirtyRef.current);
    } catch (error) {
      setStatus({
        kind: "unavailable",
        message:
          error instanceof Error
            ? error.message
            : "The transcript could not be read.",
      });
    } finally {
      inFlightRef.current = false;
    }
  }, [rpc, threadId, childId, activeSessionId]);

  useEffect(() => {
    void fetchTranscript();
  }, [fetchTranscript]);

  // The v1-honest clock: while the section is open, re-ask on a slow poll.
  useEffect(() => {
    const timer = setInterval(() => {
      void fetchTranscript();
    }, TRANSCRIPT_POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [fetchTranscript]);

  useRealtime(
    SUBAGENTS_REALTIME_CHANNEL,
    useCallback(
      (payload: unknown) => {
        const payloadSession = (
          payload as { activeSessionId?: unknown } | null
        )?.activeSessionId;
        if (
          typeof payloadSession === "string" &&
          payloadSession !== activeSessionId
        ) {
          return;
        }
        void fetchTranscript();
      },
      [fetchTranscript, activeSessionId],
    ),
  );

  // Signals are ephemeral by design, so a reconnect is a gap: the only
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
    void fetchTranscript();
  }, [connectionState, fetchTranscript]);

  return { status };
}

const TRANSCRIPT_UNAVAILABLE =
  "prime-agent has no transcript for this subagent right now. Is prime-agent running on this machine?";

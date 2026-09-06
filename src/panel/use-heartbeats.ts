import { useCallback, useEffect, useRef, useState } from "react";
import {
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type {
  HeartbeatsList,
  primeHeartbeatsRpcContract,
} from "../heartbeats/contract.js";
import { HEARTBEATS_REALTIME_CHANNEL } from "../vocabulary.js";

/**
 * One panel's live heartbeats and schedules, plus the actions on them
 * (bbpa-b1m.3, schedules in bbpa-b1m.4).
 *
 * The flow mirrors the Subagents roster: the hook asks the plugin server, and
 * every signal that *something* changed — prime's global `heartbeats_changed`
 * push republished on the realtime channel, or the realtime connection
 * coming back after a gap — asks again. The server's answer is the only state
 * kept, so a pause or a stop shows as a *pending* state only, and the change
 * itself always arrives through a refreshed list, never as a local edit.
 */

export type HeartbeatsStatus =
  | { kind: "loading" }
  | { kind: "ready"; list: HeartbeatsList }
  | { kind: "unavailable"; message: string };

/** The one action a row can have in flight. */
export type HeartbeatAction = "set" | "pause" | "resume" | "stop" | "add" | "cancel";

export interface HeartbeatsPanel {
  status: HeartbeatsStatus;
  /** The prime session the last answer named, or `null` before the first one. */
  activeSessionId: string | null;
  /** The action in flight, when any (cleared when the call settles). */
  pending: HeartbeatAction | undefined;
  /** The last refusal, shown by the form or row that raised it. */
  failure: string | undefined;
  set(args: {
    schedule: string;
    prompt: string;
    deliveryMode: "steer" | "follow_up";
  }): Promise<boolean>;
  manage(args: { jobId: string; action: "pause" | "resume" | "stop" }): Promise<boolean>;
  scheduleAdd(args: { schedule: string; prompt: string }): Promise<boolean>;
  scheduleCancel(args: { jobId: string }): Promise<boolean>;
}

export function useHeartbeats(threadId: string): HeartbeatsPanel {
  const rpc = useRpc<typeof primeHeartbeatsRpcContract>();
  const [status, setStatus] = useState<HeartbeatsStatus>({ kind: "loading" });
  const activeSessionIdRef = useRef<string | null>(null);
  const dirtyRef = useRef(false);
  const inFlightRef = useRef(false);
  const [pending, setPending] = useState<HeartbeatAction | undefined>();
  const [failure, setFailure] = useState<string | undefined>();

  const fetchList = useCallback(async () => {
    if (inFlightRef.current) {
      dirtyRef.current = true;
      return;
    }
    inFlightRef.current = true;
    try {
      do {
        dirtyRef.current = false;
        const activeSessionId = activeSessionIdRef.current ?? undefined;
        const answer: HeartbeatsList = await rpc.call("list", {
          threadId,
          ...(activeSessionId === undefined ? {} : { activeSessionId }),
        });
        if (answer.activeSessionId !== null) {
          activeSessionIdRef.current = answer.activeSessionId;
        }
        setStatus({ kind: "ready", list: answer });
      } while (dirtyRef.current);
    } catch (error) {
      setStatus({
        kind: "unavailable",
        message:
          error instanceof Error
            ? error.message
            : "The Heartbeats panel could not read the session's heartbeats.",
      });
    } finally {
      inFlightRef.current = false;
    }
  }, [rpc, threadId]);

  useEffect(() => {
    void fetchList();
  }, [fetchList]);

  // prime's `heartbeats_changed` push is global: any heartbeat anywhere is a
  // hint to refetch, and the payload's session-lessness is why the refetch
  // scopes itself to this thread's session.
  useRealtime(
    HEARTBEATS_REALTIME_CHANNEL,
    useCallback(() => {
      void fetchList();
    }, [fetchList]),
  );

  // Heartbeat signals are ephemeral by design, so a reconnect is a gap: the
  // only catch-up is asking again.
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
    void fetchList();
  }, [connectionState, fetchList]);

  const run = useCallback(
    async (
      action: HeartbeatAction,
      call: (activeSessionId: string) => Promise<unknown>,
    ): Promise<boolean> => {
      const activeSessionId = activeSessionIdRef.current;
      if (activeSessionId === null) {
        setFailure("No prime session to act on yet.");
        return false;
      }
      setFailure(undefined);
      setPending(action);
      try {
        await call(activeSessionId);
        void fetchList();
        return true;
      } catch (error) {
        setFailure(
          error instanceof Error
            ? error.message
            : "prime-agent refused the action.",
        );
        return false;
      } finally {
        setPending(undefined);
      }
    },
    [fetchList],
  );

  const set = useCallback(
    (args: { schedule: string; prompt: string; deliveryMode: "steer" | "follow_up" }) =>
      run("set", (activeSessionId) =>
        rpc.call("set", {
          threadId,
          activeSessionId,
          schedule: args.schedule,
          prompt: args.prompt,
          deliveryMode: args.deliveryMode,
        }),
      ),
    [rpc, threadId, run],
  );

  const manage = useCallback(
    (args: { jobId: string; action: "pause" | "resume" | "stop" }) =>
      run(args.action, (activeSessionId) =>
        rpc.call("manage", {
          threadId,
          activeSessionId,
          jobId: args.jobId,
          action: args.action,
        }),
      ),
    [rpc, threadId, run],
  );

  const scheduleAdd = useCallback(
    (args: { schedule: string; prompt: string }) =>
      run("add", (activeSessionId) =>
        rpc.call("scheduleAdd", {
          threadId,
          activeSessionId,
          schedule: args.schedule,
          prompt: args.prompt,
        }),
      ),
    [rpc, threadId, run],
  );

  const scheduleCancel = useCallback(
    (args: { jobId: string }) =>
      run("cancel", (activeSessionId) =>
        rpc.call("scheduleCancel", {
          threadId,
          activeSessionId,
          jobId: args.jobId,
        }),
      ),
    [rpc, threadId, run],
  );

  return {
    status,
    activeSessionId: activeSessionIdRef.current,
    pending,
    failure,
    set,
    manage,
    scheduleAdd,
    scheduleCancel,
  };
}

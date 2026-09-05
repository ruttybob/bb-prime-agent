import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import type {
  ExperimentalHostRpcContext,
  ExperimentalHostWorkerLease,
} from "@get-bb/plugin-sdk";
import {
  primeSubagentsHostContract,
  primeSubagentsHostSignals,
} from "./contract.js";
import {
  createSubagentsBackendConnection,
  type SubagentsBackendConnection,
} from "./backend-connection.js";
import { isChildLive } from "./children.js";
import {
  steerCommand,
  steerDelivery,
  steerTarget,
  stopCommand,
  stopCancelled,
} from "./control.js";
import { SubagentsRoster } from "./roster.js";

/**
 * The `bb.host` entry's Subagents half (bbpa-ggf.9, control in bbpa-ggf.10):
 * one per-machine daemon client, one roster, and the host RPC the plugin
 * server asks for a panel's data and actions.
 *
 * The connection is built lazily on the first roster question — a host worker
 * that never served a panel never dials the daemon — and kept alive with a
 * worker-retention lease for as long as any session is watched, because the
 * pushes that keep a roster live arrive between calls. When the last watched
 * session goes (TTL sweep, session closed, dispose), the lease goes with it
 * and the daemon is free to stop the worker.
 *
 * The control actions ride the same connection and the same roster: a steer or
 * a stop first makes sure the session is watched (so an action names a child
 * this machine's daemon actually has), then sends prime's one command for it
 * (`send_message`, `cancel_rlm_child`) and reports what prime answered — a
 * refusal is an error, never a quiet success. Nothing here deletes: a stop is
 * `cancel_rlm_child`, and prime's `delete_rlm_subagent` has no caller.
 */

export interface PrimeSubagentsHostEntryArgs {
  /** Test seam: hand the roster a scripted connection. */
  createConnection?: () => SubagentsBackendConnection;
}

export function createPrimeSubagentsHostEntry(
  args: PrimeSubagentsHostEntryArgs = {},
) {
  let connection: SubagentsBackendConnection | undefined;
  let roster: SubagentsRoster | undefined;
  /** The worker-retention lease, held while any session is watched. */
  let lease: ExperimentalHostWorkerLease | undefined;
  /** The first handler call lends the entry its retention ability. */
  let retain: (() => ExperimentalHostWorkerLease) | undefined;
  /** … and its ability to push signals back to the plugin server. */
  let emit:
    | ((
        signal: keyof typeof primeSubagentsHostSignals,
        payload: {
          activeSessionId: string;
          children: ReturnType<SubagentsRoster["childrenOf"]>;
        },
      ) => Promise<void>)
    | undefined;

  function syncLease(): void {
    if (roster === undefined) {
      return;
    }
    if (roster.watched().length > 0) {
      lease ??= retain?.();
    } else {
      lease?.dispose();
      lease = undefined;
    }
  }

  /** The roster and the daemon wire it reads (and the control actions use). */
  interface SubagentsBackend {
    roster: SubagentsRoster;
    connection: SubagentsBackendConnection;
  }

  function backend(): SubagentsBackend {
    if (roster !== undefined && connection !== undefined) {
      return { roster, connection };
    }
    const built = args.createConnection?.() ?? createSubagentsBackendConnection();
    const created = new SubagentsRoster({
      request: (command, requestArgs) => built.request(command, requestArgs),
      subscribePush: (listener) => built.subscribePush(listener),
      onReconnect: (listener) => built.onReconnect(listener),
    });
    created.onChange((change) => {
      syncLease();
      if (emit === undefined) {
        return;
      }
      // Fire and forget: the roster stays correct on its own, and a server
      // that went away mid-push has nothing to receive it.
      emit("subagents.changed", {
        activeSessionId: change.activeSessionId,
        children: [...change.children],
      }).catch(() => {});
    });
    roster = created;
    connection = built;
    return { roster: created, connection: built };
  }

  /**
   * The watched roster a call acts on, plus the lease/signal abilities the
   * first call on this worker lends it (the roster's pushes keep the panel
   * live between calls, whatever the call was).
   */
  async function watched(
    activeSessionId: string,
    context: ExperimentalHostRpcContext<typeof primeSubagentsHostSignals>,
  ): Promise<{
    backend: SubagentsBackend;
    children: ReturnType<SubagentsRoster["childrenOf"]>;
  }> {
    const built = backend();
    retain ??= () => context.experimental_retainWorker();
    emit ??= (signal, payload) => context.experimental_emitSignal(signal, payload);
    const children = await built.roster.watch(activeSessionId);
    return { backend: built, children };
  }

  /** The child a control action names, or a legible refusal. */
  function childOrThrow(
    children: ReturnType<SubagentsRoster["childrenOf"]>,
    args: { activeSessionId: string; childId: string },
  ): ReturnType<SubagentsRoster["childrenOf"]>[number] {
    const child = children.find((candidate) => candidate.id === args.childId);
    if (child === undefined) {
      throw new Error(
        `prime-agent has no subagent "${args.childId}" in session ${args.activeSessionId}`,
      );
    }
    return child;
  }

  return experimental_defineHostEntry({
    contract: primeSubagentsHostContract,
    experimental_signals: primeSubagentsHostSignals,
    handlers: {
      "subagents.roster": async (input, context) => {
        const { children } = await watched(input.activeSessionId, context);
        return { children };
      },
      "subagents.steer": async (input, context) => {
        const { backend, children } = await watched(input.activeSessionId, context);
        const child = childOrThrow(children, input);
        if (!isChildLive(child)) {
          // prime would happily wake a finished child to deliver a message;
          // that is a side effect the panel never offered, so refuse here.
          throw new Error(
            `subagent "${child.label}" (${input.childId}) is ${child.status}, not running — there is nothing to steer`,
          );
        }
        const answer = await backend.connection.request(
          steerCommand({
            // Asserted against the roster: the child of *this* session, and
            // prime routes agent messages inside the nuclear family only.
            targetActiveSessionId: steerTarget(child),
            message: input.message,
            fromActiveSessionId: input.activeSessionId,
          }),
        );
        if (!answer.success) {
          throw new Error(
            `prime-agent refused to steer "${child.label}" (${input.childId}): ${answer.error ?? "unknown daemon error"}`,
          );
        }
        return { delivery: steerDelivery(answer.data) };
      },
      "subagents.stop": async (input, context) => {
        const { backend, children } = await watched(input.activeSessionId, context);
        const child = childOrThrow(children, input);
        const answer = await backend.connection.request(
          stopCommand({
            activeSessionId: input.activeSessionId,
            childId: input.childId,
          }),
        );
        if (!answer.success) {
          throw new Error(
            `prime-agent refused to stop "${child.label}" (${input.childId}): ${answer.error ?? "unknown daemon error"}`,
          );
        }
        return { cancelled: stopCancelled(answer.data) };
      },
    },
    async dispose() {
      lease?.dispose();
      lease = undefined;
      retain = undefined;
      await roster?.dispose();
      roster = undefined;
      connection?.dispose();
      connection = undefined;
    },
  });
}

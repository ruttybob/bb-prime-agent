import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import type { ExperimentalHostWorkerLease } from "@get-bb/plugin-sdk";
import {
  primeSubagentsHostContract,
  primeSubagentsHostSignals,
} from "./contract.js";
import {
  createSubagentsBackendConnection,
  type SubagentsBackendConnection,
} from "./backend-connection.js";
import { SubagentsRoster } from "./roster.js";

/**
 * The `bb.host` entry's Subagents half (bbpa-ggf.9): one per-machine daemon
 * client, one roster, and the host RPC the plugin server asks for a panel's
 * data.
 *
 * The connection is built lazily on the first roster question — a host worker
 * that never served a panel never dials the daemon — and kept alive with a
 * worker-retention lease for as long as any session is watched, because the
 * pushes that keep a roster live arrive between calls. When the last watched
 * session goes (TTL sweep, session closed, dispose), the lease goes with it
 * and the daemon is free to stop the worker.
 *
 * Strictly read-only: the roster attaches, listens, and detaches. prime's
 * `cancel_rlm_child`/`send_message` are bbpa-ggf.10's to wire.
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

  function backend(): SubagentsRoster {
    if (roster !== undefined) {
      return roster;
    }
    const built = args.createConnection?.() ?? createSubagentsBackendConnection();
    connection = built;
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
    return created;
  }

  return experimental_defineHostEntry({
    contract: primeSubagentsHostContract,
    experimental_signals: primeSubagentsHostSignals,
    handlers: {
      "subagents.roster": async (input, context) => {
        const subagents = backend();
        retain ??= () => context.experimental_retainWorker();
        emit ??= (signal, payload) => context.experimental_emitSignal(signal, payload);
        const children = await subagents.watch(input.activeSessionId);
        return { children };
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

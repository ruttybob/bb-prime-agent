import { PrimeDaemonClient } from "../daemon/client.js";
import type { DaemonCommandResult } from "../daemon/client.js";
import type { DaemonPushMessage } from "../daemon/protocol.js";
import { resolveDaemonSocketPath } from "../daemon/socket.js";

/**
 * The backend's own daemon connection (one per host worker process).
 *
 * The bridge process holds its own connection; a plugin backend cannot share
 * it across that process boundary, and prime's daemon is built for many
 * clients on one socket. This one is strictly read-only — `attach`, `detach`
 * and the pushes they deliver — and, like the bridge's, it sends **no
 * clientId**: the daemon journals *mutating* commands under
 * `(clientId, envelope id)` and replays recorded answers to a repeat, so an
 * ops client that reused a clientId could get an old response for a fresh
 * attach. With no clientId nothing is journaled and every command executes.
 *
 * A dropped socket reconnects within a bounded budget and tells the roster to
 * re-attach (the daemon forgets attaches on disconnect), mirroring prime's own
 * recovery model of "re-attach for a fresh snapshot".
 */

const RECONNECT_BUDGET_MS = 30_000;

export interface SubagentsBackendConnection {
  request(
    command: { type: string } & Record<string, unknown>,
    args?: { timeoutMs?: number },
  ): Promise<DaemonCommandResult>;
  subscribePush(listener: (message: DaemonPushMessage) => void): () => void;
  /** The connection came up (again): watched sessions must (re-)attach. */
  onReconnect(listener: () => void): () => void;
  /** For diagnostics and tests. */
  readonly describe: string;
  /** Close the socket and stop reconnecting. Idempotent. */
  dispose(): void;
}

export interface SubagentsBackendConnectionArgs {
  /** Overrides the default daemon socket (tests point it at a fixture). */
  socketPath?: string;
  /** Test seam: build the client instead of dialing a socket. */
  createClient?: (args: { socketPath: string }) => PrimeDaemonClient;
  reconnectBudgetMs?: number;
  /** Test seam: observe the bounded reconnect giving up. */
  onReconnectFailed?: (cause: string) => void;
}

export function createSubagentsBackendConnection(
  args: SubagentsBackendConnectionArgs = {},
): SubagentsBackendConnection {
  const socketPath = args.socketPath ?? resolveDaemonSocketPath();
  const reconnectBudgetMs = args.reconnectBudgetMs ?? RECONNECT_BUDGET_MS;
  const client =
    args.createClient?.({ socketPath }) ?? new PrimeDaemonClient({ socketPath });
  const pushListeners = new Set<(message: DaemonPushMessage) => void>();
  const reconnectListeners = new Set<() => void>();
  /** Single-flight connect, so concurrent requests never race the handshake. */
  let connecting: Promise<void> | undefined;
  /** The background reconnect after a peer close, also single-flight. */
  let reconnecting: Promise<void> | undefined;
  let disposed = false;

  function notifyReconnect(): void {
    for (const listener of reconnectListeners) {
      listener();
    }
  }

  function ensureConnected(): Promise<void> {
    if (client.hello !== undefined) {
      return Promise.resolve();
    }
    connecting ??= (async () => {
      try {
        await client.connect();
        notifyReconnect();
      } finally {
        connecting = undefined;
      }
    })();
    return connecting;
  }

  client.onPush = (message) => {
    for (const listener of pushListeners) {
      listener(message);
    }
  };

  client.onPeerClose(() => {
    if (disposed || reconnecting !== undefined) {
      return;
    }
    reconnecting = client
      .enableAutoReconnect({
        budgetMs: reconnectBudgetMs,
        onStatus: (status) => {
          if (status.status === "failed") {
            args.onReconnectFailed?.(status.cause);
          }
        },
      })
      .then(notifyReconnect)
      .catch(() => {
        // Bounded, and reported through onStatus; the next command retries.
      })
      .finally(() => {
        reconnecting = undefined;
      });
  });

  return {
    describe: `prime-agent daemon at ${socketPath}`,
    async request(command, requestArgs) {
      if (disposed) {
        throw new Error(
          `the subagents backend connection to ${socketPath} was disposed`,
        );
      }
      // An in-flight reconnect owns the socket; racing it with our own
      // connect would only fail both.
      if (reconnecting !== undefined) {
        await reconnecting;
      }
      await ensureConnected();
      return client.request(command, requestArgs);
    },
    subscribePush(listener) {
      pushListeners.add(listener);
      return () => {
        pushListeners.delete(listener);
      };
    },
    onReconnect(listener) {
      reconnectListeners.add(listener);
      return () => {
        reconnectListeners.delete(listener);
      };
    },
    dispose() {
      disposed = true;
      reconnectListeners.clear();
      pushListeners.clear();
      client.close();
    },
  };
}

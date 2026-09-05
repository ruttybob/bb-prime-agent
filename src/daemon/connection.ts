import type { DaemonCommandResult } from "./client.js";
import type { DaemonHello, DaemonPushMessage } from "./protocol.js";
import { createTransport, type DaemonCommand, type PrimeDaemonTransport } from "./transport.js";
import { resolveDaemonSocketPath } from "./socket.js";

/**
 * The bridge process's one daemon connection.
 *
 * prime-agent's daemon is a machine-level singleton: one socket, many sessions.
 * The bridge holds one connection, routes pushes to the session lane that owns
 * the `activeSessionId`, and reconnects with a bounded budget when the socket
 * drops. Commands are never replayed automatically — a lane that loses the wire
 * re-attaches (a fresh snapshot), which is prime's own recovery model.
 */

let transport: PrimeDaemonTransport | undefined;
let connecting: Promise<DaemonHello> | undefined;
const pushListeners = new Set<(message: DaemonPushMessage) => void>();

/** Test seam: force the next connection onto a given transport. */
let transportFactory:
  | ((args: { socketPath: string; clientId?: string }) => PrimeDaemonTransport)
  | undefined;

export function setPrimeDaemonTransportFactoryForTests(
  factory: ((args: { socketPath: string; clientId?: string }) => PrimeDaemonTransport) | undefined,
): void {
  transportFactory = factory;
  resetDaemonConnectionForTests();
}

export function resetDaemonConnectionForTests(): void {
  transport?.close();
  transport = undefined;
  connecting = undefined;
  pushListeners.clear();
}

function currentTransport(): PrimeDaemonTransport {
  if (transport === undefined) {
    transport = transportFactory === undefined
      ? createTransport({ socketPath: resolveDaemonSocketPath() })
      : transportFactory({ socketPath: resolveDaemonSocketPath() });
    transport.onPush((message) => {
      for (const listener of pushListeners) {
        listener(message);
      }
    });
  }
  return transport;
}

/** Connect (once) and settle only when the greeting has been validated. */
export async function ensureDaemonConnection(): Promise<DaemonHello> {
  const active = currentTransport();
  if (connecting === undefined) {
    connecting = active.connect().catch((error: unknown) => {
      connecting = undefined;
      transport?.close();
      transport = undefined;
      throw error;
    });
  }
  return connecting;
}

export async function daemonRequest(
  command: DaemonCommand,
  args?: { timeoutMs?: number },
): Promise<DaemonCommandResult> {
  await ensureDaemonConnection();
  return currentTransport().request(command, args);
}

export function onDaemonPush(
  listener: (message: DaemonPushMessage) => void,
): () => void {
  pushListeners.add(listener);
  return () => {
    pushListeners.delete(listener);
  };
}

export function daemonConnectionForTests(): PrimeDaemonTransport | undefined {
  return transport;
}

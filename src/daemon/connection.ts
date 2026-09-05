import type { DaemonCommandResult } from "./client.js";
import {
  helloWarnings,
  type DaemonHello,
  type DaemonPushMessage,
} from "./protocol.js";
import { createTransport, type DaemonCommand, type PrimeDaemonTransport } from "./transport.js";
import { resolveDaemonSocketPath } from "./socket.js";

/**
 * The bridge process's one daemon connection, and its resilience (bbpa-ggf.11).
 *
 * prime-agent's daemon is a machine-level singleton: one socket, many sessions.
 * The bridge holds one connection, routes pushes to the session lane that owns
 * the `activeSessionId`, and — when the socket drops under it (a daemon update
 * or restart mid-session) — wins it back with bounded, capped-backoff
 * reconnects. Commands are never replayed automatically: a request that was
 * already sent fails with the drop, and a lane that loses the wire re-attaches
 * (a fresh snapshot), which is prime's own recovery model.
 */

let transport: PrimeDaemonTransport | undefined;
let connecting: Promise<DaemonHello> | undefined;
let recovering = false;
const pushListeners = new Set<(message: DaemonPushMessage) => void>();
const connectionListeners = new Set<(event: DaemonConnectionEvent) => void>();

/**
 * What the shared wire did, broadcast to every live session lane and to the
 * bridge: the socket dropped, the daemon came back (with a fresh hello and its
 * drift verdict), or the recovery budget ran out.
 */
export type DaemonConnectionEvent =
  | { kind: "lost"; cause: string }
  | { kind: "restored"; hello: DaemonHello; warnings: string[] }
  | { kind: "unavailable"; cause: string };

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
  dropTransport();
  connecting = undefined;
  recovering = false;
  pushListeners.clear();
  connectionListeners.clear();
}

/** Tear the transport down deliberately: no recovery event, no reconnect. */
function dropTransport(): void {
  const closing = transport;
  transport = undefined;
  closing?.close();
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
    // A drop of the *current* transport is the one event that matters; a
    // deliberate close unsubscribes first (the socket client clears its
    // listeners on `close`), and a replaced transport is not this one.
    transport.onPeerClose?.((error) => {
      if (transport !== undefined && !recovering) {
        void handleLost(error);
      }
    });
  }
  return transport;
}

/**
 * Connect (once) and settle only when the greeting has been validated. While a
 * lost wire is recovering, callers park here until the daemon answers again —
 * a command that has not been sent yet is worth a bounded wait, whereas a sent
 * one is never replayed.
 */
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

/**
 * Subscribe to the shared wire's connection events: every live session lane
 * re-attaches off `restored`, settles its interrupted turn off `lost`, and
 * turns the fresh hello's drift verdict into a thread warning. Listeners are
 * drained synchronously, so a `restored` always reaches the lanes that are
 * alive when it fires.
 */
export function onDaemonConnectionEvent(
  listener: (event: DaemonConnectionEvent) => void,
): () => void {
  connectionListeners.add(listener);
  return () => {
    connectionListeners.delete(listener);
  };
}

function emitConnectionEvent(event: DaemonConnectionEvent): void {
  for (const listener of [...connectionListeners]) {
    try {
      listener(event);
    } catch {
      // A listener that throws must not take the recovery loop down with it.
    }
  }
}

/** The socket dropped under us: tell the lanes, then win the daemon back. */
async function handleLost(error: Error | undefined): Promise<void> {
  const active = transport;
  if (active === undefined) {
    return;
  }
  const cause = error?.message ?? "connection lost";
  recovering = true;
  connecting = undefined;
  emitConnectionEvent({ kind: "lost", cause });
  const recovery = recover(active);
  // The loop's own failure is broadcast as `unavailable`; this catch only keeps
  // it from surfacing as an unhandled rejection when nobody is parked on it.
  recovery.catch(() => {});
  connecting = recovery;
}

/**
 * One bounded recovery: reconnect with capped backoff, then hand the fresh
 * hello to every lane. Resolves with that hello, or rejects once the budget is
 * gone — after which the dead transport is dropped so the next request starts
 * a fresh, honestly-failing attempt instead of leaning on a corpse.
 */
async function recover(active: PrimeDaemonTransport): Promise<DaemonHello> {
  try {
    if (active.reconnect === undefined) {
      throw new Error(`${active.describe} cannot reconnect`);
    }
    const hello = await active.reconnect();
    recovering = false;
    if (transport === active) {
      connecting = Promise.resolve(hello);
    }
    emitConnectionEvent({
      kind: "restored",
      hello,
      warnings: helloWarnings(hello),
    });
    return hello;
  } catch (error) {
    recovering = false;
    connecting = undefined;
    if (transport === active) {
      dropTransport();
    }
    emitConnectionEvent({
      kind: "unavailable",
      cause: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export function daemonConnectionForTests(): PrimeDaemonTransport | undefined {
  return transport;
}

import { existsSync } from "node:fs";
import {
  describeHelloDrift,
  driftWarnings,
  type DaemonHello,
  type HelloDrift,
} from "./protocol.js";
import {
  DaemonHandshakeError,
  PrimeDaemonClient,
} from "./client.js";
import { resolveDaemonSocketPath } from "./socket.js";

const PROBE_TIMEOUT_MS = 2_000;

/**
 * What the daemon probe found. The probe is read-only by construction: it
 * connects, reads the greeting, and hangs up. It never spawns a daemon, never
 * sends a command, never replaces a stale or busy daemon, and never touches
 * the socket file — a foreign daemon is prime-agent's business, not ours
 * (ADR-0002, intent "Чужой stale-daemon").
 */
export type DaemonProbeResult =
  | {
      status: "unreachable";
      socketPath: string;
      reason: string;
    }
  | {
      status: "handshake_failed";
      socketPath: string;
      reason: string;
      rejection: DaemonHandshakeError["rejection"];
      hello?: DaemonHello;
    }
  | {
      status: "ok";
      socketPath: string;
      hello: DaemonHello;
      drift: HelloDrift;
      warnings: string[];
    };

export interface DaemonProbeArgs {
  /** Overrides the resolved socket path (tests, exotic installs). */
  socketPath?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/**
 * Say hello to the prime-agent daemon and report what answered. This is the
 * whole probe: one connect, one greeting, one disconnect.
 */
export async function probeDaemon(
  args: DaemonProbeArgs = {},
): Promise<DaemonProbeResult> {
  const socketPath = args.socketPath ?? resolveDaemonSocketPath(args.env);
  if (!existsSync(socketPath)) {
    return {
      status: "unreachable",
      socketPath,
      reason:
        "no daemon socket — prime-agent is not running (this probe never starts it)",
    };
  }
  const client = new PrimeDaemonClient({ socketPath });
  try {
    const hello = await client.connect(args.timeoutMs ?? PROBE_TIMEOUT_MS);
    return {
      status: "ok",
      socketPath,
      hello,
      drift: describeHelloDrift(hello),
      warnings: driftWarnings(hello),
    };
  } catch (error) {
    if (error instanceof DaemonHandshakeError) {
      return {
        status: "handshake_failed",
        socketPath,
        reason: error.message,
        rejection: error.rejection,
        ...(error.hello === undefined ? {} : { hello: error.hello }),
      };
    }
    return {
      status: "unreachable",
      socketPath,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    client.close();
  }
}

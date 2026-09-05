import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRIME_DAEMON_SOCKET_ENV } from "../vocabulary.js";

/**
 * Where prime-agent's daemon listens, mirroring prime's own
 * `defaultDaemonSocketPath()` (`dist/modes/daemon/daemon-socket.js`):
 * `os.tmpdir()/prime-agent-<uid>/daemon.sock`, or a named pipe on Windows.
 */
export function defaultDaemonSocketPath(): string {
  if (process.platform === "win32") {
    return "\\\\.\\pipe\\prime-agent-daemon";
  }
  const suffix =
    typeof process.getuid === "function" ? String(process.getuid()) : "user";
  return join(tmpdir(), `prime-agent-${suffix}`, "daemon.sock");
}

/**
 * The socket this bridge talks to. `BB_PRIME_AGENT_DAEMON_SOCKET` overrides
 * the default — it is declared in the provider's `env.passthrough` so the
 * daemon forwards it to the bridge process, and it is how tests point the
 * client at a fixture socket instead of a real daemon.
 */
export function resolveDaemonSocketPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env[PRIME_DAEMON_SOCKET_ENV];
  if (typeof override === "string" && override.trim() !== "") {
    return override;
  }
  return defaultDaemonSocketPath();
}

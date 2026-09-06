import { homedir } from "node:os";
import {
  experimental_defineHostEntry,
  experimental_nativeRootsHostContract,
} from "@get-bb/plugin-sdk/host";
import { experimental_providerBridge } from "./src/provider-bridge.js";
import { resolvePrimeNativeRoots } from "./src/native-roots.js";
import { createPrimeSubagentsHostEntry } from "./src/subagents/host-entry.js";
import { createPrimeHeartbeatsHostEntry } from "./src/heartbeats/host-entry.js";
import { createSubagentsBackendConnection } from "./src/subagents/backend-connection.js";

/**
 * bb.host entry. The named export is the provider bridge — the artifact the
 * host daemon loads, verifies by digest, and imports; it must not start
 * anything at import time (the daemon owns the process boundary). The default
 * export is the host RPC entry, one executable carrying both halves:
 *
 * - the Subagents panel's per-machine backend (bbpa-ggf.9): one prime daemon
 *   client, the roster of each watched session's children, and the
 *   `subagents.roster` question the plugin server asks;
 * - the Heartbeats panel's per-machine half (bbpa-b1m.3, schedules bbpa-b1m.4):
 *   the heartbeat and schedule reads/actions for a session, over the SAME
 *   memoized daemon client (one socket per worker serves every panel), plus
 *   the `heartbeats_changed` push republished as a host signal;
 * - the native-roots resolver (bbpa-ggf.8): the prime-agent skill roots only
 *   this host can name — the skills entries of prime's user and project
 *   `settings.json` and the loose skill files of the two default skill
 *   directories (`src/native-roots.ts`). The workspace cwd comes from the
 *   request, so project-scoped entries count only for the workspace that
 *   holds them.
 *
 * The SDK defines a single host entry per plugin, and a contract is a record
 * of methods, so the two halves compose by spreading contracts and handlers.
 */
// One daemon connection for every panel half: memoized, so the first call
// dials and the rest reuse (dispose is idempotent, so either owner may close).
let sharedConnectionInstance: ReturnType<typeof createSubagentsBackendConnection> | undefined;
function sharedConnection(): ReturnType<typeof createSubagentsBackendConnection> {
  return (sharedConnectionInstance ??= createSubagentsBackendConnection());
}

const subagents = createPrimeSubagentsHostEntry({
  createConnection: () => sharedConnection(),
});
const heartbeats = createPrimeHeartbeatsHostEntry({
  createConnection: () => sharedConnection(),
});

export { experimental_providerBridge };

export default experimental_defineHostEntry({
  contract: {
    ...subagents.contract,
    ...heartbeats.contract,
    ...experimental_nativeRootsHostContract,
  },
  experimental_signals: {
    ...subagents.experimental_signals,
    ...heartbeats.experimental_signals,
  },
  handlers: {
    ...subagents.handlers,
    ...heartbeats.handlers,
    resolveNativeRoots: (input) =>
      resolvePrimeNativeRoots({
        homeDir: homedir(),
        cwd: input.cwd,
      }),
  },
  dispose: () => {
    const done = subagents.dispose?.();
    void heartbeats.dispose?.();
    return done;
  },
});

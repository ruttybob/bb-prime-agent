import { experimental_providerBridge } from "./src/provider-bridge.js";
import { createPrimeSubagentsHostEntry } from "./src/subagents/host-entry.js";

/**
 * bb.host entry. The named export is the provider bridge — the artifact the
 * host daemon loads, verifies by digest, and imports; it must not start
 * anything at import time (the daemon owns the process boundary). The default
 * export is the host RPC entry: the Subagents panel's per-machine backend
 * (bbpa-ggf.9) — one read-only prime daemon client, the roster of each watched
 * session's children, and the `subagents.roster` question the plugin server
 * asks. It gains `resolveNativeRoots` (prime's own skills/commands
 * directories) with the skills ticket, by composing the contracts there.
 */
export { experimental_providerBridge };

export default createPrimeSubagentsHostEntry();

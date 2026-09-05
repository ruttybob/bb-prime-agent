import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { experimental_providerBridge } from "./src/provider-bridge.js";

/**
 * bb.host entry. The named export is the provider bridge — the artifact the
 * host daemon loads, verifies by digest, and imports; it must not start
 * anything at import time (the daemon owns the process boundary). The default
 * export is the host RPC entry; it has no methods yet, and gains
 * `resolveNativeRoots` (prime's own skills/commands directories) with the
 * skills ticket.
 */
export { experimental_providerBridge };

export default experimental_defineHostEntry({
  contract: {},
  handlers: {},
});

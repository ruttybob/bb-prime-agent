import { homedir } from "node:os";
import {
  experimental_defineHostEntry,
  experimental_nativeRootsHostContract,
} from "@get-bb/plugin-sdk/host";
import { experimental_providerBridge } from "./src/provider-bridge.js";
import { resolvePrimeNativeRoots } from "./src/native-roots.js";

/**
 * bb.host entry. The named export is the provider bridge — the artifact the
 * host daemon loads, verifies by digest, and imports; it must not start
 * anything at import time (the daemon owns the process boundary). The default
 * export is the host RPC entry: it answers `resolveNativeRoots` (bbpa-ggf.8)
 * with the prime-agent skill roots only this host can name — the skills
 * entries of prime's user and project `settings.json` and the loose skill
 * files of the two default skill directories (`src/native-roots.ts`). The
 * workspace cwd comes from the request, so project-scoped entries count only
 * for the workspace that holds them.
 */
export { experimental_providerBridge };

export default experimental_defineHostEntry({
  contract: experimental_nativeRootsHostContract,
  handlers: {
    resolveNativeRoots: (input) =>
      resolvePrimeNativeRoots({
        homeDir: homedir(),
        cwd: input.cwd,
      }),
  },
});

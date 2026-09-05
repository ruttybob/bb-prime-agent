import type { PluginProviderDeclaration } from "@get-bb/plugin-sdk";
import { PRIME_NATIVE_ROOTS_DECLARATION } from "./native-roots-declaration.js";
import {
  enabledExtensionsProviderOptions,
  enabledUserExtensionPaths,
  type DiscoveredPrimeExtension,
} from "./user-extensions.js";
import {
  PRIME_DAEMON_SOCKET_ENV,
  PRIME_DISPLAY_NAME,
  PRIME_EXPIRED_HINT,
  PRIME_INSTALL_URL,
  PRIME_NO_SANDBOX_NOTICE,
  PRIME_PROVIDER_ID,
  PRIME_SIGN_IN_HINT,
} from "./vocabulary.js";
import {
  PRIME_QUEUE_EXTENSION_KIND_NAME,
  primeQueueStateSchema,
} from "./queue-state.js";

/**
 * The bb-side provider declaration.
 *
 * `experimental_visibility: "installed"` is the visibility contract: bb keeps
 * Prime Agent out of the picker until this plugin's bridge answers
 * `provider/health` with something other than `not_installed`, which the
 * daemon hello probe decides (`src/health.ts`). `maintenance.health: true`
 * must accompany it or the server skips the probe entirely.
 *
 * `deriveProviderOptions` is the extension picker's (bbpa-ggf.12) way onto the
 * wire: it turns the settings toggles into the enabled absolute paths, which
 * arrive at the bridge as `options.providerOptions[enabledExtensions]` on every
 * command. The bridge reads them on `thread/start` only, so the selection only
 * ever shapes a session being created.
 *
 * Permission modes are full-only and deliberately so: prime-agent has no
 * approval gate and no sandbox in 0.7.3 (the daemon's `create` takes no
 * permission config), and the intent rejects bb-side confirmation gates on
 * top — the trust notice below says so wherever bb renders provider copy.
 */
export function primeProviderDeclaration(
  args: { userExtensions?: readonly DiscoveredPrimeExtension[] } = {},
): PluginProviderDeclaration {
  const userExtensions = args.userExtensions ?? [];
  return {
    id: PRIME_PROVIDER_ID,
    displayName: PRIME_DISPLAY_NAME,
    icon: "./icons/prime-agent.svg",
    strings: {
      signInHint: PRIME_SIGN_IN_HINT,
      expiredHint: PRIME_EXPIRED_HINT,
      installUrl: PRIME_INSTALL_URL,
      // Shown on the plan-mode banner, one of the copy surfaces bb renders for
      // a provider; the trust model belongs in provider copy, not only in docs.
      planModeCopy: PRIME_NO_SANDBOX_NOTICE,
    },
    experimental_visibility: "installed",
    maintenance: { health: true, usage: false, installation: false },
    // prime's own skill directories (bbpa-ggf.8): bb indexes them into the
    // composer "/" menu beside its own skills, and resolves the host-only rest
    // (settings-configured roots, loose skill files) through this plugin's
    // `bb.host` entry (`src/native-roots.ts` has the contract and the paths).
    ...PRIME_NATIVE_ROOTS_DECLARATION,
    env: { passthrough: [PRIME_DAEMON_SOCKET_ENV] },
    capabilities: {
      supportsServiceTier: false,
      supportsNativeUserQuestion: false,
      // prime forks a session from an earlier message (`fork` at the entry a
      // checkpoint names, bbpa-ggf.7) — bb offers the fork-from-message flow.
      fork: "checkpoint",
      // Manual compaction is the standalone builtin `/compact` prompt, which
      // the bridge maps onto prime's `compact` command (bbpa-ggf.6); prime
      // also compacts on its own schedule (threshold/overflow).
      supportsManualCompaction: true,
      supportsThreadArchive: false,
      // Renames apply to prime's catalog name with the "[bb] " prefix kept.
      supportsThreadRename: true,
      // full-only, with the no-sandbox notice (see the module docs).
      permissionModes: ["full"],
      // prime's thinking ladder (pi-lineage `ThinkingLevel`), read-only onto
      // bb's reasoning levels; `set_thinking_level` applies it per session.
      reasoningLevels: ["none", "low", "medium", "high", "xhigh", "max"],
    },
    reasoningLevels: [
      { id: "none", label: "Off" },
      { id: "low", label: "Low" },
      { id: "medium", label: "Medium" },
      { id: "high", label: "High" },
      { id: "xhigh", label: "Extra High" },
      { id: "max", label: "Max" },
    ],
    composerActions: [],
    deriveProviderOptions(context) {
      // Fast by construction: the discovery snapshot is closed over, so this
      // (which sits on the turn-submit path) only filters an in-memory list.
      return enabledExtensionsProviderOptions(
        enabledUserExtensionPaths({ extensions: userExtensions, values: context.settings }),
      );
    },
    // The waiting-message lanes prime announces (`session_action_update`) are
    // surfaced as `extension.state` under `prime-agent/queue` (bbpa-ggf.5).
    // Without this declaration bb's server demotes the payloads to
    // `provider/unhandled` at ingest.
    extensionKinds: {
      [PRIME_QUEUE_EXTENSION_KIND_NAME]: { state: primeQueueStateSchema },
    },
  };
}

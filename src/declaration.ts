import type { PluginProviderDeclaration } from "@get-bb/plugin-sdk";
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
 * Permission modes are full-only and deliberately so: prime-agent has no
 * approval gate and no sandbox in 0.7.3 (the daemon's `create` takes no
 * permission config), and the intent rejects bb-side confirmation gates on
 * top — the trust notice below says so wherever bb renders provider copy.
 */
export function primeProviderDeclaration(): PluginProviderDeclaration {
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
    env: { passthrough: [PRIME_DAEMON_SOCKET_ENV] },
    capabilities: {
      supportsServiceTier: false,
      supportsNativeUserQuestion: false,
      // prime can fork a session from a message (`fork` + fork points), but
      // the wiring is bbpa-ggf.3; the handshake narrows this to "none" today.
      fork: "none",
      // prime compacts on its own schedule (`set_auto_compaction`); manual
      // compaction lands with the resident-session work.
      supportsManualCompaction: false,
      supportsThreadArchive: false,
      supportsThreadRename: false,
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
    // The waiting-message lanes prime announces (`session_action_update`) are
    // surfaced as `extension.state` under `prime-agent/queue` (bbpa-ggf.5).
    // Without this declaration bb's server demotes the payloads to
    // `provider/unhandled` at ingest.
    extensionKinds: {
      [PRIME_QUEUE_EXTENSION_KIND_NAME]: { state: primeQueueStateSchema },
    },
  };
}

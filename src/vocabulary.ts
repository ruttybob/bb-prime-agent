/**
 * Shared identifiers and copy for the prime-agent provider.
 *
 * Plugin id: the manifest name minus the `bb-plugin-` prefix → `prime-agent`.
 * The provider id equals the plugin id (draft naming in the intent, confirmed
 * here): threads persist it, so it must never change.
 */

export const PRIME_PLUGIN_ID = "prime-agent";
export const PRIME_PROVIDER_ID = "prime-agent";
export const PRIME_DISPLAY_NAME = "Prime Agent";

/**
 * The provider thread id the bridge mints (`prime_<activeSessionId>`): the
 * daemon-derived half names the resident session, which is how the Subagents
 * panel gets from a bb thread to a roster.
 */
export const PRIME_PROVIDER_THREAD_PREFIX = "prime_";

/**
 * Operator override for the daemon socket; declared in the provider's
 * `env.passthrough` so the daemon forwards it into the bridge process.
 */
export const PRIME_DAEMON_SOCKET_ENV = "BB_PRIME_AGENT_DAEMON_SOCKET";

/** How to sign in to prime-agent (inside its own TUI; bb never logs in for you). */
export const PRIME_SIGN_IN_HINT =
  "Start `prime-agent` on this machine and run `/login` inside it — bb talks to the same signed-in daemon.";

/** prime-agent sessions do not expire; the daemon does go away when prime quits. */
export const PRIME_EXPIRED_HINT =
  "prime-agent sessions do not expire. If the daemon stopped (prime-agent quit or was updated), start `prime-agent` once and try again.";

/** The official installer (prime-agent is not on npm; bb never installs it for you). */
export const PRIME_INSTALL_URL = "https://app.primeintellect.ai/prime-agent/install.sh";

/**
 * The trust model, stated where a user can see it: prime-agent has no approval
 * gate or sandbox, and bb deliberately adds none on top (intent, "Trust").
 */
export const PRIME_NO_SANDBOX_NOTICE =
  "prime-agent runs without a sandbox: model-generated code executes with your user permissions, and bb adds no confirmation gates on top.";

/**
 * The realtime channel the plugin server republishes host roster changes on
 * (bbpa-ggf.9). Plain data on purpose, so the frontend can subscribe without
 * bundling the subagents contracts' zod trees.
 */
export const SUBAGENTS_REALTIME_CHANNEL = "subagents";

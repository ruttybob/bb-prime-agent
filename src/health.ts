import type {
  ProviderHealth,
  ProviderHealthResult,
} from "@get-bb/plugin-sdk/provider-bridge";
import {
  CALIBRATED_APP_VERSION,
  DAEMON_MIN_PROTOCOL_VERSION,
} from "./daemon/protocol.js";
import { probeDaemon, type DaemonProbeArgs } from "./daemon/probe.js";
import { PRIME_INSTALL_URL } from "./vocabulary.js";

/** This provider always supports the health surface, so the answer is never `{supported: false}`. */
export type PrimeHealthResult = Extract<ProviderHealthResult, { supported: true }>;

/** The health statuses the probe can produce. */
export type PrimeHealthStatus = ProviderHealth["status"];

/**
 * The oldest prime-agent this bridge will call ready. prime moves fast and the
 * daemon protocol is not a published contract (ADR-0002), so this is the
 * calibrated release rather than a deep compatibility promise: newer releases
 * warn, they do not block.
 */
export const PRIME_MINIMUM_SUPPORTED_VERSION = CALIBRATED_APP_VERSION;

const HEALTH_CACHE_TTL_MS = 5_000;

function primeHealth(
  status: PrimeHealthStatus,
  args: {
    installedVersion?: string | null;
    statusMessage?: string | null;
  } = {},
): PrimeHealthResult {
  return {
    supported: true,
    health: {
      status,
      statusMessage: args.statusMessage ?? null,
      // prime-agent has no account/plan surface a daemon hello could see.
      accountEmail: null,
      planLabel: null,
      installedVersion: args.installedVersion ?? null,
      minimumSupportedVersion: PRIME_MINIMUM_SUPPORTED_VERSION,
      // bb never installs or updates prime-agent (intent: the official
      // installer stays the only install path).
      canInstall: false,
      canUpdate: false,
      loginCommand: "prime-agent",
    },
  };
}

const INSTALL_GUIDANCE = `Install prime-agent ${PRIME_MINIMUM_SUPPORTED_VERSION} or newer: ${PRIME_INSTALL_URL}`;

function installGuidance(): string {
  return INSTALL_GUIDANCE;
}

/**
 * Map a daemon probe onto the provider health bb renders. The mapping is the
 * visibility contract: only `not_installed` hides the provider from the
 * picker, so it is reserved for "nothing to talk to". Everything else keeps
 * the provider listed with a legible message — protocol drift warns, it never
 * blocks a thread (ADR-0002).
 *
 * - `unreachable` (no socket, nothing listening) → `not_installed`
 * - greeting below the protocol floor → `unsupported_version`
 * - greeting that parses but fails validation → `unknown`
 * - valid greeting → `ready`, with drift warnings in `statusMessage`
 */
export async function primeProviderHealth(
  args: DaemonProbeArgs = {},
): Promise<PrimeHealthResult> {
  const probe = await probeDaemon(args);
  switch (probe.status) {
    case "unreachable":
      return primeHealth("not_installed", {
        statusMessage: `No prime-agent daemon answered at ${probe.socketPath} (${probe.reason}). Start prime-agent once, or install it: ${installGuidance()}`,
      });
    case "handshake_failed": {
      if (probe.rejection.kind === "protocol_too_old") {
        const version = probe.hello?.appVersion ?? null;
        return primeHealth("unsupported_version", {
          installedVersion: version,
          statusMessage: `${version === null ? "The installed prime-agent" : `prime-agent ${version}`} speaks daemon protocol ${probe.rejection.protocolVersion}; this bridge needs ${DAEMON_MIN_PROTOCOL_VERSION} or newer. ${installGuidance()}`,
        });
      }
      return primeHealth("unknown", {
        installedVersion: probe.hello?.appVersion ?? null,
        statusMessage: `The prime-agent daemon at ${probe.socketPath} answered with a greeting this bridge cannot use: ${probe.reason}`,
      });
    }
    case "ok": {
      const version = probe.hello.appVersion;
      return primeHealth("ready", {
        installedVersion: version ?? null,
        statusMessage:
          probe.warnings.length === 0
            ? null
            : `${version === undefined ? "prime-agent" : `prime-agent ${version}`} is ready; ${probe.warnings.join(" ")}`,
      });
    }
  }
}

/**
 * bb polls provider health (picker, provider page, thread starts). Each probe
 * is a real connect, so answers are memoized briefly per socket path.
 */
const healthCache = new Map<
  string,
  { expiresAt: number; result: Promise<PrimeHealthResult> }
>();

export function primeProviderHealthCached(
  args: DaemonProbeArgs = {},
): Promise<PrimeHealthResult> {
  const socketPath = args.socketPath ?? null;
  const key = socketPath ?? "default";
  const now = Date.now();
  const cached = healthCache.get(key);
  if (cached !== undefined && cached.expiresAt > now) {
    return cached.result;
  }
  const result = primeProviderHealth(args);
  healthCache.set(key, { expiresAt: now + HEALTH_CACHE_TTL_MS, result });
  result.catch(() => {
    const entry = healthCache.get(key);
    if (entry !== undefined && entry.result === result) {
      healthCache.delete(key);
    }
  });
  return result;
}

export function resetPrimeHealthCacheForTests(): void {
  healthCache.clear();
}

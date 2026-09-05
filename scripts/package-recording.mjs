#!/usr/bin/env node
/**
 * Package (or refresh) the plugin's committed recording cell.
 *
 * Usage:
 *   BBPA_LIVE_DAEMON=1 BBPA_LIVE_RECORD_DIR=<cell dir> npx vitest run \
 *     provider-bridge.live.test.ts
 *   node scripts/package-recording.mjs [<cell dir>]
 *
 * The live test writes all four lanes; this script re-runs the *current* bridge
 * against the recorded runtime lane and pins what it produced as
 * `bridge→runtime.current.ndjson` beside them — the plan the parity test
 * replays against. Run it from the plugin root after a live recording.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  experimental_rerecordCurrentBridgeLane as rerecordCurrentBridgeLane,
  experimental_resolveProviderBridgeLaunch as resolveProviderBridgeLaunch,
  experimental_createBridgeDeltaEventCollector as createBridgeDeltaEventCollector,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
// Plain literals: this script runs on bare node (the plugin's TS sources are
// not importable from .mjs), so keep the two constants it needs in sync with
// src/daemon/transport.ts and src/vocabulary.ts by way of this comment.
const PRIME_DAEMON_REPLAY_CELL_ENV = "BB_PRIME_AGENT_DAEMON_REPLAY_CELL";
const PRIME_PROVIDER_ID = "prime-agent";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const defaultCell = join(packageRoot, "recordings", PRIME_PROVIDER_ID, "live-turn");
const cellDir = resolve(process.argv[2] ?? defaultCell);

// Replay the *built* artifact — the same bytes the host daemon verifies and
// runs — so the parity lane proves something about the shipped bridge.
const launch = resolveProviderBridgeLaunch({
  modulePath: join(packageRoot, "dist", "host.js"),
  pluginId: PRIME_PROVIDER_ID,
  bootstrapPath: new URL(
    "../node_modules/@get-bb/plugin-sdk/dist/provider-bridge-worker-entry.mjs",
    import.meta.url,
  ).pathname,
});
// The replayed bridge must speak to the recorded daemon, never to the machine's.
launch.env[PRIME_DAEMON_REPLAY_CELL_ENV] = cellDir;

const result = await rerecordCurrentBridgeLane({
  recordingDir: cellDir,
  providerId: PRIME_PROVIDER_ID,
  bridge: launch,
  createAssembler: (providerId) => {
    const collector = createBridgeDeltaEventCollector(providerId);
    return { assembleMessage: (message) => collector.assembleMessage(message) };
  },
  timeoutMs: 120_000,
  onStderr: (text) => process.stderr.write(`[bridge] ${text}`),
});

if (result.file === null) {
  console.error(`re-recording failed:\n${result.stalls.join("\n")}`);
  process.exit(1);
}
console.info(
  `pinned ${result.file}: ${result.lines} lines, ${result.events} assembled events`,
);

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CURRENT_BRIDGE_LANE_FILE,
  experimental_assembleRecordedEvents as assembleRecordedEvents,
  experimental_checkRecordedCellReplay as checkRecordedCellReplay,
  experimental_compareParity as compareParity,
  experimental_createBridgeDeltaEventCollector as createBridgeDeltaEventCollector,
  experimental_formatConformanceReport as formatConformanceReport,
  experimental_listRecordedCells as listRecordedCells,
  experimental_readBridgeRecording as readBridgeRecording,
  experimental_replayRecording as replayRecording,
  experimental_resolveProviderBridgeLaunch as resolveProviderBridgeLaunch,
  experimental_withCurrentBridgeLane as withCurrentBridgeLane,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import type {
  CreateParityAssembler,
  RecordedCell,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import { PRIME_DAEMON_REPLAY_CELL_ENV } from "./src/daemon/transport.js";
import { PRIME_PROVIDER_ID } from "./src/vocabulary.js";

/**
 * The recorded lane, replayed.
 *
 * The cell under `recordings/prime-agent/live-turn/` was captured against the
 * machine's real prime-agent daemon (see `provider-bridge.live.test.ts`). The
 * replay feeds the recorded `runtime→bridge` lane to the bridge and serves the
 * recorded daemon wire back through the bridge's replay transport
 * (`BB_PRIME_AGENT_DAEMON_REPLAY_CELL`), so parity is checked with no daemon
 * and no prime install.
 *
 * The bridge under test is the *built* artifact (`dist/host.js`, as the host
 * daemon runs it): the published SDK resolves to ESM bundles that only work
 * bundled, so a source-level replay is not a thing for an installed SDK. Run
 * `bb plugin build` first; `scripts/package-recording.mjs` re-pins the current
 * lane after the bridge changes.
 */

const packageRoot = dirname(fileURLToPath(import.meta.url));
const RECORDINGS_ROOT = join(packageRoot, "recordings");
const BUILT_BRIDGE = join(packageRoot, "dist", "host.js");
const WORKER_ENTRY = join(
  packageRoot,
  "node_modules",
  "@get-bb",
  "plugin-sdk",
  "dist",
  "provider-bridge-worker-entry.mjs",
);

const cells = listRecordedCells(RECORDINGS_ROOT);

function cellKey(cell: RecordedCell): string {
  return `${cell.provider}/${cell.cell}`;
}

const createAssembler: CreateParityAssembler = (providerId) => {
  const collector = createBridgeDeltaEventCollector(providerId);
  return { assembleMessage: (message) => collector.assembleMessage(message) };
};

function launchFor(cell: RecordedCell) {
  const launch = resolveProviderBridgeLaunch({
    modulePath: BUILT_BRIDGE,
    pluginId: PRIME_PROVIDER_ID,
    bootstrapPath: WORKER_ENTRY,
  });
  // The replayed bridge speaks to the recorded daemon, never the machine's.
  launch.env[PRIME_DAEMON_REPLAY_CELL_ENV] = cell.dir;
  return launch;
}

describe("the committed live recording", () => {
  it("ships exactly the live-turn cell", () => {
    expect(cells.map(cellKey)).toEqual(["prime-agent/live-turn"]);
    const manifest = readBridgeRecording(cells[0]!.dir).manifest;
    expect(manifest).toMatchObject({
      provider: PRIME_PROVIDER_ID,
      cell: "live-turn",
      scope: "thread",
    });
  });

  it.each(cells.map((cell) => [cellKey(cell), cell] as const))(
    "%s assembles a clean timeline and replays through the built bridge with zero diffs",
    async (_key, cell) => {
      const recorded = assembleRecordedEvents(
        withCurrentBridgeLane(readBridgeRecording(cell.dir)),
        createAssembler,
        cell.provider,
      );
      expect(recorded.invalidDeltas).toEqual([]);
      expect(recorded.grammarViolations).toEqual([]);

      // The recorded turns: the first opened, streamed prime's answer (and
      // its thinking, when the model chose to reason on this prompt),
      // reported token usage and completed; the second was interrupted by
      // the bridge's soft stop. Whether a lane carries thinking is a model
      // decision, so the reasoning-delta assertion only binds when the
      // recorded provider lane actually contains thinking blocks — the
      // mapping itself is pinned by the synthetic stream tests.
      const kinds = recorded.events.map((event) => event.type);
      expect(kinds.filter((type) => type === "turn/started")).toHaveLength(2);
      expect(kinds.filter((type) => type === "turn/completed")).toHaveLength(2);
      expect(kinds).toContain("item/agentMessage/delta");
      const providerLane = readFileSync(join(cell.dir, "provider→bridge.ndjson"), "utf8");
      if (providerLane.includes('"thinking"')) {
        expect(kinds).toContain("item/reasoning/textDelta");
      }
      expect(kinds).toContain("thread/tokenUsage/updated");
      const statuses = recorded.events
        .filter((event) => event.type === "turn/completed")
        .map((event) => event.status);
      expect(statuses).toEqual(["completed", "interrupted"]);

      const run = await replayRecording({
        recordingDir: cell.dir,
        providerId: cell.provider,
        bridge: launchFor(cell),
        createAssembler,
        planFromCurrentLane: true,
        timeoutMs: 60_000,
        onStderr: (text) => process.stderr.write(`[bridge] ${text}`),
      });
      expect(run.stalls).toEqual([]);
      expect(run.exitCode).toBe(0);

      const comparison = compareParity(
        {
          events: recorded.events,
          rows: [],
          grammarViolations: recorded.grammarViolations,
        },
        {
          events: run.events,
          rows: [],
          grammarViolations: run.grammarViolations,
        },
        [],
        { provider: cell.provider, cell: cell.cell },
      );
      expect(comparison.events).toEqual({ onlyInOld: [], onlyInNew: [] });
      expect(comparison.grammar).toEqual({ onlyInOld: [], onlyInNew: [] });
      expect(comparison.passed).toBe(true);
      expect(run.events.length).toBe(recorded.events.length);

      const results = checkRecordedCellReplay({
        provider: cell.provider,
        cell: cell.cell,
        events: run.events,
        recordedEvents: recorded.events,
        stalls: run.stalls,
      });
      console.info(
        `prime-agent recorded replay:\n${formatConformanceReport({
          results,
          passed: results.every((result) => result.status === "pass"),
        })}`,
      );
      expect(
        results
          .filter((result) => result.status !== "pass")
          .map((result) => `${result.id}: ${result.detail}`),
      ).toEqual([]);
    },
    120_000,
  );

  it("tells the developer to build the artifact the parity lane needs", () => {
    // The replay is only meaningful against the artifact the daemon runs, so a
    // missing build is a setup gap, not a silent skip.
    expect(
      existsSync(BUILT_BRIDGE),
      "run `bb plugin build` — the parity lane replays dist/host.js",
    ).toBe(true);
    expect(existsSync(join(cells[0]!.dir, CURRENT_BRIDGE_LANE_FILE))).toBe(true);
  });
});

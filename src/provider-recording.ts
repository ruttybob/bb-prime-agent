import { mkdirSync, openSync, closeSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Provider-side recording lanes.
 *
 * Record mode (`BB_PROVIDER_BRIDGE_RECORD_DIR`, set by the host daemon) already
 * tees the two bridge↔runtime lanes. This bridge has no provider *child* to
 * hand to `experimental_recordProviderChildIo` — its provider is a daemon
 * reached over a unix socket — so it tees those two lanes itself, in the same
 * NDJSON entry format the runtime writes, so a recorded cell carries all four
 * boundaries:
 *
 *     {"ts","run","seq","dir","line"}   with dir ∈ provider→bridge | bridge→provider
 *
 * The daemon connection is shared by every bb thread in the process, so the
 * lanes are process-scoped (`_process`, the recorder's own scope segment rule)
 * rather than attributed per thread. Packaging a cell flattens them next to the
 * runtime lanes.
 */

export const PROVIDER_RECORD_DIR_ENV = "BB_PROVIDER_BRIDGE_RECORD_DIR";
export const PROCESS_SCOPE_SEGMENT = "_process";

export type ProviderLaneDirection = "provider→bridge" | "bridge→provider";

export interface ProviderLaneRecorder {
  write(direction: ProviderLaneDirection, line: string): void;
  close(): void;
}

/** Whether record mode is on in this bridge process. */
export function recordDirFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const dir = env[PROVIDER_RECORD_DIR_ENV];
  if (dir === undefined || dir.trim() === "") {
    return undefined;
  }
  return dir.trim();
}

export function createProviderLaneRecorder(args: {
  dir: string;
}): ProviderLaneRecorder {
  const dir = resolve(args.dir);
  const scopeDir = join(dir, PROCESS_SCOPE_SEGMENT);
  const fds = new Map<ProviderLaneDirection, number>();
  const run = Date.now();
  let seq = 0;
  let closed = false;
  function fdFor(direction: ProviderLaneDirection): number {
    const existing = fds.get(direction);
    if (existing !== undefined) {
      return existing;
    }
    mkdirSync(scopeDir, { recursive: true });
    const fd = openSync(join(scopeDir, `${direction}.ndjson`), "a");
    fds.set(direction, fd);
    return fd;
  }
  return {
    write(direction, line) {
      if (closed) {
        return;
      }
      seq += 1;
      const entry = { ts: Date.now(), run, seq, dir: direction, line };
      try {
        writeSync(fdFor(direction), `${JSON.stringify(entry)}\n`);
      } catch (error) {
        process.stderr.write(
          `prime-agent bridge: failed to record the ${direction} lane: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
      }
    },
    close() {
      closed = true;
      for (const fd of fds.values()) {
        try {
          closeSync(fd);
        } catch {
          // Already closed by the process teardown; nothing to report.
        }
      }
      fds.clear();
    },
  };
}

/** The recorder for this process, or `null` when record mode is off. */
export function providerLaneRecorder(): ProviderLaneRecorder | null {
  const dir = recordDirFromEnv();
  if (dir === undefined) {
    return null;
  }
  const key = RECORDING_SLOT_KEY;
  const holder = globalThis as Record<symbol, unknown>;
  const existing = holder[key];
  if (existing instanceof ProviderRecorderSlot) {
    return existing.recorder;
  }
  const slot = new ProviderRecorderSlot(createProviderLaneRecorder({ dir }));
  holder[key] = slot;
  return slot.recorder;
}

/** One recorder per process, however many modules ask. */
const RECORDING_SLOT_KEY = Symbol.for("bb.primeAgent.providerLaneRecorder");

class ProviderRecorderSlot {
  constructor(readonly recorder: ProviderLaneRecorder) {}
}

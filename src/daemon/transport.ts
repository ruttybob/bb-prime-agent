import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PrimeDaemonClient,
  type DaemonCommandResult,
} from "./client.js";
import type { DaemonHello, DaemonPushMessage } from "./protocol.js";
import {
  providerLaneRecorder,
  type ProviderLaneRecorder,
} from "../provider-recording.js";

/**
 * The daemon transport seam.
 *
 * The bridge talks to prime-agent's daemon over a unix socket in production.
 * Two other transports implement the same four methods so the rest of the
 * bridge never learns where its wire came from:
 *
 * - the socket transport, which also tees the provider lanes when record mode
 *   is on (`src/provider-recording.ts`);
 * - the replay transport, which serves a recorded cell's provider lanes back to
 *   the bridge so the committed recording replays hermetically (no daemon, no
 *   prime install) — this is what makes the parity lane a *test*, not a
 *   procedure.
 */

export interface DaemonCommand {
  type: string;
  [key: string]: unknown;
}

/** A command payload as it goes on the wire (plain JSON, no class shape). */
export function asWireCommand(
  command: object,
): { type: string } & Record<string, unknown> {
  return command as { type: string } & Record<string, unknown>;
}

export interface PrimeDaemonTransport {
  /** Where the wire came from, for error messages and tests. */
  readonly describe: string;
  connect(): Promise<DaemonHello>;
  request(command: DaemonCommand, args?: { timeoutMs?: number }): Promise<DaemonCommandResult>;
  onPush(listener: (message: DaemonPushMessage) => void): () => void;
  close(): void;
}

export function createSocketTransport(args: {
  socketPath: string;
  clientId?: string;
}): PrimeDaemonTransport {
  const client = new PrimeDaemonClient({
    socketPath: args.socketPath,
    clientId: args.clientId,
  });
  const recorder: ProviderLaneRecorder | null = providerLaneRecorder();
  if (recorder !== null) {
    client.onWireWrite = (line) => recorder.write("bridge→provider", line);
    client.onWireRead = (line) => recorder.write("provider→bridge", line);
  }
  return {
    describe: `prime-agent daemon at ${args.socketPath}`,
    async connect() {
      return client.connect();
    },
    async request(command, requestArgs) {
      return client.request(command, requestArgs);
    },
    onPush(listener) {
      const previous = client.onPush;
      client.onPush = previous
        ? (message) => {
            previous(message);
            listener(message);
          }
        : listener;
      return () => {
        client.onPush = previous;
      };
    },
    close() {
      recorder?.close();
      client.close();
    },
  };
}

/* ------------------------------- replay ------------------------------- */

/**
 * Points the bridge at a recorded cell's provider lanes instead of a daemon.
 * Set into the bridge process environment by the replay test
 * (`provider-bridge.parity.test.ts`), exactly the way a spawned provider child
 * is pointed at the kit's replay script.
 */
export const PRIME_DAEMON_REPLAY_CELL_ENV = "BB_PRIME_AGENT_DAEMON_REPLAY_CELL";

interface RecordedLaneEntry {
  run: number;
  seq: number;
  dir: string;
  line: string;
}

function readLane(cellDir: string, direction: string): RecordedLaneEntry[] {
  const file = join(cellDir, `${direction}.ndjson`);
  if (!existsSync(file)) {
    return [];
  }
  const entries: RecordedLaneEntry[] = [];
  for (const [index, raw] of readFileSync(file, "utf8").split("\n").entries()) {
    if (raw.length === 0) {
      continue;
    }
    let entry: unknown;
    try {
      entry = JSON.parse(raw);
    } catch {
      throw new Error(`${file}:${index + 1} is not a recording entry`);
    }
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`${file}:${index + 1} is not a recording entry`);
    }
    const candidate = entry as Record<string, unknown>;
    if (candidate.dir !== direction || typeof candidate.line !== "string") {
      throw new Error(`${file}:${index + 1} is not a ${direction} entry`);
    }
    entries.push({
      run: typeof candidate.run === "number" ? candidate.run : 0,
      seq: typeof candidate.seq === "number" ? candidate.seq : 0,
      dir: direction,
      line: candidate.line,
    });
  }
  return entries;
}

function parseLine(line: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

interface ReplayBlock {
  commandType: string;
  entries: Array<Record<string, unknown>>;
}

/**
 * Serves the recorded wire back, block by block: each recorded command
 * (`bridge→provider`) heads a block holding its response and every push that
 * arrived with it (`provider→bridge`), so the replayed bridge sees the
 * recorded ordering without a daemon. Commands are matched by type in recorded
 * order — a bridge that drifts from what it recorded stalls loudly instead of
 * inventing traffic.
 */
export function createReplayTransport(args: {
  cellDir: string;
}): PrimeDaemonTransport {
  const cellDir = args.cellDir;
  const merged = [
    ...readLane(cellDir, "provider→bridge"),
    ...readLane(cellDir, "bridge→provider"),
  ].sort((left, right) =>
    left.run === right.run ? left.seq - right.seq : left.run - right.run,
  );
  const listeners = new Set<(message: DaemonPushMessage) => void>();
  const leading: Array<Record<string, unknown>> = [];
  const blocks: ReplayBlock[] = [];
  for (const entry of merged) {
    const message = parseLine(entry.line);
    if (message === null) {
      continue;
    }
    if (entry.dir === "bridge→provider") {
      // The recorded line is a command envelope: `{type:"command", id, command:{type,…}}`.
      const command = message.command;
      const type =
        typeof command === "object" &&
        command !== null &&
        typeof (command as Record<string, unknown>).type === "string"
          ? String((command as Record<string, unknown>).type)
          : "unknown";
      blocks.push({ commandType: type, entries: [] });
      continue;
    }
    if (message.type === "daemon_hello") {
      continue;
    }
    if (blocks.length === 0) {
      leading.push(message);
      continue;
    }
    blocks[blocks.length - 1]!.entries.push(message);
  }
  let hello: DaemonHello | undefined;
  for (const entry of merged) {
    const message = parseLine(entry.line);
    if (message !== null && message.type === "daemon_hello") {
      hello = message as unknown as DaemonHello;
      break;
    }
  }
  let consumed = 0;
  function deliver(message: Record<string, unknown>): void {
    for (const listener of listeners) {
      listener(message as unknown as DaemonPushMessage);
    }
  }
  return {
    describe: `recorded provider lane in ${cellDir}`,
    async connect() {
      if (hello === undefined) {
        throw new Error(
          `the recorded cell at ${cellDir} carries no daemon greeting to replay`,
        );
      }
      for (const message of leading) {
        deliver(message);
      }
      return hello;
    },
    async request(command) {
      const index = blocks.findIndex(
        (block, position) =>
          position >= consumed && block.commandType === command.type,
      );
      if (index < 0) {
        throw new Error(
          `the recorded cell at ${cellDir} has no recorded "${command.type}" left to replay (consumed ${consumed} of ${blocks.length} blocks)`,
        );
      }
      consumed = index + 1;
      const block = blocks[index]!;
      let answered: DaemonCommandResult | undefined;
      for (const message of block.entries) {
        if (message.type === "response") {
          answered = {
            command: command.type,
            success: message.success === true,
            ...(message.data === undefined ? {} : { data: message.data }),
            ...(typeof message.error === "string" ? { error: message.error } : {}),
            ...(message.errorInfo === undefined
              ? {}
              : { errorInfo: message.errorInfo }),
          };
          continue;
        }
        deliver(message);
      }
      return (
        answered ?? {
          command: command.type,
          success: false,
          error: `the recorded "${command.type}" block carries no response`,
        }
      );
    },
    onPush(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      listeners.clear();
    },
  };
}

export interface TransportFactoryArgs {
  socketPath: string;
  clientId?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Which transport this bridge process uses. The replay cell wins when the test
 * asked for one; the socket is the only production path.
 */
export function createTransport(args: TransportFactoryArgs): PrimeDaemonTransport {
  const env = args.env ?? process.env;
  const cellDir = env[PRIME_DAEMON_REPLAY_CELL_ENV];
  if (typeof cellDir === "string" && cellDir.trim() !== "") {
    return createReplayTransport({ cellDir: cellDir.trim() });
  }
  return createSocketTransport({
    socketPath: args.socketPath,
    clientId: args.clientId,
  });
}

import { afterEach, describe, expect, it } from "vitest";
import {
  onDaemonConnectionEvent,
  daemonRequest,
  resetDaemonConnectionForTests,
  setPrimeDaemonTransportFactoryForTests,
  type DaemonConnectionEvent,
} from "./src/daemon/connection.js";
import type { DaemonHello, DaemonPushMessage } from "./src/daemon/protocol.js";
import type { PrimeDaemonTransport } from "./src/daemon/transport.js";
import { calibratedHello } from "./test-support/fake-daemon.js";
import { rejectionOf } from "./test-support/rejections.js";

/**
 * The shared connection's resilience loop (bbpa-ggf.11), driven by a transport
 * that drops and recovers on cue — the same seam the socket and replay
 * transports sit behind, so the loop is tested without a daemon.
 */

interface Wire {
  transport: PrimeDaemonTransport;
  /** Simulate the socket dying under the bridge. */
  drop(args?: { cause?: string }): void;
  /** The daemon answers again (with `hello`, when the test swapped it). */
  restore(args?: { hello?: DaemonHello }): void;
  /** The daemon never answers again: every reconnect attempt fails. */
  dead(): void;
  readonly connects: number;
  readonly sent: string[];
}

function makeWire(args: { hello?: DaemonHello } = {}): Wire {
  let hello = args.hello ?? (calibratedHello() as unknown as DaemonHello);
  let dropped = false;
  let dead = false;
  let connects = 0;
  const sent: string[] = [];
  const closeListeners = new Set<(error: Error | undefined) => void>();
  const pushListeners = new Set<(message: DaemonPushMessage) => void>();
  const transport: PrimeDaemonTransport = {
    describe: "switchable daemon wire",
    async connect() {
      connects += 1;
      return hello;
    },
    async request(command) {
      if (dropped) {
        throw new Error("the daemon wire is down");
      }
      const type = String((command as Record<string, unknown>).type);
      sent.push(type);
      return { command: type, success: true };
    },
    onPush(listener) {
      pushListeners.add(listener);
      return () => {
        pushListeners.delete(listener);
      };
    },
    onPeerClose(listener) {
      closeListeners.add(listener);
      return () => {
        closeListeners.delete(listener);
      };
    },
    async reconnect(reconnectArgs) {
      const budgetMs = reconnectArgs?.budgetMs ?? 2_000;
      const deadline = Date.now() + budgetMs;
      while (dropped && !dead && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      if (dropped || dead) {
        throw new Error(`gave up reconnecting after ${budgetMs}ms`);
      }
      return hello;
    },
    close() {
      dropped = false;
      closeListeners.clear();
      pushListeners.clear();
    },
  };
  return {
    transport,
    drop({ cause } = {}) {
      if (dropped) {
        return;
      }
      dropped = true;
      for (const listener of [...closeListeners]) {
        listener(new Error(cause ?? "wire dropped"));
      }
    },
    restore(args = {}) {
      if (args.hello !== undefined) {
        hello = args.hello;
      }
      dropped = false;
    },
    dead() {
      dead = true;
    },
    get connects() {
      return connects;
    },
    get sent() {
      return sent;
    },
  };
}

let wire: Wire | undefined;
const cleanups: Array<() => void> = [];

afterEach(() => {
  setPrimeDaemonTransportFactoryForTests(undefined);
  resetDaemonConnectionForTests();
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
  wire = undefined;
});

/** Records connection events and waits for the next one of a given shape. */
function recordEvents(): {
  collected: DaemonConnectionEvent[];
  waitFor: (kind: DaemonConnectionEvent["kind"]) => Promise<DaemonConnectionEvent>;
} {
  const collected: DaemonConnectionEvent[] = [];
  const unsubscribes = onDaemonConnectionEvent((event) => {
    collected.push(event);
  });
  cleanups.push(unsubscribes);
  const waitFor = async (
    kind: DaemonConnectionEvent["kind"],
  ): Promise<DaemonConnectionEvent> => {
    const deadline = Date.now() + 2_000;
    for (;;) {
      const found = collected.find((event) => event.kind === kind);
      if (found !== undefined) {
        return found;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `no ${kind} connection event within 2s (got: ${collected.map((event) => event.kind).join(", ")})`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  };
  return { collected, waitFor };
}

describe("the shared daemon connection", () => {
  it("connects lazily and answers commands", async () => {
    wire = makeWire();
    setPrimeDaemonTransportFactoryForTests(() => wire!.transport);
    await daemonRequest({ type: "list" });
    expect(wire.sent).toEqual(["list"]);
  });

  it("recovers a dropped wire with a fresh hello and announces it", async () => {
    wire = makeWire();
    setPrimeDaemonTransportFactoryForTests(() => wire!.transport);
    await daemonRequest({ type: "list" });
    const { collected, waitFor } = recordEvents();

    wire.drop({ cause: "daemon restart" });
    await waitFor("lost");
    wire.restore();
    const restored = await waitFor("restored");

    expect(collected.map((event) => event.kind)).toEqual(["lost", "restored"]);
    expect(collected[0]).toMatchObject({ kind: "lost", cause: "daemon restart" });
    expect(restored).toMatchObject({ kind: "restored" });
    if (restored.kind === "restored") {
      expect(restored.hello.protocol).toEqual({ name: "prime-agent.daemon", version: 7 });
      // The calibrated hello drifts about nothing.
      expect(restored.warnings).toEqual([]);
    }
    // Commands work again over the recovered wire — the same transport object,
    // the way the socket client survives a reconnect.
    await daemonRequest({ type: "get_state" });
    expect(wire.sent).toEqual(["list", "get_state"]);
  });

  it("carries the fresh hello's drift verdict on the restored event", async () => {
    wire = makeWire();
    setPrimeDaemonTransportFactoryForTests(() => wire!.transport);
    await daemonRequest({ type: "list" });
    const { waitFor } = recordEvents();

    wire.drop();
    wire.restore({
      hello: calibratedHello({ appVersion: "0.9.0", schemaRevision: 19 }) as unknown as DaemonHello,
    });
    const restored = await waitFor("restored");

    expect(restored.kind).toBe("restored");
    if (restored.kind === "restored") {
      expect(restored.warnings.join(" ")).toContain("0.9.0 is newer");
      expect(restored.warnings.join(" ")).toContain("revision 19");
    }
  });

  it("parks a command sent while the wire is down instead of failing it", async () => {
    wire = makeWire();
    setPrimeDaemonTransportFactoryForTests(() => wire!.transport);
    await daemonRequest({ type: "list" });
    const { waitFor } = recordEvents();

    wire.drop();
    const parked = daemonRequest({ type: "get_state" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Nothing was sent: a command that has not gone out waits for the wire.
    expect(wire.sent).toEqual(["list"]);

    wire.restore();
    await waitFor("restored");
    await parked;
    expect(wire.sent).toEqual(["list", "get_state"]);
  });

  it("announces the give-up, fails the parked command, and dials afresh afterwards", async () => {
    wire = makeWire();
    setPrimeDaemonTransportFactoryForTests(() => wire!.transport);
    await daemonRequest({ type: "list" });
    const { waitFor } = recordEvents();

    wire.drop();
    wire.dead();
    // `rejectionOf` attaches its handler now: the rejection is heard the moment
    // it happens, not two ticks later.
    const parked = rejectionOf(daemonRequest({ type: "get_state" }));

    const unavailable = await waitFor("unavailable");
    expect(unavailable).toMatchObject({ kind: "unavailable" });
    if (unavailable.kind === "unavailable") {
      expect(unavailable.cause).toContain("gave up reconnecting");
    }
    const error = await parked;
    expect(error.message).toContain("gave up reconnecting");

    // A later command does not lean on the dead transport: it dials again, and
    // the fresh greeting (however stale the daemon) is validated like the first.
    const connectsBefore = wire.connects;
    await daemonRequest({ type: "list" });
    expect(wire.connects).toBeGreaterThan(connectsBefore);
    expect(wire.sent).toContain("list");
  });

  it("does not announce a drop for a transport the bridge closed itself", async () => {
    wire = makeWire();
    setPrimeDaemonTransportFactoryForTests(() => wire!.transport);
    await daemonRequest({ type: "list" });
    const { collected } = recordEvents();

    resetDaemonConnectionForTests();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(collected).toEqual([]);
  });
});

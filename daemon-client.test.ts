import { afterEach, describe, expect, it } from "vitest";
import {
  DaemonCapabilityUnavailableError,
  DaemonConnectionClosedError,
  DaemonHandshakeError,
  PrimeDaemonClient,
} from "./src/daemon/client.js";
import { parseDaemonHello } from "./src/daemon/protocol.js";
import { calibratedHello, FakeDaemon } from "./test-support/fake-daemon.js";
import { rejectionOf } from "./test-support/rejections.js";

let daemon: FakeDaemon | undefined;

afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
});

describe("the daemon client handshake", () => {
  it("settles on the daemon's greeting and exposes it", async () => {
    daemon = await FakeDaemon.start();
    const client = new PrimeDaemonClient({ socketPath: daemon.socketPath });
    const hello = await client.connect();
    expect(hello).toMatchObject({
      protocol: { name: "prime-agent.daemon", version: 7 },
      clientId: "fixture-client",
    });
    expect(client.hello).toEqual(hello);
    expect(client.connected).toBe(true);
    client.close();
    expect(client.connected).toBe(false);
  });

  it("fails the handshake on a protocol below the floor", async () => {
    daemon = await FakeDaemon.start({
      hello: calibratedHello({ protocol: { name: "prime-agent.daemon", version: 6 } }),
    });
    const client = new PrimeDaemonClient({ socketPath: daemon.socketPath });
    const error = await rejectionOf(client.connect());
    expect(error).toBeInstanceOf(DaemonHandshakeError);
    const handshake = error as DaemonHandshakeError;
    expect(handshake.rejection).toMatchObject({
      kind: "protocol_too_old",
      protocolVersion: 6,
    });
    // The greeting parsed, so the found app version is still reportable.
    expect(handshake.hello?.appVersion).toBe("0.7.3");
  });

  it("fails the handshake on a greeting from some other daemon", async () => {
    daemon = await FakeDaemon.start({
      hello: calibratedHello({ protocol: { name: "acme.daemon", version: 9 } }),
    });
    const client = new PrimeDaemonClient({ socketPath: daemon.socketPath });
    const error = (await rejectionOf(client.connect())) as DaemonHandshakeError;
    expect(error.rejection).toMatchObject({ kind: "wrong_daemon" });
  });

  it("times out when no greeting arrives", async () => {
    daemon = await FakeDaemon.start({ silent: true });
    const client = new PrimeDaemonClient({ socketPath: daemon.socketPath });
    const error = await rejectionOf(client.connect(150));
    expect(error.message).toContain("waiting for the prime-agent daemon hello");
  });

  it("reports a refused connection, not a handshake failure", async () => {
    const client = new PrimeDaemonClient({
      socketPath: "/tmp/bbpa-no-such-socket.sock",
    });
    const error = await rejectionOf(client.connect(250));
    expect(error).not.toBeInstanceOf(DaemonHandshakeError);
    expect(error.message).toContain("could not connect");
  });
});

describe("the daemon client request path", () => {
  it("correlates a response by envelope id and keeps the command name", async () => {
    daemon = await FakeDaemon.start({
      respond: (envelope) => ({
        type: "response",
        id: envelope.id,
        command: (envelope.command as Record<string, unknown>).type,
        success: true,
        data: { activeSessionId: "sess-1" },
      }),
    });
    const client = new PrimeDaemonClient({ socketPath: daemon.socketPath });
    await client.connect();
    const result = await client.request({ type: "create", config: { cwd: "/tmp" } });
    expect(result).toEqual({
      command: "create",
      success: true,
      data: { activeSessionId: "sess-1" },
    });
    client.close();
  });

  it("surfaces an unsuccessful daemon reply without throwing", async () => {
    daemon = await FakeDaemon.start({
      respond: (envelope) => ({
        type: "response",
        id: envelope.id,
        command: (envelope.command as Record<string, unknown>).type,
        success: false,
        error: "Unknown daemon command: wibble",
      }),
    });
    const client = new PrimeDaemonClient({ socketPath: daemon.socketPath });
    await client.connect();
    const result = await client.request({ type: "wibble" });
    expect(result).toMatchObject({ success: false, error: "Unknown daemon command: wibble" });
    client.close();
  });

  it("gates capability-bound commands before the wire", async () => {
    daemon = await FakeDaemon.start({
      hello: calibratedHello({ serverCapabilities: ["attach_snapshot"] }),
    });
    const client = new PrimeDaemonClient({ socketPath: daemon.socketPath });
    await client.connect();
    const error = await rejectionOf(
      client.request({ type: "prompt", activeSessionId: "s", message: "hi" }),
    );
    expect(error).toBeInstanceOf(DaemonCapabilityUnavailableError);
    expect((error as DaemonCapabilityUnavailableError).missing).toEqual({
      kind: "capability",
      capability: "session_input_admission",
    });
    client.close();
  });

  it("rejects a request sent before the handshake", async () => {
    daemon = await FakeDaemon.start();
    const client = new PrimeDaemonClient({ socketPath: daemon.socketPath });
    await expect(client.request({ type: "list" })).rejects.toThrow(
      /before the daemon hello/,
    );
  });

  it("times out a request the daemon never answers", async () => {
    daemon = await FakeDaemon.start(); // pushes the hello, answers nothing
    const client = new PrimeDaemonClient({ socketPath: daemon.socketPath });
    await client.connect();
    const error = await rejectionOf(
      client.request({ type: "list" }, { timeoutMs: 120 }),
    );
    expect(error.message).toMatch(/timed out .* waiting for the daemon to answer "list"/);
    client.close();
  });

  it("routes push messages to the onPush hook", async () => {
    daemon = await FakeDaemon.start();
    const client = new PrimeDaemonClient({ socketPath: daemon.socketPath });
    const pushes: string[] = [];
    client.onPush = (message) => {
      pushes.push(message.type);
    };
    await client.connect();
    daemon.pushAll({
      type: "session_event",
      activeSessionId: "sess-1",
      event: { type: "agent_start" },
      meta: { sequence: 1, cursor: "1:1" },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(pushes).toEqual(["session_event"]);
    client.close();
  });

  it("rejects in-flight requests when the daemon drops the socket", async () => {
    daemon = await FakeDaemon.start();
    const client = new PrimeDaemonClient({ socketPath: daemon.socketPath });
    await client.connect();
    const inFlight = client.request({ type: "list" }, { timeoutMs: 5_000 });
    daemon.dropConnections();
    const error = await rejectionOf(inFlight);
    expect(error).toBeInstanceOf(DaemonConnectionClosedError);
  });
});

describe("the daemon client reconnect", () => {
  it("reconnects once the daemon answers again", async () => {
    daemon = await FakeDaemon.start({
      respond: (envelope) => ({
        type: "response",
        id: envelope.id,
        command: (envelope.command as Record<string, unknown>).type,
        success: true,
        data: {},
      }),
    });
    const client = new PrimeDaemonClient({ socketPath: daemon.socketPath });
    const firstHello = await client.connect();

    let peerClosed = 0;
    client.onPeerClose(() => {
      peerClosed += 1;
    });
    daemon.dropConnections();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(peerClosed).toBe(1);

    const statuses: string[] = [];
    const hello = await client.enableAutoReconnect({
      budgetMs: 4_000,
      attemptDelayMs: 50,
      onStatus: (status) => {
        statuses.push(status.status);
      },
    });
    // A fresh greeting for the new connection, not the stale one.
    expect(hello).not.toBe(firstHello);
    expect(hello.protocol.version).toBe(7);
    expect(statuses.at(-1)).toBe("reconnected");
    expect(await client.request({ type: "list" })).toMatchObject({ success: true });
    client.close();
  });

  it("gives up when the daemon never answers again", async () => {
    daemon = await FakeDaemon.start();
    const client = new PrimeDaemonClient({ socketPath: daemon.socketPath });
    await client.connect();
    await daemon.close();
    daemon = undefined;
    await expect(
      client.enableAutoReconnect({ budgetMs: 300, attemptDelayMs: 50 }),
    ).rejects.toThrow(/gave up reconnecting/);
  });

  it("tells a drop watcher about every drop, until the client is closed", async () => {
    daemon = await FakeDaemon.start();
    const client = new PrimeDaemonClient({ socketPath: daemon.socketPath });
    await client.connect();

    const drops: string[] = [];
    client.onPeerClose((error) => {
      drops.push(error?.message ?? "closed");
    });

    // Two drops in a row (a restart, then a crash): one subscription sees both,
    // which is what a recovery loop built on this hook needs.
    daemon.dropConnections();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await client.enableAutoReconnect({ budgetMs: 2_000, attemptDelayMs: 20 });
    daemon.dropConnections();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(drops.length).toBe(2);

    // A close we asked for is not a drop: it retires the watchers instead.
    client.close();
    expect(drops.length).toBe(2);
  });

  it("answers a dropped capability with an honest pre-send error after a drift", async () => {
    const respond = (envelope: Record<string, unknown>) => ({
      type: "response",
      id: envelope.id,
      command: (envelope.command as Record<string, unknown>).type,
      success: true,
      data: {},
    });
    const first = await FakeDaemon.start({ respond });
    const client = new PrimeDaemonClient({ socketPath: first.socketPath });
    await client.connect();
    await client.request({ type: "prompt" });
    await first.close();

    // The restarted daemon dropped the `session_input_admission` capability
    // `prompt` needs (and advertises an older schema revision): the same
    // command now fails on the client, before anything reaches the wire.
    const restarted = await FakeDaemon.start({
      hello: calibratedHello({
        serverCapabilities: (calibratedHello().serverCapabilities as string[]).filter(
          (capability) => capability !== "session_input_admission",
        ),
        schemaRevision: 7,
      }),
      respond,
    });
    try {
      const drifted = new PrimeDaemonClient({ socketPath: restarted.socketPath });
      await drifted.connect();
      const error = await rejectionOf(drifted.request({ type: "prompt" }));
      expect(error).toBeInstanceOf(DaemonCapabilityUnavailableError);
      expect((error as DaemonCapabilityUnavailableError).message).toContain(
        'cannot run "prompt"',
      );
      expect((error as DaemonCapabilityUnavailableError).missing).toMatchObject({
        kind: "capability",
        capability: "session_input_admission",
      });
      // A command the drifted daemon still supports goes straight through.
      await expect(drifted.request({ type: "list" })).resolves.toMatchObject({
        success: true,
      });
      drifted.close();
    } finally {
      await restarted.close();
    }
  });
});

describe("client hello routing", () => {
  it("never sends a greeting of its own", async () => {
    const seen: Record<string, unknown>[] = [];
    daemon = await FakeDaemon.start({
      respond: (envelope) => {
        seen.push(envelope);
        return {
          type: "response",
          id: envelope.id,
          command: (envelope.command as Record<string, unknown>).type,
          success: true,
          data: {},
        };
      },
    });
    const client = new PrimeDaemonClient({ socketPath: daemon.socketPath });
    await client.connect();
    await client.request({ type: "list" });
    client.close();
    // Only the request crossed the wire — no client-side hello.
    expect(seen).toHaveLength(1);
    expect(parseDaemonHello(seen[0])).toBeNull();
    expect(seen[0]).toMatchObject({ type: "command", id: "bb-1" });
  });
});

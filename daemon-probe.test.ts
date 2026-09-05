import { afterEach, describe, expect, it } from "vitest";
import { probeDaemon } from "./src/daemon/probe.js";
import { calibratedHello, FakeDaemon } from "./test-support/fake-daemon.js";

let daemon: FakeDaemon | undefined;

afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
});

describe("the daemon probe", () => {
  it("reports unreachable for a socket that does not exist", async () => {
    const result = await probeDaemon({
      socketPath: "/tmp/bbpa-probe-no-such-socket.sock",
    });
    expect(result).toMatchObject({
      status: "unreachable",
      socketPath: "/tmp/bbpa-probe-no-such-socket.sock",
    });
    if (result.status === "unreachable") {
      expect(result.reason).toContain("no daemon socket");
      // The probe never starts a daemon to make itself useful.
      expect(result.reason).toContain("never starts");
    }
  });

  it("reads the greeting, reports the version, and hangs up", async () => {
    daemon = await FakeDaemon.start();
    const result = await probeDaemon({ socketPath: daemon.socketPath });
    if (result.status !== "ok") {
      throw new Error(`expected ok, got ${JSON.stringify(result)}`);
    }
    expect(result.hello.appVersion).toBe("0.7.3");
    expect(result.warnings).toEqual([]);
    // One probe, one connection: nothing stays attached to the daemon.
    expect(result.drift).toMatchObject({
      schemaRevision: { kind: "same" },
      appVersion: { kind: "same" },
    });
  });

  it("surfaces drift as warnings, never as a failure", async () => {
    daemon = await FakeDaemon.start({
      hello: calibratedHello({
        schemaRevision: 23,
        schemaId: "protocol-7-schema-23-deadbeef",
        appVersion: "0.9.0",
        serverCapabilities: ["attach_snapshot", "event_sequence"],
      }),
    });
    const result = await probeDaemon({ socketPath: daemon.socketPath });
    if (result.status !== "ok") {
      throw new Error(`expected ok, got ${JSON.stringify(result)}`);
    }
    expect(result.hello.protocol.version).toBe(7);
    const warnings = result.warnings.join(" ");
    expect(warnings).toContain("revision 23");
    expect(warnings).toContain("0.9.0 is newer");
    expect(warnings).toContain("protocol-7-schema-23-deadbeef");
    expect(warnings).toContain("server capabilities");
  });

  it("reports a greeting below the protocol floor as a handshake failure", async () => {
    daemon = await FakeDaemon.start({
      hello: calibratedHello({ protocol: { name: "prime-agent.daemon", version: 4 } }),
    });
    const result = await probeDaemon({ socketPath: daemon.socketPath });
    expect(result.status).toBe("handshake_failed");
    if (result.status === "handshake_failed") {
      expect(result.rejection).toMatchObject({
        kind: "protocol_too_old",
        protocolVersion: 4,
      });
      expect(result.hello?.appVersion).toBe("0.7.3");
    }
  });

  it("reports a greeting that is not a hello at all", async () => {
    daemon = await FakeDaemon.start({ hello: { type: "daemon_closing", reason: "x" } });
    const result = await probeDaemon({ socketPath: daemon.socketPath });
    expect(result.status).toBe("handshake_failed");
    if (result.status === "handshake_failed") {
      expect(result.rejection).toMatchObject({ kind: "invalid_hello" });
    }
  });

  it("resolves the socket path from the environment override", async () => {
    const result = await probeDaemon({
      env: { BB_PRIME_AGENT_DAEMON_SOCKET: "/tmp/bbpa-env-override.sock" },
    });
    expect(result.status).toBe("unreachable");
    expect(result.socketPath).toBe("/tmp/bbpa-env-override.sock");
  });
});

describe("a live prime-agent daemon", () => {
  const itLive = process.env.BBPA_LIVE_DAEMON === "1" ? it : it.skip;

  itLive("answers the hello handshake", async () => {
    const result = await probeDaemon();
    if (result.status !== "ok") {
      throw new Error(`expected ok, got ${JSON.stringify(result)}`);
    }
    console.info(
      `live prime-agent daemon: version ${result.hello.appVersion ?? "<unreported>"}, protocol ${result.hello.protocol.version}, schema revision ${result.hello.schemaRevision ?? "<unreported>"}${
        result.warnings.length > 0 ? `; drift: ${result.warnings.join(" ")}` : ""
      }`,
    );
    expect(result.hello.protocol.name).toBe("prime-agent.daemon");
    expect(result.hello.appVersion).toEqual(expect.any(String));
  });
});

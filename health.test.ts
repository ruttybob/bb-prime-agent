import { afterEach, describe, expect, it } from "vitest";
import {
  PRIME_MINIMUM_SUPPORTED_VERSION,
  primeProviderHealth,
  primeProviderHealthCached,
  resetPrimeHealthCacheForTests,
} from "./src/health.js";
import { calibratedHello, FakeDaemon } from "./test-support/fake-daemon.js";

let daemon: FakeDaemon | undefined;

afterEach(async () => {
  resetPrimeHealthCacheForTests();
  await daemon?.close();
  daemon = undefined;
});

describe("prime provider health", () => {
  it("hides the provider when no daemon is there to answer", async () => {
    const health = await primeProviderHealth({
      socketPath: "/tmp/bbpa-health-no-such-socket.sock",
    });
    expect(health).toEqual({
      supported: true,
      health: {
        status: "not_installed",
        statusMessage: expect.stringContaining("No prime-agent daemon answered"),
        accountEmail: null,
        planLabel: null,
        installedVersion: null,
        minimumSupportedVersion: PRIME_MINIMUM_SUPPORTED_VERSION,
        canInstall: false,
        canUpdate: false,
        loginCommand: "prime-agent",
      },
    });
    // bb never installs prime-agent, so it never offers to.
    expect(health.health.canInstall).toBe(false);
    expect(health.health.canUpdate).toBe(false);
  });

  it("reports the found prime version and stays silent when calibrated", async () => {
    daemon = await FakeDaemon.start();
    const health = await primeProviderHealth({ socketPath: daemon.socketPath });
    expect(health.health.status).toBe("ready");
    expect(health.health.installedVersion).toBe("0.7.3");
    expect(health.health.statusMessage).toBeNull();
  });

  it("turns calibration drift into a warning, not a block", async () => {
    daemon = await FakeDaemon.start({
      hello: calibratedHello({ schemaRevision: 23, appVersion: "0.9.0" }),
    });
    const health = await primeProviderHealth({ socketPath: daemon.socketPath });
    expect(health.health.status).toBe("ready");
    expect(health.health.installedVersion).toBe("0.9.0");
    expect(health.health.statusMessage).toContain("revision 23");
    expect(health.health.statusMessage).toContain("0.9.0 is newer");
  });

  it("reports an old protocol as an unsupported version, with the version found", async () => {
    daemon = await FakeDaemon.start({
      hello: calibratedHello({ protocol: { name: "prime-agent.daemon", version: 5 } }),
    });
    const health = await primeProviderHealth({ socketPath: daemon.socketPath });
    expect(health.health.status).toBe("unsupported_version");
    expect(health.health.installedVersion).toBe("0.7.3");
    expect(health.health.minimumSupportedVersion).toBe(
      PRIME_MINIMUM_SUPPORTED_VERSION,
    );
    expect(health.health.statusMessage).toContain("protocol 5");
    expect(health.health.statusMessage).toContain("7 or newer");
  });

  it("reports a foreign greeting as unknown", async () => {
    daemon = await FakeDaemon.start({
      hello: { type: "hello", protocol: { name: "acme", version: 1 } },
    });
    const health = await primeProviderHealth({ socketPath: daemon.socketPath });
    expect(health.health.status).toBe("unknown");
    expect(health.health.statusMessage).toContain("cannot use");
  });

  it("memoizes answers briefly per socket path", async () => {
    daemon = await FakeDaemon.start();
    const first = await primeProviderHealthCached({ socketPath: daemon.socketPath });
    const second = await primeProviderHealthCached({ socketPath: daemon.socketPath });
    expect(second).toBe(first);
    await daemon.close();
    daemon = undefined;
    // A different socket path is probed independently of the cached one.
    const other = await primeProviderHealthCached({
      socketPath: "/tmp/bbpa-health-cache-other.sock",
    });
    expect(other.health.status).toBe("not_installed");
  });
});

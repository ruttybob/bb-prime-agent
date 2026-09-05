import { describe, expect, it } from "vitest";
import {
  CALIBRATED_APP_VERSION,
  CALIBRATED_SCHEMA_ID,
  CALIBRATED_SCHEMA_REVISION,
  checkDaemonCommandSupport,
  createDaemonCommandEnvelope,
  describeHelloDrift,
  driftWarnings,
  parseDaemonHello,
  validateDaemonHello,
  type DaemonHello,
} from "./src/daemon/protocol.js";
import { calibratedHello } from "./test-support/fake-daemon.js";

const hello = calibratedHello() as unknown as DaemonHello;

describe("daemon hello parsing", () => {
  it("accepts the calibrated greeting", () => {
    expect(parseDaemonHello(calibratedHello())).toMatchObject({
      type: "daemon_hello",
      protocol: { name: "prime-agent.daemon", version: 7 },
      schemaRevision: CALIBRATED_SCHEMA_REVISION,
      appVersion: CALIBRATED_APP_VERSION,
      clientId: "fixture-client",
    });
  });

  it("tolerates a daemon that omits the optional calibration fields", () => {
    const parsed = parseDaemonHello({
      type: "daemon_hello",
      protocol: { name: "prime-agent.daemon", version: 7 },
      clientId: "c",
    });
    expect(parsed).toMatchObject({ protocol: { version: 7 } });
    expect(parsed?.schemaRevision).toBeUndefined();
    expect(parsed?.serverCapabilities).toBeUndefined();
  });

  it("rejects anything that is not a daemon_hello", () => {
    expect(parseDaemonHello({ type: "response", id: "1" })).toBeNull();
    expect(parseDaemonHello({ type: "daemon_closing", reason: "shutdown" })).toBeNull();
    expect(parseDaemonHello("daemon_hello")).toBeNull();
    expect(parseDaemonHello(null)).toBeNull();
    expect(parseDaemonHello([calibratedHello()])).toBeNull();
  });

  it("rejects a greeting with a malformed protocol or calibration field", () => {
    expect(
      parseDaemonHello(calibratedHello({ protocol: { version: 7 } })),
    ).toBeNull();
    expect(
      parseDaemonHello(calibratedHello({ schemaRevision: "16" })),
    ).toBeNull();
    expect(
      parseDaemonHello(calibratedHello({ serverCapabilities: "all" })),
    ).toBeNull();
    expect(parseDaemonHello(calibratedHello({ appVersion: 4 }))).toBeNull();
    expect(parseDaemonHello(calibratedHello({ clientId: 5 }))).toBeNull();
  });
});

describe("daemon hello validation", () => {
  it("accepts the calibrated protocol", () => {
    expect(validateDaemonHello(hello)).toBeNull();
  });

  it("rejects a greeting from some other daemon", () => {
    const rejection = validateDaemonHello({
      ...hello,
      protocol: { name: "other-agent.daemon", version: 7 },
    });
    expect(rejection).toMatchObject({ kind: "wrong_daemon" });
  });

  it("rejects a protocol below the envelope floor", () => {
    const rejection = validateDaemonHello({
      ...hello,
      protocol: { name: "prime-agent.daemon", version: 6 },
    });
    expect(rejection).toMatchObject({ kind: "protocol_too_old", protocolVersion: 6 });
  });

  it("accepts a newer protocol (drift is reported, not rejected)", () => {
    expect(
      validateDaemonHello({
        ...hello,
        protocol: { name: "prime-agent.daemon", version: 8 },
      }),
    ).toBeNull();
  });
});

describe("the client-side compat gate", () => {
  it("admits a legacy command on the calibrated protocol", () => {
    expect(checkDaemonCommandSupport(hello, "create")).toBeNull();
    expect(checkDaemonCommandSupport(hello, "cancel_rlm_child")).toBeNull();
  });

  it("gates a command on a server capability", () => {
    const stripped = { ...hello, serverCapabilities: ["attach_snapshot"] };
    expect(checkDaemonCommandSupport(stripped, "prompt")).toMatchObject({
      command: "prompt",
      missing: { kind: "capability", capability: "session_input_admission" },
    });
    expect(checkDaemonCommandSupport(stripped, "get_model_catalog")).toMatchObject({
      missing: { kind: "capability", capability: "model_catalog" },
    });
  });

  it("gates a command on a schema revision", () => {
    const older = { ...hello, schemaRevision: 10 };
    expect(checkDaemonCommandSupport(older, "set_rlm_max_depth")).toMatchObject({
      missing: { kind: "schema", required: 11, actual: 10 },
    });
    expect(
      checkDaemonCommandSupport(older, "mutate_queued_message"),
    ).toMatchObject({ missing: { kind: "schema", required: 15 } });
  });

  it("gates a command on the protocol version", () => {
    const older = { ...hello, protocol: { name: hello.protocol.name, version: 6 } };
    expect(checkDaemonCommandSupport(older, "create")).toMatchObject({
      missing: { kind: "protocol", required: 7, actual: 6 },
    });
  });

  it("treats a command missing from the calibration as allowed (prime's own behavior)", () => {
    expect(checkDaemonCommandSupport(hello, "not_a_real_command")).toBeNull();
  });
});

describe("command envelopes", () => {
  it("caps the protocol version at what the daemon speaks", () => {
    const envelope = createDaemonCommandEnvelope({
      command: { type: "create", config: {} },
      id: "bb-1",
      clientId: "client",
      hello,
    });
    expect(envelope).toEqual({
      type: "command",
      id: "bb-1",
      protocol: { name: "prime-agent.daemon", version: 7 },
      clientId: "client",
      command: { type: "create", config: {} },
    });
    const newer = createDaemonCommandEnvelope({
      command: { type: "list" },
      id: "bb-2",
      hello: { ...hello, protocol: { name: hello.protocol.name, version: 9 } },
    });
    expect(newer.protocol.version).toBe(7);
  });
});

describe("calibration drift", () => {
  it("reports nothing on the calibrated greeting", () => {
    expect(driftWarnings(hello)).toEqual([]);
    expect(describeHelloDrift(hello)).toEqual({
      schemaRevision: { kind: "same" },
      appVersion: { kind: "same" },
      schemaIdChanged: false,
      serverCapabilities: { kind: "same" },
    });
  });

  it("warns about a newer schema revision and a changed schema id", () => {
    const warnings = driftWarnings(
      calibratedHello({
        schemaRevision: 23,
        schemaId: "protocol-7-schema-23-deadbeef",
      }) as unknown as DaemonHello,
    );
    expect(warnings.some((line) => line.includes("revision 23"))).toBe(true);
    expect(
      warnings.some((line) => line.includes("protocol-7-schema-23-deadbeef")),
    ).toBe(true);
  });

  it("warns about an older and a newer app version", () => {
    const older = driftWarnings(
      calibratedHello({ appVersion: "0.6.9" }) as unknown as DaemonHello,
    );
    expect(older.join(" ")).toContain("0.6.9 is older");

    const newer = driftWarnings(
      calibratedHello({ appVersion: "1.0.0" }) as unknown as DaemonHello,
    );
    expect(newer.join(" ")).toContain("1.0.0 is newer");
  });

  it("warns when the daemon reports no version at all", () => {
    const { appVersion: _ignored, ...unreported } = calibratedHello();
    const warnings = driftWarnings(unreported as unknown as DaemonHello);
    expect(warnings.join(" ")).toContain("did not report its app version");
  });

  it("warns when the capability roster changes", () => {
    const warnings = driftWarnings(
      calibratedHello({ serverCapabilities: ["attach_snapshot"] }) as unknown as DaemonHello,
    );
    expect(warnings.join(" ")).toContain("server capabilities");
  });

  it("keeps the calibrated schema id constant", () => {
    expect(CALIBRATED_SCHEMA_ID).toBe("protocol-7-schema-16-1bcb9e7f1a49");
  });
});

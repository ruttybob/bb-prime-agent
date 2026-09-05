import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  experimental_captureBridgeJsonRpcOutput as captureBridgeJsonRpcOutput,
  experimental_formatConformanceReport as formatConformanceReport,
  experimental_runBridgeConformance as runBridgeConformance,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import type { CapturedBridgeJsonRpcOutput } from "@get-bb/plugin-sdk/provider-bridge/testing";

import {
  handleLine,
  resetDaemonForTests,
  sessionTableForTests,
} from "./src/provider-bridge.js";
import {
  setPrimeDaemonTransportFactoryForTests,
} from "./src/daemon/connection.js";
import {
  createScriptedDaemon,
  textTurnEvents,
} from "./test-support/scripted-daemon.js";

let output: CapturedBridgeJsonRpcOutput;
let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bb-prime-conformance-"));
  output = captureBridgeJsonRpcOutput();
  // The suite stays hermetic: the bridge runs its real chat path against a
  // scripted daemon instead of the machine's prime install.
  const daemon = createScriptedDaemon({
    session: {
      activeSessionId: "sess_conformance",
      sessionFile: "/tmp/prime/sessions/sess_conformance.jsonl",
      sessionName: "[bb] say hello (thr_conformance_1)",
      cwd: workspaceDir,
    },
  });
  daemon.enqueueCreate();
  daemon.enqueueAttach();
  daemon.enqueuePrompt({ events: textTurnEvents({ text: "hello" }) });
  daemon.enqueueOk("abort");
  daemon.enqueueOk("detach");
  daemon.enqueueAttach();
  daemon.enqueuePrompt({ events: textTurnEvents({ text: "hello again" }) });
  // The zero-work prompt: prime ran a turn that produced nothing observable,
  // which still has to settle the turn bb accepted.
  daemon.enqueuePrompt({
    events: [{ type: "agent_start" }, { type: "agent_end", messages: [] }],
  });
  daemon.enqueueOk("abort");
  daemon.enqueueOk("detach");
  setPrimeDaemonTransportFactoryForTests(() => daemon.transport);
});

afterEach(() => {
  output.restore();
  setPrimeDaemonTransportFactoryForTests(undefined);
  resetDaemonForTests();
  sessionTableForTests().clear();
  rmSync(workspaceDir, { recursive: true, force: true });
});

it("passes the canonical protocol suite", async () => {
  const report = await runBridgeConformance({
    transport: { send: handleLine, takeMessages: output.takeMessages },
    providerId: "prime-agent",
    session: {
      cwd: workspaceDir,
      promptInput: [{ type: "text", text: "say hello", mentions: [] }],
      zeroWorkPromptInput: [{ type: "text", text: "/noop", mentions: [] }],
    },
    timeoutMs: 5_000,
  });

  output.restore();
  console.info(
    `prime-agent bridge conformance:\n${formatConformanceReport(report)}`,
  );

  const statusById = Object.fromEntries(
    report.results.map((result) => [result.id, result.status]),
  );
  expect(statusById).toEqual({
    "rpc/unknown-method": "pass",
    "rpc/invalid-params": "pass",
    "rpc/non-json-ignored": "pass",
    "rpc/response-not-request": "pass",
    "handshake/initialize": "pass",
    "session/start-identity": "pass",
    "turn/lifecycle": "pass",
    "events/schema-valid": "pass",
    "item/opens-before-delta": "pass",
    "stop/release-not-interrupted": "pass",
    "session/resume-identity": "pass",
    "session/resume-id-uniqueness": "pass",
    "skills/configure-declared": "pass",
    "turn/settles-without-activity": "pass",
  });
  expect(report.passed).toBe(true);
}, 30_000);

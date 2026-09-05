import { describe, expect, it } from "vitest";
import {
  experimental_captureBridgeJsonRpcOutput as captureBridgeJsonRpcOutput,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import hostEntry, { experimental_providerBridge } from "./host.js";

describe("the host artifact", () => {
  it("exports the provider bridge as a pure named export", () => {
    expect(experimental_providerBridge.experimental_apiVersion).toBe(1);
    expect(typeof experimental_providerBridge.handleLine).toBe("function");
    // Import side effects: no daemon connection, no session state, nothing —
    // `start` runs only when the daemon invokes the artifact.
    expect(experimental_providerBridge.start).toBeTypeOf("function");
    expect(experimental_providerBridge.onClose).toBeTypeOf("function");
  });

  it("exports a host RPC entry beside the bridge", () => {
    expect(hostEntry.experimental_apiVersion).toBe(1);
    // The Subagents panel's per-machine backend (bbpa-ggf.9): the one method
    // the plugin server may ask this machine's daemon client for.
    expect(Object.keys(hostEntry.contract)).toEqual(["subagents.roster"]);
    expect(hostEntry.experimental_signals).toBeDefined();
  });

  it("ignores non-JSON lines and answers unknown methods with METHOD_NOT_FOUND", () => {
    const output = captureBridgeJsonRpcOutput();
    try {
      experimental_providerBridge.handleLine("this is { not json");
      experimental_providerBridge.handleLine(
        JSON.stringify({ jsonrpc: "2.0", id: 7, method: "nope", params: {} }),
      );
      const messages = output.takeMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ id: 7, error: { code: -32601 } });
    } finally {
      output.restore();
    }
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server.js";
import { childThreadMarkerInput } from "./src/child-threads.js";

/**
 * The server wiring of child threads (bbpa-b1m.11): a `subagents.changed`
 * host signal becomes exactly one `threads.spawn` for each live child with
 * its own session, filed under the parent thread's project and environment.
 */

const parentThread = makeThreadResponse({
  id: "thr_parent",
  projectId: "proj_1",
  environmentId: "env_1",
  providerId: "prime-agent",
  title: "parent thread",
});

const { bb, harness } = createFakePluginHost({
  pluginId: "bb-plugin-prime-agent",
  sdk: {
    threads: {
      list: () => [parentThread],
      get: () => parentThread,
      spawn: () => makeThreadResponse({ id: "thr_child", title: "researcher" }),
      events: {
        // The reverse resolver reads the thread's identity: which prime
        // session this thread backs.
        list: () => [{ data: { providerThreadId: "prime_sess_parent" } }],
      },
    },
    hosts: { list: () => [] },
  },
});
plugin(bb);

describe("child threads server wiring (bbpa-b1m.11)", () => {
  it("spawns a filed child thread from the changed signal", async () => {
    await harness.behavior.experimental_emitHostSignal(
      "host_1",
      "subagents.changed",
      {
        activeSessionId: "sess_parent",
        children: [
          {
            id: "child_1",
            label: "researcher",
            status: "running",
            activeSessionId: "sess_kid",
          },
        ],
      },
    );

    await vi.waitFor(() => {
      expect(harness.sdk.callsTo("threads.spawn")).toHaveLength(1);
    });
    const [args] = harness.sdk.callsTo("threads.spawn")[0] as [
      Record<string, unknown>,
    ];
    expect(args).toMatchObject({
      projectId: "proj_1",
      providerId: "prime-agent",
      title: "researcher",
      parentThreadId: "thr_parent",
      environment: { type: "reuse", environmentId: "env_1" },
    });
    // The spawn's only input is the marker naming the child's session — the
    // bridge consumes it and attaches instead of creating a session.
    expect(args.input).toEqual([childThreadMarkerInput("sess_kid")]);
  });

  it("does not spawn for children without their own session", async () => {
    await harness.behavior.experimental_emitHostSignal(
      "host_2",
      "subagents.changed",
      {
        activeSessionId: "sess_parent",
        children: [{ id: "child_2", label: "booting", status: "queued" }],
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(harness.sdk.callsTo("threads.spawn")).toHaveLength(1);
  });
});

// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

/**
 * The Subagents panel (bbpa-ggf.9), mounted through the SDK's frontend test
 * runtime — no bb window, no daemon. The panel's contract with the host is
 * exercised here: one roster question on mount, live refetches driven by the
 * realtime channel and reconnects, and the read-only renderings in between.
 */

const app = await loadPluginApp(() => import("./app"));
const registration = app.threadPanelActions[0]!;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function scoutChild(overrides: Record<string, unknown> = {}) {
  return {
    id: "child_1",
    label: "scout",
    status: "running",
    activeSessionId: "sess_child_1",
    model: "zai/glm-5.3-flash",
    tokenCount: 4321,
    toolUseCount: 3,
    sessionDir: "/tmp/prime/children",
    ...overrides,
  };
}

function renderPanel(options: Parameters<typeof renderSlot>[2] = {}) {
  return renderSlot(
    registration,
    { threadId: "thr_panel", params: null },
    {
      context: { projectId: "prj_panel", threadId: "thr_panel" },
      ...options,
    },
  );
}

describe("the Subagents panel", () => {
  it("registers one thread panel action", () => {
    expect(app.threadPanelActions).toHaveLength(1);
    expect(registration).toMatchObject({ id: "subagents", title: "Subagents" });
  });

  it("lists the roster with status, model and token count", async () => {
    const rpc = {
      roster: vi.fn().mockResolvedValue({
        state: "ready",
        activeSessionId: "sess_panel",
        children: [scoutChild()],
      }),
    };
    const slot = renderPanel({ rpc });

    await slot.findByText("scout");
    await waitFor(() => expect(slot.inspection.rpcCalls).toHaveLength(1));
    expect(slot.inspection.rpcCalls[0]).toEqual({
      method: "roster",
      input: { threadId: "thr_panel" },
    });
    expect(screen.getByText("running")).toBeDefined();
    expect(screen.getByText("zai/glm-5.3-flash")).toBeDefined();
    expect(screen.getByText("4,321 tokens")).toBeDefined();
    expect(screen.getByText("1 total · 1 live")).toBeDefined();
    slot.lifecycle.unmount();
  });

  it("refetches when a host roster change is republished, and ignores other sessions", async () => {
    let children = [scoutChild()];
    const rpc = {
      roster: vi.fn().mockImplementation(async () => ({
        state: "ready",
        activeSessionId: "sess_panel",
        children,
      })),
    };
    const slot = renderPanel({ rpc });
    await slot.findByText("scout");
    expect(slot.inspection.rpcCalls).toHaveLength(1);

    children = [
      scoutChild({ status: "done", answerPreview: "all clear", toolUseCount: 5 }),
    ];
    await slot.behavior.emitRealtime("subagents", { activeSessionId: "sess_panel" });
    await waitFor(() =>
      expect(slot.inspection.rpcCalls).toHaveLength(2),
    );
    await slot.findByText("done");

    // Another thread's roster change is none of this panel's business.
    await slot.behavior.emitRealtime("subagents", { activeSessionId: "sess_other" });
    expect(slot.inspection.rpcCalls).toHaveLength(2);
    slot.lifecycle.unmount();
  });

  it("catches up after a realtime gap and shows an empty roster honestly", async () => {
    const rpc = {
      roster: vi.fn().mockResolvedValue({
        state: "ready",
        activeSessionId: "sess_panel",
        children: [],
      }),
    };
    const slot = renderPanel({ rpc });
    await slot.findByText(/No subagents for this thread/);

    await slot.behavior.setRealtimeConnectionState("reconnecting");
    await slot.behavior.setRealtimeConnectionState("connected");
    await waitFor(() => expect(slot.inspection.rpcCalls).toHaveLength(2));
    slot.lifecycle.unmount();
  });

  it("answers an unknown thread and an unreachable daemon with honest copy", async () => {
    const unknownThread = renderPanel({
      rpc: {
        roster: vi.fn().mockResolvedValue({
          state: "unknown_thread",
          activeSessionId: null,
          children: [],
        }),
      },
    });
    await unknownThread.findByText(/No subagents for this thread/);
    unknownThread.lifecycle.unmount();

    const unavailable = renderPanel({
      rpc: {
        roster: vi.fn().mockResolvedValue({
          state: "unavailable",
          activeSessionId: "sess_panel",
          children: [],
        }),
      },
    });
    await unavailable.findByText(/prime-agent has no roster for this session/);
    unavailable.lifecycle.unmount();
  });

  it("surfaces an rpc failure as an alert instead of an empty roster", async () => {
    const slot = renderPanel({
      rpc: {
        roster: vi.fn().mockRejectedValue(new Error("the plugin server is down")),
      },
    });
    await slot.findByText(/the plugin server is down/);
    slot.lifecycle.unmount();
  });

  it("renders without a host icon dependency (the plugin logo is used)", () => {
    // The registration carries a host glyph hint only; the bundle stays free
    // of icon assets, so nothing here can 404 on a window that never opened
    // the panel.
    expect(registration.icon).toBeTypeOf("string");
  });
});

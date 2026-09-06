// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

/**
 * The Heartbeats panel (bbpa-b1m.3, schedules bbpa-b1m.4), mounted through
 * the SDK's frontend test runtime — no bb window, no daemon. Pinned here: the
 * two-list rendering with delivery badges, the refetch on prime's global
 * `heartbeats_changed` republish, the create forms mapping onto the rpc
 * contract, and refusals shown instead of swallowed.
 */

const app = await loadPluginApp(() => import("./app"));
const registration = app.threadPanelActions.find(
  (action) => action.id === "heartbeats",
)!;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function heartbeatJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "hb_1",
    status: "active",
    source: "heartbeat",
    deliveryMode: "steer",
    prompt: "check the build",
    schedule: { kind: "interval", expression: "every 5m" },
    nextRunAt: new Date(Date.now() + 300_000).toISOString(),
    runCount: 2,
    ...overrides,
  };
}

function readyList(overrides: Record<string, unknown> = {}) {
  return {
    state: "ready",
    activeSessionId: "sess_panel",
    heartbeats: [heartbeatJob()],
    schedules: [],
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

describe("the Heartbeats panel", () => {
  it("lists heartbeats with schedule, delivery badge and next run", async () => {
    const slot = renderPanel({
      rpc: { list: vi.fn().mockResolvedValue(readyList()) },
    });
    await slot.findByText("check the build");
    expect(slot.inspection.rpcCalls[0]).toEqual({
      method: "list",
      input: { threadId: "thr_panel" },
    });
    expect(screen.getByText("every 5m")).toBeDefined();
    expect(screen.getAllByText("steer").length).toBeGreaterThan(0);
    expect(screen.getByText("user")).toBeDefined();
    expect(screen.getByText(/next run/)).toBeDefined();
    slot.lifecycle.unmount();
  });

  it("refetches when the server republishes prime's global change push", async () => {
    let list = readyList();
    const rpc = {
      list: vi.fn().mockImplementation(async () => list),
    };
    const slot = renderPanel({ rpc });
    await slot.findByText("check the build");
    expect(slot.inspection.rpcCalls).toHaveLength(1);

    list = readyList({
      heartbeats: [heartbeatJob({ status: "paused" })],
    });
    await slot.behavior.emitRealtime("heartbeats", { at: Date.now() });
    await waitFor(() => expect(slot.inspection.rpcCalls).toHaveLength(2));
    slot.lifecycle.unmount();
  });

  it("renders an empty session honestly, with the create forms", async () => {
    const slot = renderPanel({
      rpc: { list: vi.fn().mockResolvedValue(readyList({ heartbeats: [], schedules: [] })) },
    });
    await slot.findByText(/No heartbeats on this session/);
    expect(screen.getByLabelText("Heartbeat schedule")).toBeDefined();
    expect(screen.getByLabelText("Heartbeat instruction")).toBeDefined();
    slot.lifecycle.unmount();
  });

  it("does not mistake an unknown thread or a lost session for an empty one", async () => {
    const unknownThread = renderPanel({
      rpc: {
        list: vi.fn().mockResolvedValue(
          readyList({ state: "unknown_thread", activeSessionId: null, heartbeats: [], schedules: [] }),
        ),
      },
    });
    await unknownThread.findByText(/No prime-agent session for this thread yet/);
    expect(screen.queryByLabelText("Heartbeat schedule")).toBeNull();
    unknownThread.lifecycle.unmount();

    const unavailable = renderPanel({
      rpc: {
        list: vi.fn().mockResolvedValue(
          readyList({ state: "unavailable", heartbeats: [], schedules: [] }),
        ),
      },
    });
    await unavailable.findByText(/No connected machine holds prime-agent session sess_panel/);
    expect(screen.queryByLabelText("Heartbeat schedule")).toBeNull();
    unavailable.lifecycle.unmount();
  });

  it("surfaces an rpc failure as an alert", async () => {
    const slot = renderPanel({
      rpc: { list: vi.fn().mockRejectedValue(new Error("no host holds the session")) },
    });
    await slot.findByText(/no host holds the session/);
    slot.lifecycle.unmount();
  });
});

describe("the Heartbeats panel's controls", () => {
  it("maps the create form onto heartbeats.set with the chosen delivery", async () => {
    const set = vi.fn().mockResolvedValue({ activeSessionId: "sess_panel" });
    const slot = renderPanel({
      rpc: {
        list: vi.fn().mockResolvedValue(readyList({ heartbeats: [] })),
        set,
      },
    });
    await slot.findByText(/No heartbeats on this session/);
    fireEvent.change(screen.getByLabelText("Heartbeat schedule"), {
      target: { value: "every 10m" },
    });
    fireEvent.change(screen.getByLabelText("Heartbeat instruction"), {
      target: { value: "sweep the logs" },
    });
    fireEvent.change(screen.getByLabelText("Delivery mode"), {
      target: { value: "follow_up" },
    });
    fireEvent.click(screen.getByText("set heartbeat"));
    await waitFor(() =>
      expect(set).toHaveBeenCalledWith({
        threadId: "thr_panel",
        activeSessionId: "sess_panel",
        schedule: "every 10m",
        prompt: "sweep the logs",
        deliveryMode: "follow_up",
      }),
    );
    slot.lifecycle.unmount();
  });

  it("offers pause/resume/stop per heartbeat row, hidden by status", async () => {
    const manage = vi.fn().mockResolvedValue({ activeSessionId: "sess_panel" });
    const slot = renderPanel({
      rpc: {
        list: vi.fn().mockResolvedValue(readyList()),
        manage,
      },
    });
    await slot.findByText("check the build");
    expect(screen.queryByText("resume")).toBeNull();
    fireEvent.click(screen.getByText("pause"));
    await waitFor(() =>
      expect(manage).toHaveBeenCalledWith({
        threadId: "thr_panel",
        activeSessionId: "sess_panel",
        jobId: "hb_1",
        action: "pause",
      }),
    );
    slot.lifecycle.unmount();
  });

  it("adds a prime-side schedule from the form", async () => {
    const scheduleAdd = vi.fn().mockResolvedValue({ activeSessionId: "sess_panel" });
    const slot = renderPanel({
      rpc: {
        list: vi.fn().mockResolvedValue(readyList()),
        scheduleAdd,
      },
    });
    await slot.findByText("check the build");
    fireEvent.change(screen.getByLabelText("Schedule"), {
      target: { value: "every 10m" },
    });
    fireEvent.change(screen.getByLabelText("Schedule prompt"), {
      target: { value: "run the sweep" },
    });
    fireEvent.click(screen.getByText("add schedule"));
    await waitFor(() =>
      expect(scheduleAdd).toHaveBeenCalledWith({
        threadId: "thr_panel",
        activeSessionId: "sess_panel",
        schedule: "every 10m",
        prompt: "run the sweep",
      }),
    );
    slot.lifecycle.unmount();
  });

  it("offers a cancel to a schedule row", async () => {
    const scheduleCancel = vi.fn().mockResolvedValue({ activeSessionId: "sess_panel" });
    const slot = renderPanel({
      rpc: {
        list: vi.fn().mockResolvedValue(
          readyList({
            schedules: [
              heartbeatJob({
                id: "cron_1",
                source: "cron",
                prompt: "run the sweep",
              }),
            ],
          }),
        ),
        scheduleCancel,
      },
    });
    await slot.findByText("run the sweep");
    fireEvent.click(screen.getByRole("button", { name: "cancel" }));
    await waitFor(() =>
      expect(scheduleCancel).toHaveBeenCalledWith({
        threadId: "thr_panel",
        activeSessionId: "sess_panel",
        jobId: "cron_1",
      }),
    );
    slot.lifecycle.unmount();
  });
});

// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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

/**
 * The controls (bbpa-ggf.10): a running child takes a steer message and a
 * stop; a finished one takes neither. The panel's own state is only ever a
 * pending state — the change itself always comes back through the roster, and
 * a refusal is shown rather than swallowed.
 */
describe("the Subagents panel's controls", () => {
  function renderRoster(options: {
    roster: unknown[];
    steer?: (input: unknown) => Promise<unknown>;
    stop?: (input: unknown) => Promise<unknown>;
  }) {
    return renderPanel({
      rpc: {
        roster: vi.fn().mockResolvedValue({
          state: "ready",
          activeSessionId: "sess_panel",
          children: options.roster,
        }),
        ...(options.steer === undefined ? {} : { steer: options.steer }),
        ...(options.stop === undefined ? {} : { stop: options.stop }),
      },
    });
  }

  it("offers a steer and a stop to a running child and neither to a finished one", async () => {
    const slot = renderRoster({
      roster: [
        scoutChild(),
        scoutChild({
          id: "child_2",
          label: "digger",
          status: "done",
          activeSessionId: "sess_child_2",
          answerPreview: "dug it all",
        }),
      ],
    });
    await slot.findByText("scout");

    expect(screen.getByLabelText("Steer scout")).toBeDefined();
    expect(screen.queryByLabelText("Steer digger")).toBeNull();
    expect(screen.getByRole("button", { name: "Stop" })).toBeDefined();

    // An empty steer cannot be sent.
    const send = screen.getByRole("button", { name: "Send" });
    expect(send).toHaveProperty("disabled", true);
    slot.lifecycle.unmount();
  });

  it("sends the steer to the plugin server, clears the input when prime takes it", async () => {
    let accept!: (answer: unknown) => void;
    const steer = vi.fn(
      () =>
        new Promise((resolve) => {
          accept = resolve;
        }),
    );
    const slot = renderRoster({ roster: [scoutChild()], steer });
    await slot.findByText("scout");

    fireEvent.change(screen.getByLabelText("Steer scout"), {
      target: { value: "  Focus on the parser  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    // Pending, not done: the row is busy while prime has the message.
    await screen.findByText("Sending…");
    expect(screen.getByLabelText("Steer scout")).toHaveProperty("disabled", true);

    await act(async () => {
      accept({ activeSessionId: "sess_panel", delivery: "queued" });
    });
    await screen.findByText("Steer queued.");
    expect(steer).toHaveBeenCalledWith({
      threadId: "thr_panel",
      childId: "child_1",
      // Trimmed here, so the daemon never sees padding prime would reject.
      message: "Focus on the parser",
      activeSessionId: "sess_panel",
    });
    expect((screen.getByLabelText("Steer scout") as HTMLInputElement).value).toBe("");
    expect(screen.getByLabelText("Steer scout")).toHaveProperty("disabled", false);
    slot.lifecycle.unmount();
  });

  it("shows a refused steer and keeps what the user typed", async () => {
    const slot = renderRoster({
      roster: [scoutChild()],
      steer: vi.fn().mockRejectedValue(
        new Error(
          'prime-agent has no subagent "child_1" in session sess_panel',
        ),
      ),
    });
    await slot.findByText("scout");

    fireEvent.change(screen.getByLabelText("Steer scout"), {
      target: { value: "Focus on the parser" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await screen.findByRole("alert");
    expect(screen.getByText(/Steer refused: /)).toBeDefined();
    expect((screen.getByLabelText("Steer scout") as HTMLInputElement).value).toBe(
      "Focus on the parser",
    );
    expect(screen.getByRole("button", { name: "Send" })).toHaveProperty(
      "disabled",
      false,
    );
    slot.lifecycle.unmount();
  });

  it("stops the child, stays honest while prime works, and shows the verdict from the roster", async () => {
    let children = [scoutChild()];
    let accept!: (answer: unknown) => void;
    const slot = renderPanel({
      rpc: {
        roster: vi.fn().mockImplementation(async () => ({
          state: "ready",
          activeSessionId: "sess_panel",
          children,
        })),
        stop: vi.fn(
          () =>
            new Promise((resolve) => {
              accept = resolve;
            }),
        ),
      },
    });
    await slot.findByText("scout");

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await screen.findByText("Stopping…");
    // Pending is all the panel claims: prime has not answered, so the child
    // is still running as far as this panel is concerned.
    expect(screen.getByText("running")).toBeDefined();
    expect(screen.getByLabelText("Steer scout")).toHaveProperty("disabled", true);

    // The authoritative change: prime cancelled, the roster reports it.
    children = [
      scoutChild({ status: "cancelled", recap: "stopped from the panel" }),
    ];
    await act(async () => {
      accept({ activeSessionId: "sess_panel", cancelled: true });
    });
    await slot.findByText("cancelled");
    expect(screen.queryByText("running")).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(screen.queryByLabelText("Steer scout")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("shows a stop prime refused, with the child still running", async () => {
    const slot = renderRoster({
      roster: [scoutChild()],
      stop: vi.fn().mockRejectedValue(
        new Error(
          'prime-agent answered "cancel_rlm_child" with cancelled:false — the subagent was not running, so nothing was stopped',
        ),
      ),
    });
    await slot.findByText("scout");

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await screen.findByText(/Stop refused: /);
    expect(screen.getByText("running")).toBeDefined();
    // The row is usable again: another attempt is one click away.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Stop" })).toHaveProperty(
        "disabled",
        false,
      ),
    );
    slot.lifecycle.unmount();
  });
});

/**
 * The transcript (bbpa-b1m.8): a child row opens its bounded transcript —
 * read-only, polled while open, and honest about a child that has not booted.
 */
describe("the Subagents panel's child transcript", () => {
  function renderRosterWithTranscript(options: {
    transcript?: (input: unknown) => Promise<unknown>;
  } = {}) {
    return renderPanel({
      rpc: {
        roster: vi.fn().mockResolvedValue({
          state: "ready",
          activeSessionId: "sess_panel",
          children: [scoutChild()],
        }),
        ...(options.transcript === undefined ? {} : { transcript: options.transcript }),
      },
    });
  }

  const readyTranscript = {
    state: "ready",
    activeSessionId: "sess_panel",
    truncated: false,
    entries: [
      { kind: "user", text: "scout the repo" },
      { kind: "thinking", text: "start at the manifest" },
      { kind: "assistant", text: "found the parser" },
      {
        kind: "tool",
        toolName: "bash",
        argsPreview: '{"command":"ls"}',
        resultText: "README",
      },
    ],
  };

  it("opens a child's transcript, renders its roles, and closes it", async () => {
    const transcript = vi.fn().mockResolvedValue(readyTranscript);
    const slot = renderRosterWithTranscript({ transcript });
    await slot.findByText("scout");

    // Closed until asked; opening asks exactly once, carrying the session.
    expect(transcript).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Transcript: scout" }));
    await slot.findByText("scout the repo");
    await waitFor(() =>
      expect(transcript).toHaveBeenCalledWith({
        threadId: "thr_panel",
        childId: "child_1",
        activeSessionId: "sess_panel",
      }),
    );
    expect(screen.getByText("found the parser")).toBeDefined();
    expect(screen.getByText(/bash/)).toBeDefined();
    expect(screen.getByText("README")).toBeDefined();

    // Closing unmounts the transcript view.
    fireEvent.click(screen.getByRole("button", { name: "Transcript: scout" }));
    await waitFor(() => expect(screen.queryByText("scout the repo")).toBeNull());
    slot.lifecycle.unmount();
  });

  it("says a child without a session has no transcript yet", async () => {
    const slot = renderRosterWithTranscript({
      transcript: vi.fn().mockResolvedValue({
        state: "no_session",
        activeSessionId: "sess_panel",
        entries: [],
        truncated: false,
      }),
    });
    await slot.findByText("scout");
    fireEvent.click(screen.getByRole("button", { name: "Transcript: scout" }));
    await slot.findByText(/has not started yet/);
    slot.lifecycle.unmount();
  });

  it("says when older entries were dropped by the history bounds", async () => {
    const slot = renderRosterWithTranscript({
      transcript: vi.fn().mockResolvedValue({
        ...readyTranscript,
        truncated: true,
      }),
    });
    await slot.findByText("scout");
    fireEvent.click(screen.getByRole("button", { name: "Transcript: scout" }));
    await slot.findByText(/older entries/i);
    slot.lifecycle.unmount();
  });

  it("keeps a transcript open current: refetch on roster signals and on the clock", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const transcript = vi.fn().mockResolvedValue(readyTranscript);
      const slot = renderRosterWithTranscript({ transcript });
      await slot.findByText("scout");
      fireEvent.click(screen.getByRole("button", { name: "Transcript: scout" }));
      await slot.findByText("scout the repo");
      const asksAfterOpen = transcript.mock.calls.length;

      // A roster signal for this thread's session is worth asking again.
      await slot.behavior.emitRealtime("subagents", { activeSessionId: "sess_panel" });
      await waitFor(() => expect(transcript.mock.calls.length).toBeGreaterThan(asksAfterOpen));

      // And so is the passage of time while the transcript stays open.
      const asksBeforeTick = transcript.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_500);
      });
      await waitFor(() => expect(transcript.mock.calls.length).toBeGreaterThan(asksBeforeTick));
      slot.lifecycle.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces a transcript read failure as an alert", async () => {
    const slot = renderRosterWithTranscript({
      transcript: vi.fn().mockRejectedValue(new Error("the host went away")),
    });
    await slot.findByText("scout");
    fireEvent.click(screen.getByRole("button", { name: "Transcript: scout" }));
    await slot.findByText(/the host went away/);
    slot.lifecycle.unmount();
  });
});

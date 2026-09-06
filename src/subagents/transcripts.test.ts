import { describe, expect, it } from "vitest";
import type { DaemonCommandResult } from "../daemon/client.js";
import type { DaemonPushMessage } from "../daemon/protocol.js";
import type { SubagentsRosterSeams } from "./roster.js";
import { ChildTranscripts } from "./transcripts.js";

/**
 * The child-transcript tracker, against a scripted daemon.
 *
 * The tracker is the transcript's read path (bbpa-b1m.8): a read-only attach
 * to the child's own daemon session — the only wire surface that answers for
 * a session the bridge does not own, and the only one that rehydrates a
 * passivated child — seeded by `snapshot.messages`, kept current by durable
 * `message_end` pushes, bounded by count and bytes, and given up when nobody
 * reads it anymore.
 */

function pushMessage(
  activeSessionId: string,
  event: unknown,
  sequence = 10,
): DaemonPushMessage {
  return {
    type: "session_event",
    activeSessionId,
    event,
    meta: { sequence, cursor: { generation: "gen-0", sequence } },
  } as unknown as DaemonPushMessage;
}

function messageEnd(message: Record<string, unknown>) {
  return { type: "message_end", message };
}

interface ScriptedBackend {
  readonly commands: Array<Record<string, unknown>>;
  push(message: DaemonPushMessage): void;
  reconnect(): void;
  failNextAttach(reason: string): void;
}

function scriptedBackend(
  args: { messages?: unknown[]; lastEventCursor?: { generation: string; sequence: number } } = {},
): { backend: ScriptedBackend; seams: SubagentsRosterSeams } {
  const commands: Array<Record<string, unknown>> = [];
  const listeners = new Set<(message: DaemonPushMessage) => void>();
  const reconnectListeners = new Set<() => void>();
  let attachFailure: string | undefined;
  function answerFor(command: Record<string, unknown>): DaemonCommandResult {
    if (command.type === "attach") {
      if (attachFailure !== undefined) {
        return { command: "attach", success: false, error: attachFailure };
      }
      return {
        command: "attach",
        success: true,
        data: {
          snapshot: { messages: args.messages ?? [] },
          lastEventSequence: args.lastEventCursor?.sequence ?? 0,
          lastEventCursor: args.lastEventCursor ?? { generation: "gen-0", sequence: 0 },
        },
      };
    }
    return { command: String(command.type), success: true };
  }
  const backend: ScriptedBackend = {
    commands,
    push(message) {
      for (const listener of listeners) {
        listener(message);
      }
    },
    reconnect() {
      for (const listener of [...reconnectListeners]) {
        listener();
      }
    },
    failNextAttach(reason) {
      attachFailure = reason;
    },
  };
  const seams: SubagentsRosterSeams = {
    async request(command) {
      commands.push(command);
      return answerFor(command);
    },
    subscribePush(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onReconnect(listener) {
      reconnectListeners.add(listener);
      return () => {
        reconnectListeners.delete(listener);
      };
    },
  };
  return { backend, seams };
}

describe("ChildTranscripts", () => {
  it("attaches read-only to the child's own session and seeds from the snapshot", async () => {
    const { backend, seams } = scriptedBackend({
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: [{ type: "text", text: "done scouting" }] },
      ],
    });
    const transcripts = new ChildTranscripts(seams);
    const transcript = await transcripts.read("sess_child");
    expect(backend.commands).toEqual([
      {
        type: "attach",
        activeSessionId: "sess_child",
        capabilities: expect.any(Array),
      },
    ]);
    expect(transcript.entries).toEqual([
      { kind: "user", text: "go" },
      { kind: "assistant", text: "done scouting" },
    ]);
    expect(transcript.truncated).toBe(false);
    await transcripts.dispose();
  });
});

describe("ChildTranscripts push maintenance", () => {
  it("appends durable message_end pushes and ignores streaming and stale ones", async () => {
    // The attach snapshot ends at cursor gen-0:5; a replayed push at sequence
    // 5 is the seed's own history, 6 is live.
    const { backend, seams } = scriptedBackend({
      messages: [{ role: "user", content: "go" }],
      lastEventCursor: { generation: "gen-0", sequence: 5 },
    });
    const transcripts = new ChildTranscripts(seams);
    await transcripts.read("sess_child");

    backend.push(
      pushMessage("sess_child", {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "working" }] },
      }),
    );
    backend.push(
      pushMessage("sess_child", {
        type: "message_update",
        message: { role: "assistant", content: [{ type: "text", text: "partial" }] },
      }),
    );
    // A replay at the snapshot's own cursor: already in the seed, never again.
    backend.push(
      pushMessage(
        "sess_child",
        {
          type: "message_end",
          message: { role: "user", content: "history the seed already has" },
        },
        5,
      ),
    );
    const transcript = await transcripts.read("sess_child");
    expect(transcript.entries).toEqual([
      { kind: "user", text: "go" },
      { kind: "assistant", text: "working" },
    ]);
    expect(transcript.truncated).toBe(false);
    await transcripts.dispose();
  });

  it("pairs a pushed toolResult into the tool row its call opened", async () => {
    const { backend, seams } = scriptedBackend({
      messages: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "tc_1", name: "bash", arguments: { command: "ls" } }],
        },
      ],
      lastEventCursor: { generation: "gen-0", sequence: 5 },
    });
    const transcripts = new ChildTranscripts(seams);
    await transcripts.read("sess_child");

    backend.push(
      pushMessage("sess_child", {
        type: "message_end",
        message: {
          role: "toolResult",
          toolCallId: "tc_1",
          toolName: "bash",
          content: [{ type: "text", text: "README" }],
          isError: true,
        },
      }),
    );
    const transcript = await transcripts.read("sess_child");
    expect(transcript.entries).toEqual([
      {
        kind: "tool",
        toolName: "bash",
        argsPreview: '{"command":"ls"}',
        resultText: "README",
        isError: true,
      },
    ]);
    await transcripts.dispose();
  });

  it("drops a child session that the daemon closes or replaces", async () => {
    const { backend, seams } = scriptedBackend({
      messages: [{ role: "user", content: "go" }],
    });
    const transcripts = new ChildTranscripts(seams);
    await transcripts.read("sess_child");

    backend.push({ type: "session_closed", activeSessionId: "sess_child" } as DaemonPushMessage);
    // The cache is gone: the next read attaches again (fresh seed).
    await transcripts.read("sess_child");
    const attaches = backend.commands.filter((command) => command.type === "attach");
    expect(attaches).toHaveLength(2);
    await transcripts.dispose();
  });
});

describe("ChildTranscripts lifecycle", () => {
  it("reads an attached child from the cache without re-attaching", async () => {
    const { backend, seams } = scriptedBackend({
      messages: [{ role: "user", content: "go" }],
    });
    const transcripts = new ChildTranscripts(seams);
    await transcripts.read("sess_child");
    await transcripts.read("sess_child");
    await transcripts.read("sess_child");
    const attaches = backend.commands.filter((command) => command.type === "attach");
    expect(attaches).toHaveLength(1);
    await transcripts.dispose();
  });

  it("holds the bounds across appends, dropping the oldest rows", async () => {
    const { backend, seams } = scriptedBackend({
      messages: [{ role: "user", content: "first" }],
      lastEventCursor: { generation: "gen-0", sequence: 5 },
    });
    const transcripts = new ChildTranscripts(seams, {
      bounds: { maxEntries: 2, maxTotalBytes: Number.MAX_SAFE_INTEGER },
    });
    await transcripts.read("sess_child");
    for (const text of ["second", "third"]) {
      backend.push(
        pushMessage("sess_child", {
          type: "message_end",
          message: { role: "user", content: text },
        }),
      );
    }
    const transcript = await transcripts.read("sess_child");
    expect(transcript.entries.map((entry) => entry.text)).toEqual(["second", "third"]);
    expect(transcript.truncated).toBe(true);
    await transcripts.dispose();
  });

  it("releases an uninteresting child: detach exactly that session", async () => {
    const { backend, seams } = scriptedBackend({
      messages: [{ role: "user", content: "go" }],
    });
    const transcripts = new ChildTranscripts(seams);
    await transcripts.read("sess_child");
    await transcripts.read("sess_other");
    await transcripts.release("sess_child");
    expect(backend.commands.at(-1)).toEqual({
      type: "detach",
      activeSessionId: "sess_child",
    });
    // The released child's read attaches again; the kept one does not.
    await transcripts.read("sess_child");
    const attaches = backend.commands.filter((command) => command.type === "attach");
    expect(attaches).toHaveLength(3);
    await transcripts.dispose();
  });

  it("sweeps children nobody read within the TTL", async () => {
    const { backend, seams } = scriptedBackend({
      messages: [{ role: "user", content: "go" }],
    });
    const transcripts = new ChildTranscripts(seams, {
      interestTtlMs: 1_000,
      sweepIntervalMs: 0,
    });
    await transcripts.read("sess_child");
    const dropped = await transcripts.sweepIdle(Date.now() + 1_500);
    expect(dropped).toEqual(["sess_child"]);
    expect(backend.commands.at(-1)).toEqual({
      type: "detach",
      activeSessionId: "sess_child",
    });
    await transcripts.dispose();
  });

  it("re-attaches every still-open child when the connection comes back", async () => {
    const { backend, seams } = scriptedBackend({
      messages: [{ role: "user", content: "go" }],
    });
    const transcripts = new ChildTranscripts(seams);
    await transcripts.read("sess_child");
    await transcripts.read("sess_other");
    backend.reconnect();
    // Let the re-attach settle.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    const attaches = backend.commands.filter((command) => command.type === "attach");
    expect(attaches).toHaveLength(4);
    // The seed replaced whatever pushes had added: reads answer the fresh seed.
    const transcript = await transcripts.read("sess_child");
    expect(transcript.entries).toEqual([{ kind: "user", text: "go" }]);
    await transcripts.dispose();
  });

  it("answers a refused attach with a legible error, not an empty transcript", async () => {
    const { backend, seams } = scriptedBackend();
    backend.failNextAttach("Unknown active session: sess_gone");
    const transcripts = new ChildTranscripts(seams);
    await expect(transcripts.read("sess_gone")).rejects.toThrow(
      /refused to attach for the transcript of sess_gone: Unknown active session/,
    );
    // The failed read left nothing behind to sweep or re-attach.
    expect(await transcripts.sweepIdle(Number.MAX_SAFE_INTEGER)).toEqual([]);
    await transcripts.dispose();
  });
});

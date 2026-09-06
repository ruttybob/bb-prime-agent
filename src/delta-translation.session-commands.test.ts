import { describe, expect, it } from "vitest";
import { createPrimeDeltaTranslator } from "./delta-translation.js";
import type { ThreadDelta } from "@get-bb/plugin-sdk/provider-bridge";

/**
 * prime's session slash commands on the bb timeline (bbpa-b1m.1).
 *
 * When a prompt parses as a session command, prime appends a durable custom
 * message for the command and, once it has run, one for its result — each
 * announced by a `message_start`/`message_end` pair carrying the same
 * message. The command opens a `prime-agent/session-command` extension item,
 * the result closes it; anything else these events bracket renders nothing,
 * and a snapshot replay of old messages renders the same rows settled.
 */

const CONTEXT = { threadId: "thr_commands", cwd: "/tmp/prime-workspace" };

interface CommandFixture {
  name: string;
  args: string;
  text: string;
}

function commandMessage(
  command: CommandFixture,
): Record<string, unknown> {
  return {
    role: "custom",
    customType: "session_slash_command",
    content: command.text,
    display: true,
    details: { command },
  };
}

function resultMessage(args: {
  command: CommandFixture;
  content: string;
  success?: boolean;
  severity?: string;
  error?: string;
}): Record<string, unknown> {
  return {
    role: "custom",
    customType: "session_slash_command_result",
    content: args.content,
    display: true,
    details: {
      command: args.command,
      success: args.success,
      severity: args.severity,
      ...(args.error === undefined ? {} : { error: args.error }),
    },
  };
}

function push(type: "message_start" | "message_end", message: unknown): unknown {
  return { type, message };
}

const GOAL: CommandFixture = {
  name: "goal",
  args: "ship bbpa-b1m",
  text: "/goal ship bbpa-b1m",
};

describe("a live session command", () => {
  it("opens a pending row on the command's start and closes it on the result", () => {
    const translator = createPrimeDeltaTranslator();
    const opened = translator.translate(
      push("message_start", commandMessage(GOAL)),
      CONTEXT,
    );
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({
      kind: "item.open",
      key: { channel: "session-command-1" },
      item: {
        type: "extension",
        kind: "prime-agent/session-command",
        payload: {
          command: "goal",
          args: "ship bbpa-b1m",
          text: "/goal ship bbpa-b1m",
          phase: "requested",
        },
      },
      attach: "currentOrLast",
      presentation: {
        label: { pending: "/goal", completed: "/goal" },
        icon: { glyph: "terminal" },
        title: "/goal ship bbpa-b1m",
      },
    });

    // prime announces every durable message as a start/end pair carrying the
    // same message: the end is the pair's echo and adds no row.
    expect(
      translator.translate(push("message_end", commandMessage(GOAL)), CONTEXT),
    ).toEqual([]);

    const closed = translator.translate(
      push(
        "message_start",
        resultMessage({
          command: GOAL,
          content: "Goal set: ship bbpa-b1m",
          success: true,
          severity: "info",
        }),
      ),
      CONTEXT,
    );
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({
      kind: "item.close",
      key: { channel: "session-command-1" },
      item: {
        type: "extension",
        kind: "prime-agent/session-command",
        payload: {
          command: "goal",
          phase: "succeeded",
        },
      },
      status: "completed",
      resultText: "Goal set: ship bbpa-b1m",
    });
  });

  it("renders nothing for the user message that started the command", () => {
    const translator = createPrimeDeltaTranslator();
    // The prompt itself rides message_start too (role user) — same behavior
    // as when these events were ignored outright.
    expect(
      translator.translate(
        push("message_start", {
          role: "user",
          content: "/goal ship bbpa-b1m",
        }),
        CONTEXT,
      ),
    ).toEqual([]);
    expect(
      translator.translate(
        push("message_start", {
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
        }),
        CONTEXT,
      ),
    ).toEqual([]);
  });

  it("closes failed with prime's error when the command fails", () => {
    const translator = createPrimeDeltaTranslator();
    translator.translate(push("message_start", commandMessage(GOAL)), CONTEXT);
    const closed = translator.translate(
      push(
        "message_start",
        resultMessage({
          command: GOAL,
          content: "Command failed: no goal set",
          success: false,
          severity: "error",
          error: "no goal set",
        }),
      ),
      CONTEXT,
    );
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({
      kind: "item.close",
      status: "failed",
      item: {
        payload: { phase: "failed", error: "no goal set" },
      },
      resultText: "Command failed: no goal set",
    });
  });

  it("marks failure by severity alone when success is missing", () => {
    const translator = createPrimeDeltaTranslator();
    translator.translate(push("message_start", commandMessage(GOAL)), CONTEXT);
    const closed = translator.translate(
      push(
        "message_start",
        resultMessage({
          command: GOAL,
          content: "Command failed: unreachable",
          severity: "error",
        }),
      ),
      CONTEXT,
    );
    expect(closed[0]).toMatchObject({
      kind: "item.close",
      status: "failed",
      item: { payload: { phase: "failed" } },
    });
  });

  it("renders a result with no open row as a settled pair", () => {
    const translator = createPrimeDeltaTranslator();
    const settled = translator.translate(
      push(
        "message_start",
        resultMessage({
          command: GOAL,
          content: "Goal set: ship bbpa-b1m",
          success: true,
          severity: "info",
        }),
      ),
      CONTEXT,
    );
    // Prime answered before this bridge attached (or the open was malformed):
    // the result still shows, opened and closed in one breath.
    expect(settled.map((delta) => delta.kind)).toEqual([
      "item.open",
      "item.close",
    ]);
    expect(settled[0]).toMatchObject({
      kind: "item.open",
      key: { channel: "session-command-1" },
      item: { payload: { phase: "succeeded" } },
    });
    // The pair shares the one key: bb assembles them into a single row.
    expect(settled[1]).toMatchObject({
      kind: "item.close",
      key: { channel: "session-command-1" },
      status: "completed",
      resultText: "Goal set: ship bbpa-b1m",
    });
  });

  it("settles nested invocations of one command inside-out", () => {
    const translator = createPrimeDeltaTranslator();
    translator.translate(push("message_start", commandMessage(GOAL)), CONTEXT);
    translator.translate(push("message_start", commandMessage(GOAL)), CONTEXT);
    const first = translator.translate(
      push(
        "message_start",
        resultMessage({
          command: GOAL,
          content: "second goal set",
          success: true,
          severity: "info",
        }),
      ),
      CONTEXT,
    );
    // The most recent open row with the result's command name closes first.
    expect(first[0]).toMatchObject({
      kind: "item.close",
      key: { channel: "session-command-2" },
    });
    const second = translator.translate(
      push(
        "message_start",
        resultMessage({
          command: GOAL,
          content: "first goal set",
          success: true,
          severity: "info",
        }),
      ),
      CONTEXT,
    );
    expect(second[0]).toMatchObject({
      kind: "item.close",
      key: { channel: "session-command-1" },
    });
  });

  it("caps a long row title but keeps the payload whole", () => {
    const translator = createPrimeDeltaTranslator();
    const longArgs = "x".repeat(300);
    const opened = translator.translate(
      push("message_start", commandMessage({
        name: "goal",
        args: longArgs,
        text: `/goal ${longArgs}`,
      })),
      CONTEXT,
    );
    const presentation = (opened[0] as { presentation: { title: string } })
      .presentation;
    expect(presentation.title.length).toBeLessThanOrEqual(120);
    expect(opened[0]).toMatchObject({
      item: { payload: { args: longArgs } },
    });
  });
});

describe("messages that are not session commands", () => {
  it("renders nothing for prime's other custom types", () => {
    const translator = createPrimeDeltaTranslator();
    for (const customType of [
      "heartbeat_prompt",
      "ipython_state_restored",
      "compaction_outcome",
      "rlm_child_failure",
      "some_future_custom_type",
    ]) {
      expect(
        translator.translate(
          push("message_start", {
            role: "custom",
            customType,
            content: "whatever prime wrote",
            display: true,
            details: {},
          }),
          CONTEXT,
        ),
      ).toEqual([]);
    }
  });

  it("drops malformed command details silently", () => {
    const translator = createPrimeDeltaTranslator();
    const broken: unknown[] = [
      // No details at all / details without a command.
      { role: "custom", customType: "session_slash_command", content: "/goal", display: true },
      { role: "custom", customType: "session_slash_command", content: "/goal", display: true, details: {} },
      // A command without a usable name.
      { role: "custom", customType: "session_slash_command", content: "/goal", display: true, details: { command: { args: "" } } },
      { role: "custom", customType: "session_slash_command", content: "/goal", display: true, details: { command: { name: 42 } } },
      // Same malformations on the result side.
      { role: "custom", customType: "session_slash_command_result", content: "done", display: true, details: {} },
      { role: "custom", customType: "session_slash_command_result", content: "done", display: true, details: { command: "goal" } },
    ];
    for (const message of broken) {
      expect(translator.translate(push("message_start", message), CONTEXT)).toEqual([]);
    }
    // A well-formed pair after the malformed ones still keys from 1: nothing
    // was consumed by the dropped rows.
    translator.translate(push("message_start", commandMessage(GOAL)), CONTEXT);
    expect(
      translator.translate(
        push(
          "message_start",
          resultMessage({
            command: GOAL,
            content: "Goal set",
            success: true,
            severity: "info",
          }),
        ),
        CONTEXT,
      ),
    ).toMatchObject([{ kind: "item.close", key: { channel: "session-command-1" } }]);
  });

  it("survives events that are not even shaped like message pushes", () => {
    const translator = createPrimeDeltaTranslator();
    expect(translator.translate({ type: "message_start" }, CONTEXT)).toEqual([]);
    expect(translator.translate({ type: "message_end" }, CONTEXT)).toEqual([]);
    expect(translator.translate("not an event", CONTEXT)).toEqual([]);
  });
});

describe("a snapshot replay of session commands", () => {
  it("renders the historical commands and leaves no pending rows", () => {
    const translator = createPrimeDeltaTranslator();
    const deltas = translator.snapshotDeltas([
      { role: "user", content: "/goal ship bbpa-b1m" },
      commandMessage(GOAL),
      resultMessage({
        command: GOAL,
        content: "Goal set: ship bbpa-b1m",
        success: true,
        severity: "info",
      }),
      commandMessage({ name: "refine", args: "", text: "/refine" }),
      // A command prime never answered in the captured transcript.
      commandMessage({ name: "autonomous", args: "on", text: "/autonomous on" }),
    ]);

    expect(deltas[0]).toMatchObject({ kind: "input.provider", text: "/goal ship bbpa-b1m" });
    // First command: opened pending, closed by its result.
    expect(deltas[1]).toMatchObject({
      kind: "item.open",
      key: { channel: "session-command-1" },
      item: { payload: { command: "goal", phase: "requested" } },
    });
    expect(deltas[2]).toMatchObject({
      kind: "item.close",
      key: { channel: "session-command-1" },
      item: { payload: { phase: "succeeded" } },
      status: "completed",
      resultText: "Goal set: ship bbpa-b1m",
    });
    // The resultless commands settle in one breath, so replay never leaves a
    // pending row behind.
    expect(deltas[3]).toMatchObject({
      kind: "item.open",
      key: { channel: "session-command-2" },
      item: { payload: { command: "refine", phase: "requested" } },
    });
    // ... the autonomous command opens in message order beside it ...
    expect(deltas[4]).toMatchObject({
      kind: "item.open",
      key: { channel: "session-command-3" },
      item: { payload: { command: "autonomous", phase: "requested" } },
    });
    // ... and the end-of-pass settlement closes each still-open row once,
    // without minting a second open.
    expect(deltas[5]).toMatchObject({
      kind: "item.close",
      key: { channel: "session-command-2" },
      item: { payload: { phase: "interrupted" } },
      status: "interrupted",
    });
    expect(deltas[6]).toMatchObject({
      kind: "item.close",
      key: { channel: "session-command-3" },
      status: "interrupted",
    });

    // The replay invariant itself: every open has its close.
    const opens = deltas.filter((delta) => delta.kind === "item.open");
    const closes = deltas.filter((delta: ThreadDelta) => delta.kind === "item.close");
    expect(closes).toHaveLength(opens.length);
  });

  it("keeps custom types that are not session commands out of the replay", () => {
    const translator = createPrimeDeltaTranslator();
    const deltas = translator.snapshotDeltas([
      {
        role: "custom",
        customType: "heartbeat_prompt",
        content: "beat",
        display: true,
        details: {},
      },
    ]);
    expect(deltas).toEqual([]);
  });
});

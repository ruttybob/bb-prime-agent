import { describe, expect, it } from "vitest";
import { PRIME_SESSION_COMMANDS } from "./src/session-commands.js";
import { type ScriptedDaemonHandle } from "./test-support/scripted-daemon.js";
import {
  CLIENT_REQUEST_ID,
  FULL_OPTIONS,
  startBridgeHarness,
  type BridgeResponse,
} from "./test-support/bridge-harness.js";

/**
 * `/refine` from bb, end to end (bbpa-b1m.5). The substrate (bbpa-b1m.1)
 * carries the command text; this ticket exists to verify refine's argument
 * grammar and result rendering from bb's side of the wire:
 *
 * - prime parses the args itself (`parseRefineCommandOptions` in its
 *   `slash-commands.js`: `[--global]`, `rollback <refinement-id>`, bare
 *   instructions) — the bridge's job is to deliver the text UNTOUCHED, so
 *   every grammar the session implements stays reachable;
 * - the outcome lands as `session_slash_command` + `session_slash_command_result`
 *   rows, including the FAILURE shape prime answers with (its usage errors,
 *   e.g. `/refine rollback` with no id) — the row must show the failure, not
 *   a quiet success.
 */

let daemon: ScriptedDaemonHandle;

const h = startBridgeHarness({
  session: {
    activeSessionId: "sess_1",
    sessionFile: "/tmp/prime/sessions/sess_1.jsonl",
    sessionName: "[bb] scripted thread",
    cwd: "/tmp/prime-workspace",
  },
  beforeEachExtra: (harness) => {
    daemon = harness.daemon;
  },
});

const { cwd, sendRequest, waitForResponse, deltas } = h;

function commandMessage(args: { text: string; args: string }): Record<string, unknown> {
  return {
    role: "custom",
    customType: "session_slash_command",
    content: args.text,
    display: true,
    details: { command: { name: "refine", args: args.args, text: args.text } },
  };
}

function resultMessage(args: {
  text: string;
  args: string;
  content: string;
  success: boolean;
  severity: string;
  error?: string;
}): Record<string, unknown> {
  return {
    role: "custom",
    customType: "session_slash_command_result",
    content: args.content,
    display: true,
    details: {
      command: { name: "refine", args: args.args, text: args.text },
      success: args.success,
      severity: args.severity,
      ...(args.error === undefined ? {} : { error: args.error }),
    },
  };
}

async function startThread(id: string, threadId: string): Promise<string> {
  daemon.enqueueCreate();
  daemon.enqueueAttach();
  sendRequest(id, "thread/start", {
    threadId,
    cwd,
    instructionMode: "append",
    options: FULL_OPTIONS,
  });
  const reply = await waitForResponse(id);
  expect(reply.error).toBeUndefined();
  return String(reply.result?.providerThreadId);
}

async function runRefine(args: {
  id: string;
  threadId: string;
  providerThreadId: string;
  text: string;
  commandArgs: string;
  events: readonly unknown[];
}): Promise<BridgeResponse> {
  daemon.enqueuePrompt({ events: args.events });
  sendRequest(args.id, "turn/start", {
    threadId: args.threadId,
    providerThreadId: args.providerThreadId,
    input: [{ type: "text", text: args.text, mentions: [] }],
    clientRequestId: CLIENT_REQUEST_ID,
    options: FULL_OPTIONS,
  });
  return waitForResponse(args.id);
}

describe("/refine from bb (bbpa-b1m.5)", () => {
  it("offers refine in the menu with prime's own words", () => {
    const refine = PRIME_SESSION_COMMANDS.find((command) => command.name === "refine");
    // Verbatim from prime's CANONICAL_BUILTIN_SLASH_COMMANDS: the description
    // is what the session runs, the menu must not paraphrase it. prime names
    // no argumentHint for refine — its grammar lives in the description.
    expect(refine).toMatchObject({
      description:
        "Refine continual harness prompt notes, skills, subagents, and memory",
      argumentHint: undefined,
    });
  });

  it("delivers --global instructions untouched and renders the outcome row", async () => {
    const threadId = "thr_refine";
    const providerThreadId = await startThread("s1", threadId);
    const text = "/refine --global check the skills inventory";
    const reply = await runRefine({
      id: "t1",
      threadId,
      providerThreadId,
      text,
      commandArgs: text.slice("/refine".length + 1),
      events: [
        { type: "agent_start" },
        {
          type: "message_start",
          message: commandMessage({
            text,
            args: "--global check the skills inventory",
          }),
        },
        {
          type: "message_end",
          message: commandMessage({
            text,
            args: "--global check the skills inventory",
          }),
        },
        {
          type: "message_start",
          message: resultMessage({
            text,
            args: "--global check the skills inventory",
            content: "Refinement recorded: prompt note updated (refine_1)",
            success: true,
            severity: "info",
          }),
        },
        {
          type: "message_end",
          message: resultMessage({
            text,
            args: "--global check the skills inventory",
            content: "Refinement recorded: prompt note updated (refine_1)",
            success: true,
            severity: "info",
          }),
        },
        { type: "agent_end", messages: [] },
      ],
    });
    expect(reply.error).toBeUndefined();

    // The prompt reached the daemon verbatim — the bridge is a passthrough
    // for command text, never a rewriter of args it does not own.
    expect(daemon.commands.find((command) => command.type === "prompt")).toMatchObject({
      message: text,
    });

    const threadDeltas = deltas(threadId);
    const opens = threadDeltas.filter((delta) => delta.kind === "item.open");
    const closes = threadDeltas.filter((delta) => delta.kind === "item.close");
    expect(opens).toHaveLength(1);
    expect(opens[0]).toMatchObject({
      item: {
        kind: "prime-agent/session-command",
        payload: {
          command: "refine",
          args: "--global check the skills inventory",
          phase: "requested",
        },
      },
    });
    expect(closes).toHaveLength(1);
    expect(closes[0]).toMatchObject({
      item: {
        payload: {
          command: "refine",
          phase: "succeeded",
        },
      },
      status: "completed",
      resultText: "Refinement recorded: prompt note updated (refine_1)",
    });
  });

  it("renders prime's usage refusal as a failed row, not silence", async () => {
    // `/refine rollback` without an id: parseRefineCommandOptions throws
    // "Usage: /refine rollback <refinement-id>", prime records a failed
    // result. The row must show the failure and its error text.
    const threadId = "thr_refine_err";
    const providerThreadId = await startThread("s2", threadId);
    const text = "/refine rollback";
    const reply = await runRefine({
      id: "t2",
      threadId,
      providerThreadId,
      text,
      commandArgs: "rollback",
      events: [
        { type: "agent_start" },
        {
          type: "message_start",
          message: commandMessage({ text, args: "rollback" }),
        },
        {
          type: "message_end",
          message: commandMessage({ text, args: "rollback" }),
        },
        {
          type: "message_start",
          message: resultMessage({
            text,
            args: "rollback",
            content: "Usage: /refine rollback <refinement-id>",
            success: false,
            severity: "error",
            error: "Usage: /refine rollback <refinement-id>",
          }),
        },
        {
          type: "message_end",
          message: resultMessage({
            text,
            args: "rollback",
            content: "Usage: /refine rollback <refinement-id>",
            success: false,
            severity: "error",
            error: "Usage: /refine rollback <refinement-id>",
          }),
        },
        { type: "agent_end", messages: [] },
      ],
    });
    expect(reply.error).toBeUndefined();

    const threadDeltas = deltas(threadId);
    const close = threadDeltas.find(
      (delta) => delta.kind === "item.close",
    ) as Record<string, unknown>;
    expect(close).toMatchObject({
      item: {
        payload: {
          command: "refine",
          args: "rollback",
          phase: "failed",
          error: "Usage: /refine rollback <refinement-id>",
        },
      },
      status: "failed",
    });
  });
});

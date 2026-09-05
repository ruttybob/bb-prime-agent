import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  experimental_captureBridgeJsonRpcOutput as captureBridgeJsonRpcOutput,
  type CapturedBridgeJsonRpcOutput,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import {
  currentConfiguredSkillRoots,
  handleLine,
  resetConfiguredSkillRootsForTests,
  resetDaemonForTests,
  sessionTableForTests,
} from "./src/provider-bridge.js";
import { setPrimeDaemonTransportFactoryForTests } from "./src/daemon/connection.js";
import {
  createScriptedDaemon,
  textTurnEvents,
  type ScriptedDaemonHandle,
} from "./test-support/scripted-daemon.js";

/**
 * The skills surface on the bridge (bbpa-ggf.8).
 *
 * `skills/configure` hands the bridge bb's own skill catalog before the first
 * thread command; a session created after that carries the roots in
 * `create.config.skills` — prime's additive `--skill` form, beside the
 * discovery that `noSkills: false` keeps on — and a session created before it
 * (or resumed) is untouched. The "/" menu half is bb-side (the declaration and
 * the host resolver); what the bridge owes is the prompt path: a skill
 * mention bb serialized as `/name` reaches prime as `/skill:name`, so prime's
 * own worker-side expansion runs the skill in the session.
 */

const SKILL_ROOTS = [
  {
    id: "bb-user",
    path: "/tmp/bb-skills/staged-user",
    skills: [{ name: "release-notes", description: "Write release notes" }],
  },
  {
    id: "bb-project",
    path: "/tmp/bb-skills/staged-project",
    skills: [{ name: "review", description: "Review a diff" }],
  },
];

let output: CapturedBridgeJsonRpcOutput;
let collected: unknown[] = [];
let daemon: ScriptedDaemonHandle;

beforeEach(() => {
  output = captureBridgeJsonRpcOutput();
  collected = [];
  daemon = createScriptedDaemon({
    session: {
      activeSessionId: "sess_skills",
      sessionFile: "/tmp/prime/sessions/sess_skills.jsonl",
      sessionName: "[bb] skills thread",
      cwd: "/tmp/prime-workspace",
    },
  });
  setPrimeDaemonTransportFactoryForTests(() => daemon.transport);
});

afterEach(() => {
  output.restore();
  setPrimeDaemonTransportFactoryForTests(undefined);
  resetDaemonForTests();
  resetConfiguredSkillRootsForTests();
  sessionTableForTests().clear();
});

function sendRequest(id: string, method: string, params: unknown): void {
  handleLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
}

interface Response {
  id: string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

function responses(): Response[] {
  collected.push(...output.takeMessages());
  return collected.filter(
    (message): message is Response =>
      typeof message === "object" &&
      message !== null &&
      !("method" in (message as Record<string, unknown>)),
  );
}

async function waitForResponse(id: string, timeoutMs = 2_000): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = responses().find((message) => message.id === id);
    if (found !== undefined) {
      return found;
    }
    if (Date.now() > deadline) {
      throw new Error(`no response with id ${id} within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function commands(type: string): Array<Record<string, unknown>> {
  return daemon.commands.filter(
    (command) => command.type === type,
  ) as Array<Record<string, unknown>>;
}

function createConfig(create: Record<string, unknown>): Record<string, unknown> {
  return create.config as Record<string, unknown>;
}

function promptMessages(): Array<Record<string, unknown>> {
  return commands("prompt");
}

const FULL_OPTIONS = {
  permissionMode: "full",
  permissionScope: "full",
  approvalReviewer: null,
  permissionEscalation: null,
};

/** A skill pick as bb's composer sends it: `/name` text plus the mention. */
function skillMention(name: string, start = 0): unknown {
  return {
    start,
    end: start + name.length + 1,
    resource: {
      kind: "command",
      trigger: "/",
      name,
      source: "skill",
      origin: "project",
      label: name,
      argumentHint: null,
    },
  };
}

/** Enqueue a full start (create, attach, first turn) and send `thread/start`. */
async function startThread(
  id: string,
  threadId: string,
  input?: Array<Record<string, unknown>>,
): Promise<string> {
  daemon.enqueueCreate();
  daemon.enqueueAttach();
  if (input !== undefined) {
    daemon.enqueuePrompt({ events: textTurnEvents({ text: "ok" }) });
  }
  sendRequest(id, "thread/start", {
    threadId,
    cwd: "/tmp/prime-workspace",
    instructionMode: "append",
    options: FULL_OPTIONS,
    ...(input === undefined ? {} : { input }),
  });
  const reply = await waitForResponse(id);
  expect(reply.error).toBeUndefined();
  return String(reply.result?.providerThreadId);
}

describe("skills/configure", () => {
  it("stores the catalog the runtime hands over before the first thread command", () => {
    sendRequest("k", "skills/configure", { roots: SKILL_ROOTS });
    expect(responses().find((reply) => reply.id === "k")?.result).toEqual({ ok: true });
    expect(currentConfiguredSkillRoots()).toEqual(SKILL_ROOTS);
  });

  it("loads the configured roots into sessions created after the configure", async () => {
    sendRequest("k", "skills/configure", { roots: SKILL_ROOTS });
    await startThread("s", "thr_after", [{ type: "text", text: "hi", mentions: [] }]);

    expect(createConfig(commands("create")[0]!).skills).toEqual([
      "/tmp/bb-skills/staged-user",
      "/tmp/bb-skills/staged-project",
    ]);
  });

  it("leaves the skills field off when nothing was configured", async () => {
    await startThread("s", "thr_plain", [{ type: "text", text: "hi", mentions: [] }]);

    const config = createConfig(commands("create")[0]!);
    expect(config.skills).toBeUndefined();
    // prime's own discovery stays on either way: its skills are not bb's to
    // switch off.
    expect(config.noSkills).toBe(false);
  });

  it("ignores a configured root that is not an absolute path", () => {
    sendRequest("k", "skills/configure", {
      roots: [
        { id: "relative", path: "relative/skills", skills: [] },
        { id: "real", path: "/tmp/bb-skills/real", skills: [] },
        { id: "real-again", path: "/tmp/bb-skills/real", skills: [] },
      ],
    });
    expect(currentConfiguredSkillRoots()).toHaveLength(3);

    daemon.enqueueCreate();
    daemon.enqueueAttach();
    sendRequest("s", "thread/start", {
      threadId: "thr_relative",
      cwd: "/tmp/prime-workspace",
      instructionMode: "append",
      options: FULL_OPTIONS,
    });
    return waitForResponse("s").then(() => {
      expect(createConfig(commands("create")[0]!).skills).toEqual([
        "/tmp/bb-skills/real",
      ]);
    });
  });

  it("never re-writes an existing session when the catalog arrives later", async () => {
    const providerThreadId = await startThread("s", "thr_before");

    sendRequest("k", "skills/configure", { roots: SKILL_ROOTS });
    daemon.enqueueAttach();
    sendRequest("r", "thread/resume", {
      threadId: "thr_before",
      providerThreadId,
      cwd: "/tmp/prime-workspace",
      instructionMode: "append",
      options: FULL_OPTIONS,
    });
    const reply = await waitForResponse("r");
    expect(reply.error).toBeUndefined();

    // `create` is a once-per-session write: the catalog informed nothing the
    // worker already runs, and the resume attached instead.
    expect(commands("create")).toHaveLength(1);
    expect(createConfig(commands("create")[0]!).skills).toBeUndefined();
    expect(commands("attach")).toHaveLength(2);
  });

  it("keeps extension discovery off with and without skills configured", async () => {
    await startThread("a", "thr_no_skills");
    sendRequest("k", "skills/configure", { roots: SKILL_ROOTS });
    await startThread("b", "thr_with_skills", [
      { type: "text", text: "hi", mentions: [] },
    ]);

    for (const create of commands("create")) {
      const config = createConfig(create);
      expect(config.noExtensions).toBe(true);
      expect(config.extensions).toBeUndefined();
      expect(config.extensionFlagValues).toBeUndefined();
    }
  });
});

describe("the slash-mention prompt path", () => {
  it("prompts prime with the daemon command form for a skill mention", async () => {
    const providerThreadId = await startThread("s", "thr_skill");
    daemon.enqueuePrompt({ events: textTurnEvents({ text: "ok" }) });
    sendRequest("t", "turn/start", {
      threadId: "thr_skill",
      providerThreadId,
      input: [
        {
          type: "text",
          text: "/review the diff please",
          mentions: [skillMention("review")],
        },
      ],
      clientRequestId: "creq_abcdefghij",
      options: FULL_OPTIONS,
    });
    await waitForResponse("t");

    // prime expands `/skill:<name>` worker-side; `/review` alone would pass
    // through as ordinary prompt text.
    expect(promptMessages()[0]!.message).toBe("/skill:review the diff please");
  });

  it("prompts with the skill command form for the first turn of a thread too", async () => {
    await startThread("s", "thr_first", [
      { type: "text", text: "/release-notes draft it", mentions: [skillMention("release-notes")] },
    ]);
    expect(promptMessages()[0]!.message).toBe("/skill:release-notes draft it");
  });

  it("sends a command mention (bb's builtin compact) as the literal text", async () => {
    const providerThreadId = await startThread("s", "thr_compact");
    daemon.enqueuePrompt({ events: textTurnEvents({ text: "ok" }) });
    sendRequest("t", "turn/start", {
      threadId: "thr_compact",
      providerThreadId,
      input: [
        {
          type: "text",
          text: "/compact",
          mentions: [
            {
              start: 0,
              end: 8,
              resource: {
                kind: "command",
                trigger: "/",
                name: "compact",
                source: "command",
                origin: "builtin",
                label: "compact",
                argumentHint: null,
              },
            },
          ],
        },
      ],
      clientRequestId: "creq_bcdefghijk",
      options: FULL_OPTIONS,
    });
    await waitForResponse("t");

    expect(promptMessages()[0]!.message).toBe("/compact");
  });

  it("keeps the thread title on the raw text, not the rewritten command", async () => {
    await startThread("s", "thr_title", [
      { type: "text", text: "/review the diff", mentions: [skillMention("review")] },
    ]);
    // The "[bb] " name is derived from the first prompt text the runtime sent.
    expect(commands("create")[0]!.name).toBe(
      "[bb] /review the diff (thr_title)",
    );
  });
});

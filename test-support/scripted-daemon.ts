import type { DaemonCommandResult } from "../src/daemon/client.js";
import type {
  DaemonHello,
  DaemonPushMessage,
} from "../src/daemon/protocol.js";
import type { PrimeDaemonTransport } from "../src/daemon/transport.js";
import { calibratedHello } from "./fake-daemon.js";

/**
 * A scripted stand-in for the prime-agent daemon, at the transport seam.
 *
 * The bridge hands its session lanes a `request`/`onPush` pair from
 * `src/daemon/connection.ts`; tests install this transport instead of a socket
 * one, and the whole chat path — create, attach, prompt, event streaming, abort
 * — runs in-process with no daemon and no prime install. Blocks answer by
 * command type in the order they were enqueued, so a bridge that drifts from
 * the script fails loudly instead of inventing daemon traffic.
 */

interface ScriptedBlock {
  commandType: string;
  answer: DaemonCommandResult;
  pushes: DaemonPushMessage[];
}

export interface ScriptedDaemonHandle {
  transport: PrimeDaemonTransport;
  /** Every command the bridge sent, in order. */
  readonly commands: Array<Record<string, unknown>>;
  enqueueCreate(args?: Partial<ScriptedSession>): void;
  enqueueAttach(args?: {
    messages?: readonly unknown[];
    lastEventSequence?: number;
    lastEventCursor?: { generation: string; sequence: number };
  }): void;
  /** Answer the next `prompt` with prime's early admission, then stream events. */
  enqueuePrompt(args: { events: readonly unknown[] }): void;
  /** Answer a command with `{success:true}` and no data. */
  enqueueOk(commandType: string): void;
  /** Answer a command with a daemon-side failure. */
  enqueueFail(commandType: string, error: string): void;
  /** Push a message to the bridge directly (out-of-band daemon chatter). */
  push(message: DaemonPushMessage): void;
}

/** The session identity every block speaks about (one scripted session per daemon). */
export interface ScriptedSession {
  activeSessionId: string;
  sessionFile: string;
  sessionName: string;
  cwd: string;
}

export function createScriptedDaemon(
  args: { hello?: DaemonHello; session?: Partial<ScriptedSession> } = {},
): ScriptedDaemonHandle {
  const session = {
    activeSessionId: "sess_scripted",
    sessionFile: "/tmp/prime/sessions/sess_scripted.jsonl",
    sessionName: "[bb] scripted thread",
    cwd: "/tmp/prime-workspace",
    ...args.session,
  };
  const blocks: ScriptedBlock[] = [];
  const commands: Array<Record<string, unknown>> = [];
  const listeners = new Set<(message: DaemonPushMessage) => void>();
  /** The daemon's event clock; only a session replacement changes the generation. */
  const generation = "gen-0";
  let sequence = 0;
  const hello = (args.hello ?? calibratedHello()) as DaemonHello;

  function nextBlock(commandType: string): ScriptedBlock {
    const index = blocks.findIndex((block) => block.commandType === commandType);
    if (index < 0) {
      throw new Error(
        `scripted prime daemon has no "${commandType}" block left (enqueued: ${
          blocks.map((block) => block.commandType).join(", ") || "nothing"
        })`,
      );
    }
    const [block] = blocks.splice(index, 1);
    return block!;
  }

  function push(message: DaemonPushMessage): void {
    for (const listener of listeners) {
      listener(message);
    }
  }

  function ok(commandType: string, data?: unknown): DaemonCommandResult {
    return {
      command: commandType,
      success: true,
      ...(data === undefined ? {} : { data }),
    };
  }

  const handle: ScriptedDaemonHandle = {
    transport: {
      describe: "scripted prime-agent daemon",
      async connect() {
        return hello;
      },
      async request(command) {
        const payload = command as Record<string, unknown>;
        const commandType = String(payload.type);
        commands.push(payload);
        const block = nextBlock(commandType);
        for (const message of block.pushes) {
          push(message);
        }
        return block.answer;
      },
      onPush(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      close() {
        listeners.clear();
      },
    },
    commands,
    enqueueCreate() {
      blocks.push({
        commandType: "create",
        answer: ok("create", { ...session, lifecycle: "resident", isSessionActive: false }),
        pushes: [],
      });
    },
    enqueueAttach({ messages, lastEventSequence, lastEventCursor } = {}) {
      // The reported cursor is the daemon's clock at snapshot time: events the
      // bridge never saw (out-of-band work on a resident session) move it past
      // anything this bridge has counted, and later prompts number from there.
      if (lastEventSequence !== undefined) {
        sequence = lastEventSequence;
      }
      const cursor = lastEventCursor ?? { generation, sequence };
      blocks.push({
        commandType: "attach",
        answer: ok("attach", {
          activeSessionId: session.activeSessionId,
          snapshot: {
            activeSessionId: session.activeSessionId,
            messages: messages ?? [],
            lastEventSequence: lastEventSequence ?? sequence,
            lastEventCursor: cursor,
          },
          replay: { status: "complete" },
          lastEventSequence: lastEventSequence ?? sequence,
          lastEventCursor: cursor,
        }),
        pushes: [],
      });
    },
    enqueuePrompt({ events }) {
      blocks.push({
        commandType: "prompt",
        // Prime answers `prompt` as soon as the message is admitted; the turn
        // then streams as session events.
        answer: ok("prompt", { accepted: true }),
        pushes: events.map((event) => {
          sequence += 1;
          return {
            type: "session_event",
            activeSessionId: session.activeSessionId,
            event,
            meta: { sequence, cursor: { generation, sequence } },
          } satisfies DaemonPushMessage;
        }),
      });
    },
    enqueueOk(commandType) {
      blocks.push({ commandType, answer: ok(commandType), pushes: [] });
    },
    enqueueFail(commandType, error) {
      blocks.push({
        commandType,
        answer: { command: commandType, success: false, error },
        pushes: [],
      });
    },
    push,
  };
  return handle;
}

/** A prime turn that streams one text block and settles. */
export function textTurnEvents(args: {
  text: string;
  usage?: { input: number; output: number; totalTokens: number };
}): readonly unknown[] {
  const usage = args.usage ?? { input: 7, output: 2, totalTokens: 9 };
  return [
    { type: "agent_start" },
    {
      type: "message_update",
      message: { role: "assistant", content: [{ type: "text", text: args.text }] },
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: args.text,
      },
    },
    {
      type: "message_update",
      assistantMessageEvent: {
        type: "text_end",
        contentIndex: 0,
        content: args.text,
      },
    },
    {
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: args.text }],
          stopReason: "stop",
          usage: {
            input: usage.input,
            output: usage.output,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: usage.totalTokens,
          },
        },
      ],
    },
  ];
}

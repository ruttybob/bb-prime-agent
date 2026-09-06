import {
  addTokenUsage,
  normalizeProviderCommandOutput,
  textBlockSchema,
  toNonNegativeNumber,
  ZERO_TOKEN_USAGE,
  extractResultText,
  type DeltaItemKey,
  type DeltaItemShape,
  type DeltaPresentation,
  type ThreadDelta,
  type ThreadEventTokenUsageBreakdown,
  type JsonValue,
} from "@get-bb/plugin-sdk/provider-bridge";
import type { DaemonEventCursor } from "./daemon/wire.js";
import {
  agentEndEventSchema,
  agentMessageSchema,
  authStaleEventSchema,
  autoRetryEndEventSchema,
  autoRetryStartEventSchema,
  compactionEndEventSchema,
  compactionStartEventSchema,
  IGNORED_SESSION_EVENT_TYPES,
  messageStartEventSchema,
  messageUpdateEventSchema,
  rlmChildUpdateEventSchema,
  sessionActionUpdateEventSchema,
  toolExecutionEndEventSchema,
  toolExecutionStartEventSchema,
  toolExecutionUpdateEventSchema,
  usageShapeSchema,
  type AgentMessage,
} from "./daemon/wire.js";
import { PRIME_QUEUE_EXTENSION_KIND, queueStatePayload } from "./queue-state.js";
import { PRIME_PLUGIN_ID } from "./vocabulary.js";
import {
  childActivityLabel,
  childDelegationShape,
  childResultDetail,
  isChildLive,
  parsePrimeChildren,
  type PrimeChild,
} from "./subagents/children.js";

/**
 * prime-agent daemon session events → bb `ThreadDelta`s.
 *
 * The mapping follows `provider-pi`'s translator (both providers are
 * pi-lineage, so their event vocabulary matches almost shape for shape), with
 * the differences prime adds:
 *
 * - prime streams text as `message_update` events carrying the *full* message
 *   plus an `assistantMessageEvent`; the deltas come from that sub-event, and
 *   `text_end`/`thinking_end` close their stream with the provider-final text
 *   so a multi-block message settles block by block instead of pi's
 *   close-everything-at-`agent_end`.
 * - the turn boundary is `agent_end` (prime emits model-round `turn_end`s on
 *   the way, which are ignored — they are not turn boundaries).
 * - prime's own bash (`bash_*`), recap, heartbeat and connection chatter has no
 *   bb timeline meaning and is dropped by name; anything genuinely unknown is
 *   surfaced as `unhandled` rather than swallowed.
 * - prime's queue announcement (`session_action_update`) becomes the thread's
 *   queue state under the `prime-agent/queue` extension kind, so waiting
 *   steering and follow-up messages are visible while they queue (bbpa-ggf.5).
 * - prime's session slash commands render as `extension` items under the
 *   `prime-agent/session-command` kind (bbpa-b1m.1): the durable command
 *   message prime writes when a `/goal …`-style prompt runs opens the row,
 *   its result message closes it, and the same rendering rebuilds from an
 *   attach snapshot. Custom messages of every other kind — heartbeat prompts,
 *   ipython state, compaction outcomes — render nothing, as before.
 *
 * The translator is stateless per thread apart from its bookkeeping —
 * streamed-tool shapes, still-open text streams, still-open delegation items,
 * still-open session commands, cumulative usage, and the compaction/queue
 * dedup flags — which `resetThread` clears at every provider id-space
 * boundary.
 */

const ASSISTANT_STREAM_KEY = "assistant";
const MAX_STATE_ENTRIES = 1024;

/**
 * prime's durable session-command messages (bbpa-b1m.1): when a prompt parses
 * as a session slash command, prime appends a `session_slash_command` custom
 * message and — when the command has run — a `session_slash_command_result`,
 * each announced by a `message_start`/`message_end` pair. `details.command`
 * (`{name, args, text}`) is shared by both; the result adds `success`,
 * `severity`, and `error`.
 */
const SESSION_COMMAND_CUSTOM_TYPE = "session_slash_command";
const SESSION_COMMAND_RESULT_CUSTOM_TYPE = "session_slash_command_result";

/** The timeline extension kind one session-command invocation renders under. */
const PRIME_SESSION_COMMAND_EXTENSION_KIND = `${PRIME_PLUGIN_ID}/session-command`;

/** Row-header titles cap here; argument hints can run long (`/heartbeat …`). */
const SESSION_COMMAND_TITLE_MAX_CHARS = 120;
/** A result's legible tail caps here; command output can run much longer. */
const SESSION_COMMAND_RESULT_MAX_CHARS = 2000;

function thinkingStreamKey(contentIndex: number): string {
  return `thinking-${contentIndex}`;
}

function textKey(channel: string): DeltaItemKey {
  return { channel };
}

/**prime's user-initiated bash tool and file tools, classified like provider-pi. */
const COMMAND_TOOL_NAMES = new Set(["bash"]);
const FILE_CHANGE_TOOL_NAMES = new Set(["edit", "write"]);

const EMPTY_COMMAND_OUTPUT_PLACEHOLDERS = ["(no output)"];

interface ToolCallContext {
  toolCallId: string;
  toolName: string;
  shape: DeltaItemShape;
}

function classifyToolCall(
  toolName: string,
  args: unknown,
  cwd: string | undefined,
): DeltaItemShape {
  if (COMMAND_TOOL_NAMES.has(toolName)) {
    const command = stringArg(args, "command");
    const commandCwd = stringArg(args, "cwd") ?? cwd;
    if (command === undefined || commandCwd === undefined) {
      return { type: "tool", tool: toolName, args };
    }
    return { type: "command", command, cwd: commandCwd };
  }
  if (FILE_CHANGE_TOOL_NAMES.has(toolName)) {
    const path = stringArg(args, "path");
    if (path === undefined) {
      return { type: "tool", tool: toolName, args };
    }
    const oldText = stringArg(args, "oldText");
    const newText = stringArg(args, "newText") ?? stringArg(args, "content");
    return {
      type: "fileChange",
      changes: [
        {
          path,
          kind: oldText === undefined ? "add" : "update",
          ...(oldText === undefined ? {} : { oldText }),
          ...(newText === undefined ? {} : { newText }),
        },
      ],
    };
  }
  return { type: "tool", tool: toolName, args };
}

function stringArg(args: unknown, field: string): string | undefined {
  if (typeof args !== "object" || args === null) {
    return undefined;
  }
  const value = (args as Record<string, unknown>)[field];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function commandOutput(result: unknown): string | undefined {
  return normalizeProviderCommandOutput({
    text: extractResultText(result),
    emptyPlaceholders: EMPTY_COMMAND_OUTPUT_PLACEHOLDERS,
  });
}

function messageText(message: AgentMessage): string | undefined {
  const content = message.content;
  if (content === undefined) {
    return undefined;
  }
  const text =
    typeof content === "string"
      ? content
      : content
          .flatMap((block) => {
            const parsed = textBlockSchema.safeParse(block);
            return parsed.success ? [parsed.data.text] : [];
          })
          .join("\n");
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isAssistantMessage(message: AgentMessage): boolean {
  return message.role === "assistant";
}

function assistantError(message: AgentMessage | undefined): string | undefined {
  return message?.stopReason === "error" &&
    typeof message.errorMessage === "string" &&
    message.errorMessage.trim().length > 0
    ? message.errorMessage
    : undefined;
}

function toUsageBreakdown(message: AgentMessage | undefined) {
  const usage = message?.usage;
  if (usage === undefined) {
    return undefined;
  }
  const inputTokens = toNonNegativeNumber(usage.input);
  const outputTokens = toNonNegativeNumber(usage.output);
  const cachedInputTokens =
    toNonNegativeNumber(usage.cacheRead) + toNonNegativeNumber(usage.cacheWrite);
  const totalTokens = toNonNegativeNumber(usage.totalTokens);
  return {
    totalTokens:
      totalTokens > 0
        ? totalTokens
        : inputTokens + outputTokens + cachedInputTokens,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens: 0,
  } satisfies ThreadEventTokenUsageBreakdown;
}

function stopReasonToStatus(
  message: AgentMessage | undefined,
): "completed" | "failed" | "interrupted" {
  if (message?.stopReason === "aborted") {
    return "interrupted";
  }
  if (assistantError(message) !== undefined) {
    return "failed";
  }
  return "completed";
}

/* --------------------- session slash commands (bbpa-b1m.1) --------------------- */

/** prime's `details.command` (`{name, args, text}`), read defensively. */
interface SessionCommandRef {
  name: string;
  args: string;
  text: string;
}

/** The payload one session-command item carries through open and close. */
type SessionCommandPayload = {
  command: string;
  args: string;
  text: string;
  phase: "requested" | "succeeded" | "failed" | "interrupted";
  error?: string;
};

/** A session-command item this bridge opened and a result has not closed yet. */
interface OpenSessionCommand {
  key: DeltaItemKey;
  ref: SessionCommandRef;
}

function capText(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

/**
 * The command a custom session-command message refers to, or `undefined` when
 * anything is malformed — a prime that reshapes `details` must cost a row,
 * never a translator throw.
 */
function sessionCommandRef(message: AgentMessage): SessionCommandRef | undefined {
  const details = (message as Record<string, unknown>).details;
  const command =
    typeof details === "object" && details !== null
      ? (details as Record<string, unknown>).command
      : undefined;
  if (typeof command !== "object" || command === null) {
    return undefined;
  }
  const name = (command as Record<string, unknown>).name;
  if (typeof name !== "string" || name.trim() === "") {
    return undefined;
  }
  const args = (command as Record<string, unknown>).args;
  const text = (command as Record<string, unknown>).text;
  return {
    name,
    args: typeof args === "string" ? args : "",
    text: typeof text === "string" ? text : "",
  };
}

/** Whether prime marked the command's result failed. */
function sessionCommandFailed(message: AgentMessage): boolean {
  const details = (message as Record<string, unknown>).details;
  if (typeof details !== "object" || details === null) {
    return false;
  }
  const record = details as Record<string, unknown>;
  return record.success === false || record.severity === "error";
}

/**
 * A failed result's error message, or `undefined` when prime shipped none —
 * the failure itself is already carried by the status and the payload phase.
 */
function sessionCommandError(message: AgentMessage): string | undefined {
  if (!sessionCommandFailed(message)) {
    return undefined;
  }
  const details = (message as Record<string, unknown>).details;
  const error =
    typeof details === "object" && details !== null
      ? (details as Record<string, unknown>).error
      : undefined;
  return typeof error === "string" && error.trim() !== "" ? error : undefined;
}

function sessionCommandItem(payload: SessionCommandPayload): DeltaItemShape {
  return {
    type: "extension",
    kind: PRIME_SESSION_COMMAND_EXTENSION_KIND,
    payload,
  };
}

function sessionCommandPresentation(ref: SessionCommandRef): DeltaPresentation {
  return {
    label: { pending: `/${ref.name}`, completed: `/${ref.name}` },
    icon: { glyph: "terminal" },
    title: capText(
      `/${ref.name}${ref.args === "" ? "" : ` ${ref.args}`}`.trim(),
      SESSION_COMMAND_TITLE_MAX_CHARS,
    ),
  };
}

function sessionCommandOpenDelta(
  key: DeltaItemKey,
  payload: SessionCommandPayload,
): ThreadDelta {
  return {
    kind: "item.open",
    key,
    item: sessionCommandItem(payload),
    attach: "currentOrLast",
    presentation: sessionCommandPresentation({
      name: payload.command,
      args: payload.args,
      text: payload.text,
    }),
  };
}

/**
 * The deltas a result message produces, closing `open` in place: the most
 * recent entry with the result's command name — nested invocations of one
 * command settle inside-out. A result with no open row (prime answered
 * before this bridge attached, or the open was dropped as malformed) becomes
 * an open+close settled pair, so the result still shows.
 */
function sessionCommandResultDeltas(
  message: AgentMessage,
  open: OpenSessionCommand[],
  nextKey: () => DeltaItemKey,
): ThreadDelta[] {
  const ref = sessionCommandRef(message);
  if (ref === undefined) {
    return [];
  }
  const failed = sessionCommandFailed(message);
  const error = sessionCommandError(message);
  const payload: SessionCommandPayload = {
    command: ref.name,
    args: ref.args,
    text: ref.text,
    phase: failed ? "failed" : "succeeded",
    ...(error === undefined ? {} : { error }),
  };
  const content = messageText(message);
  const resultText =
    content === undefined
      ? undefined
      : capText(content, SESSION_COMMAND_RESULT_MAX_CHARS);
  let index = -1;
  for (let cursor = open.length - 1; cursor >= 0; cursor -= 1) {
    if (open[cursor]?.ref.name === ref.name) {
      index = cursor;
      break;
    }
  }
  if (index === -1) {
    return sessionCommandSettledPair(nextKey(), payload, {
      status: failed ? "failed" : "completed",
      resultText,
    });
  }
  const entry = open[index] as OpenSessionCommand;
  open.splice(index, 1);
  return [
    {
      kind: "item.close",
      key: entry.key,
      item: sessionCommandItem(payload),
      status: failed ? "failed" : "completed",
      ...(resultText === undefined ? {} : { resultText }),
    },
  ];
}

/**
 * An open+close pair for a result that arrived with no open row (prime
 * answered before this bridge attached, or the open was dropped as
 * malformed): the outcome is known, but bb has no row for it yet, so both
 * halves land in one breath.
 */
function sessionCommandSettledPair(
  key: DeltaItemKey,
  payload: SessionCommandPayload,
  result: {
    status: "completed" | "failed" | "interrupted";
    resultText: string | undefined;
  },
): ThreadDelta[] {
  const item = sessionCommandItem(payload);
  return [
    sessionCommandOpenDelta(key, payload),
    {
      kind: "item.close",
      key,
      item,
      status: result.status,
      ...(result.resultText === undefined
        ? {}
        : { resultText: result.resultText }),
    },
  ];
}

/** Where a streamed turn sits, so an abort can settle it exactly once. */
export interface TurnObservation {
  /** `agent_end` arrived: the boundary status prime reported. */
  settled: "completed" | "failed" | "interrupted";
  errorMessage: string | undefined;
}

export interface TranslationContext {
  threadId: string;
  cwd: string | undefined;
  /**
   * The context window (tokens) of the model the session currently runs, as
   * the lane adopted it — prime's attach-snapshot `state.model.contextWindow`,
   * kept current across bb-driven model switches (`PrimeSessionState
   * .primeModel`). `undefined` when the model, or its window, is unknown: the
   * usage row then reports `null` and no `contextWindow` row is rendered at
   * all, rather than one inventing a size (bbpa-b1m.9).
   */
  modelContextWindow?: number | undefined;
  /**
   * The bridge settled the turn itself (soft stop): prime's `agent_end` still
   * carries item closes, but its boundary must not close the turn twice.
   */
  suppressTurnBoundary?: boolean;
  /**
   * The fork anchor minted for the run this `agent_end` settles (bbpa-ggf.7).
   * It rides the turn boundary onto bb's turn/completed event, which a later
   * fork from an earlier message resolves against. Only the agent_end boundary
   * carries one — a prompt-carrying run is what a fork anchors at.
   */
  providerCheckpointId?: string;
  /** Called when an `agent_end` settles the turn prime is running. */
  onTurnSettled?: (observation: TurnObservation) => void;
}

interface ThreadState {
  toolCalls: Map<string, ToolCallContext>;
  openTextStreams: Set<string>;
  /** Child ids whose delegation item is open on the timeline. */
  openDelegations: Set<string>;
  /**
   * Session-command bookkeeping (bbpa-b1m.1): the monotonic source of item
   * keys, and the items a result has not closed yet — oldest first, since a
   * result closes the most recent entry with its command's name.
   */
  sessionCommandOrdinal: number;
  openSessionCommands: OpenSessionCommand[];
  usage: ThreadEventTokenUsageBreakdown;
  /** Set between `compaction_start` and `compaction_end`; prime's reason decides the settlement. */
  compaction: { manual: boolean } | undefined;
  /** Serialized queue payload last emitted, so an unchanged queue re-emits nothing. */
  queuePayload: string | undefined;
}

export interface PrimeDeltaTranslator {
  translate(event: unknown, context: TranslationContext): ThreadDelta[];
  /** Deltas that rebuild a session's timeline from an attach snapshot. */
  snapshotDeltas(messages: readonly unknown[]): ThreadDelta[];
  /**
   * The queue-state delta for a lane snapshot read outside the event stream
   * (`get_queue` at attach); deduped against the event-driven updates.
   */
  queueStateDeltas(
    threadId: string,
    queue: { steering: readonly string[]; followUps: readonly string[] },
  ): ThreadDelta[];
  /**
   * Deltas that put a session's snapshot children on the timeline: one
   * delegation item per child, open-and-settled for finished ones, open-and-
   * live for the ones still going. An adopted session's only record of
   * subagents spawned outside bb is this roster, so unreadable entries are
   * skipped rather than invented. `threadId` is the thread the snapshot
   * belongs to — live child updates for it then find their item already open.
   */
  childrenDeltas(children: readonly unknown[], threadId: string): ThreadDelta[];
  /**
   * Deltas that settle the running turn after a soft stop (`abort`): open text
   * streams closed, the turn boundary `interrupted`. Prime's own `agent_end`
   * for the aborted turn is then translated with the boundary suppressed.
   */
  interruptDeltas(threadId: string): ThreadDelta[];
  /**
   * Deltas that settle a turn this bridge had to fail itself (bbpa-ggf.11: the
   * daemon wire dropped mid-turn; a compaction prime refused): open streams
   * closed, one legible provider error, one failed turn boundary. Prime cannot
   * settle these — its `agent_end` died with the socket or never came.
   */
  failureDeltas(
    threadId: string,
    args: { message: string; detail?: string },
  ): ThreadDelta[];
  resetThread(threadId: string): void;
}

export function createPrimeDeltaTranslator(): PrimeDeltaTranslator {
  const states = new Map<string, ThreadState>();

  function stateFor(threadId: string): ThreadState {
    const existing = states.get(threadId);
    if (existing !== undefined) {
      return existing;
    }
    const created: ThreadState = {
      toolCalls: new Map(),
      openTextStreams: new Set(),
      openDelegations: new Set(),
      sessionCommandOrdinal: 0,
      openSessionCommands: [],
      usage: ZERO_TOKEN_USAGE,
      compaction: undefined,
      queuePayload: undefined,
    };
    states.set(threadId, created);
    while (states.size > MAX_STATE_ENTRIES) {
      const oldest = states.keys().next();
      if (oldest.done === true) {
        break;
      }
      states.delete(oldest.value);
    }
    return created;
  }

  function unhandled(event: unknown, context: TranslationContext): ThreadDelta[] {
    return [
      {
        kind: "unhandled",
        raw: {
          jsonrpc: "2.0" as const,
          method: "prime/session_event",
          // The raw mirror is a debug aid: prime's events are JSON on the wire.
          params: { threadId: context.threadId, event: event as JsonValue },
        },
        rawType: "prime/session_event",
        vouchedTurn: true,
      },
    ];
  }

  function textDelta(
    channel: string,
    deltaChannel: "agentMessage" | "reasoningText",
    text: string,
    context: TranslationContext,
  ): ThreadDelta[] {
    stateFor(context.threadId).openTextStreams.add(channel);
    return [
      {
        kind: "item.textDelta",
        key: textKey(channel),
        channel: deltaChannel,
        text,
      },
    ];
  }

  function textClose(
    channel: string,
    deltaChannel: "agentMessage" | "reasoningText",
    text: string | undefined,
    context: TranslationContext,
  ): ThreadDelta[] {
    const state = stateFor(context.threadId);
    const open = state.openTextStreams.delete(channel);
    if (!open && text === undefined) {
      return [];
    }
    return [
      {
        kind: "item.textClose",
        key: textKey(channel),
        channel: deltaChannel,
        ...(text === undefined ? {} : { text }),
      },
    ];
  }

  function usageDeltas(
    message: AgentMessage | undefined,
    context: TranslationContext,
  ): ThreadDelta[] {
    const last = toUsageBreakdown(message);
    if (last === undefined) {
      return [];
    }
    const state = stateFor(context.threadId);
    const total = addTokenUsage(state.usage, last);
    state.usage = total;
    const contextWindow =
      typeof context.modelContextWindow === "number"
        ? context.modelContextWindow
        : null;
    const deltas: ThreadDelta[] = [
      { kind: "usage", total, last, modelContextWindow: contextWindow },
    ];
    // The dedicated context row (bbpa-b1m.9) only rides a known window — with
    // no model window there is nothing to meter, so no row is invented.
    if (contextWindow === null) {
      return deltas;
    }
    return [
      ...deltas,
      {
        kind: "contextWindow",
        // The used figure is the turn's own usage, not the session's
        // cumulative sum: prime's context meter builds on the last assistant
        // message's tokens (`calculateContextTokens` over
        // `getLastAssistantUsage` — input + output + cache, which is exactly
        // `last` here), and only that describes how full the window is.
        used: last.totalTokens,
        size: contextWindow,
        // Prime itself calls this an estimate (`estimateContextTokens`): the
        // last assistant's usage plus a trailing character estimate, and
        // `tokens: null` after a compaction boundary until the next response
        // — `getContextUsage` in prime's agent-session.
        estimated: true,
        attach: "currentOrLast",
      },
    ];
  }

  function closeOpenStreams(context: TranslationContext): ThreadDelta[] {
    const state = stateFor(context.threadId);
    const deltas: ThreadDelta[] = [];
    for (const channel of [...state.openTextStreams]) {
      deltas.push(
        ...textClose(
          channel,
          channel === ASSISTANT_STREAM_KEY ? "agentMessage" : "reasoningText",
          undefined,
          context,
        ),
      );
    }
    return deltas;
  }

  /** The queue-state delta for a lane snapshot, or nothing when it repeats. */
  function queueUpdateDeltas(
    threadId: string,
    queue: { steering: readonly string[]; followUps: readonly string[] },
  ): ThreadDelta[] {
    const payload = queueStatePayload(queue);
    const state = stateFor(threadId);
    const serialized = JSON.stringify(payload);
    if (serialized === state.queuePayload) {
      return [];
    }
    state.queuePayload = serialized;
    return [
      {
        kind: "extension.state",
        extensionKind: PRIME_QUEUE_EXTENSION_KIND,
        payload,
      },
    ];
  }

  /**
   * One child's timeline deltas. Live children open once (tracked per thread,
   * so prime's repeated updates become progress, not duplicate opens) and a
   * terminal status settles the item exactly once. A child that settles
   * without this bridge having seen it running — a snapshot's finished
   * subagent, or an update racing the attach — is opened on the way past: bb
   * has no row for it otherwise.
   *
   * The open carries `attach: "currentOrLast"` because a background child
   * outlives the turn that spawned it: when prime's updates arrive after the
   * boundary, the item still lands on the turn that has the child's history
   * instead of being dropped for having no open turn.
   */
  function childDeltas(child: PrimeChild, threadId: string): ThreadDelta[] {
    const key: DeltaItemKey = { providerItemId: child.id, channel: "delegation" };
    const shape = childDelegationShape(child);
    const state = stateFor(threadId);
    const deltas: ThreadDelta[] = [];
    if (!state.openDelegations.has(child.id)) {
      state.openDelegations.add(child.id);
      deltas.push({
        kind: "item.open",
        key,
        item: shape,
        attach: "currentOrLast",
      });
    }
    if (isChildLive(child)) {
      const progress =
        child.recap?.trim() || childActivityLabel(child) || "subagent is running";
      deltas.push({
        kind: "item.progress",
        key,
        message: progress,
        snapshot: shape,
      });
      return deltas;
    }
    state.openDelegations.delete(child.id);
    const resultText = childResultDetail(child);
    deltas.push({
      kind: "item.close",
      key,
      item: shape,
      status:
        child.status === "done"
          ? "completed"
          : child.status === "cancelled"
            ? "interrupted"
            : "failed",
      ...(resultText === undefined ? {} : { resultText }),
    });
    return deltas;
  }

  /**
   * The timeline deltas one durable custom message produces (bbpa-b1m.1): a
   * session-command message opens its row, a result closes the most recent open
   * row for that command. Every other custom type — heartbeat prompts, ipython
   * state, compaction outcomes — and every non-custom message these pushes
   * bracket render nothing, exactly as the ignore set did before this surface
   * existed. Malformed session-command details are dropped silently: a prime
   * that reshapes them may cost a row, never a translator throw.
   */
  function sessionCommandDeltas(
    message: AgentMessage | undefined,
    context: TranslationContext,
  ): ThreadDelta[] {
    if (message === undefined || message.role !== "custom") {
      return [];
    }
    const customType = (message as Record<string, unknown>).customType;
    if (customType === SESSION_COMMAND_CUSTOM_TYPE) {
      return openSessionCommand(message, context);
    }
    if (customType === SESSION_COMMAND_RESULT_CUSTOM_TYPE) {
      return closeSessionCommand(message, context);
    }
    return [];
  }

  function openSessionCommand(
    message: AgentMessage,
    context: TranslationContext,
  ): ThreadDelta[] {
    const ref = sessionCommandRef(message);
    if (ref === undefined) {
      return [];
    }
    const state = stateFor(context.threadId);
    state.sessionCommandOrdinal += 1;
    const key: DeltaItemKey = {
      channel: `session-command-${state.sessionCommandOrdinal}`,
    };
    state.openSessionCommands.push({ key, ref });
    return [
      sessionCommandOpenDelta(key, {
        command: ref.name,
        args: ref.args,
        text: ref.text,
        phase: "requested",
      }),
    ];
  }

  function closeSessionCommand(
    message: AgentMessage,
    context: TranslationContext,
  ): ThreadDelta[] {
    const state = stateFor(context.threadId);
    return sessionCommandResultDeltas(message, state.openSessionCommands, () => {
      state.sessionCommandOrdinal += 1;
      return { channel: `session-command-${state.sessionCommandOrdinal}` };
    });
  }

  function translate(
    event: unknown,
    context: TranslationContext,
  ): ThreadDelta[] {
    if (typeof event !== "object" || event === null) {
      return [];
    }
    const type = (event as Record<string, unknown>).type;
    if (typeof type !== "string") {
      return [];
    }
    if (IGNORED_SESSION_EVENT_TYPES.has(type)) {
      return [];
    }

    switch (type) {
      case "agent_start":
        return [{ kind: "turn.open" }];

      case "message_update": {
        const parsed = messageUpdateEventSchema.safeParse(event);
        if (!parsed.success) {
          return unhandled(event, context);
        }
        const streamEvent = parsed.data.assistantMessageEvent;
        if (streamEvent.type === "text_delta" && streamEvent.delta !== undefined) {
          return textDelta(ASSISTANT_STREAM_KEY, "agentMessage", streamEvent.delta, context);
        }
        if (streamEvent.type === "text_end" && streamEvent.content !== undefined) {
          return textClose(ASSISTANT_STREAM_KEY, "agentMessage", streamEvent.content, context);
        }
        if (
          streamEvent.type === "thinking_delta" &&
          streamEvent.delta !== undefined &&
          streamEvent.contentIndex !== undefined
        ) {
          return textDelta(
            thinkingStreamKey(streamEvent.contentIndex),
            "reasoningText",
            streamEvent.delta,
            context,
          );
        }
        if (
          streamEvent.type === "thinking_end" &&
          streamEvent.content !== undefined &&
          streamEvent.contentIndex !== undefined
        ) {
          return textClose(
            thinkingStreamKey(streamEvent.contentIndex),
            "reasoningText",
            streamEvent.content,
            context,
          );
        }
        return [];
      }

      case "message_start": {
        // Durable custom messages (bbpa-b1m.1): a session slash command and,
        // later, its result each arrive here, so this is the one event a row
        // renders on. Non-command messages — every user/assistant/toolResult
        // turn, prime's other custom types — render nothing, exactly as the
        // ignore set did before this case existed; the parse-fail branch
        // stays silent for the same reason (a prime that reshapes these
        // events must not turn every message into an unhandled row).
        const parsed = messageStartEventSchema.safeParse(event);
        if (!parsed.success) {
          return [];
        }
        return sessionCommandDeltas(parsed.data.message, context);
      }

      case "message_end": {
        // prime announces every durable message as a start/end pair carrying
        // the same message; whatever the start rendered (or deliberately did
        // not), the end never adds a row of its own.
        return [];
      }

      case "tool_execution_start": {
        const parsed = toolExecutionStartEventSchema.safeParse(event);
        if (!parsed.success) {
          return unhandled(event, context);
        }
        const shape = classifyToolCall(
          parsed.data.toolName,
          parsed.data.args,
          context.cwd,
        );
        stateFor(context.threadId).toolCalls.set(parsed.data.toolCallId, {
          toolCallId: parsed.data.toolCallId,
          toolName: parsed.data.toolName,
          shape,
        });
        return [
          {
            kind: "item.open",
            key: { providerItemId: parsed.data.toolCallId },
            item: shape,
          },
        ];
      }

      case "tool_execution_update": {
        const parsed = toolExecutionUpdateEventSchema.safeParse(event);
        if (!parsed.success) {
          return unhandled(event, context);
        }
        if (COMMAND_TOOL_NAMES.has(parsed.data.toolName)) {
          const snapshot = commandOutput(parsed.data.partialResult);
          if (snapshot === undefined) {
            return [];
          }
          return [
            {
              kind: "command.outputSnapshot",
              key: { providerItemId: parsed.data.toolCallId },
              text: snapshot,
            },
          ];
        }
        const progress = extractResultText(parsed.data.partialResult).trim();
        return [
          {
            kind: "item.progress",
            key: { providerItemId: parsed.data.toolCallId },
            ...(progress.length > 0
              ? { message: progress }
              : { message: `${parsed.data.toolName} is running` }),
          },
        ];
      }

      case "tool_execution_end": {
        const parsed = toolExecutionEndEventSchema.safeParse(event);
        if (!parsed.success) {
          return unhandled(event, context);
        }
        const started = stateFor(context.threadId).toolCalls.get(
          parsed.data.toolCallId,
        );
        const shape =
          started?.shape ??
          (FILE_CHANGE_TOOL_NAMES.has(parsed.data.toolName)
            ? { type: "fileChange", changes: [] }
            : { type: "tool", tool: parsed.data.toolName });
        const aggregatedOutput = COMMAND_TOOL_NAMES.has(parsed.data.toolName)
          ? commandOutput(parsed.data.result)
          : undefined;
        return [
          {
            kind: "item.close",
            key: { providerItemId: parsed.data.toolCallId },
            item: shape,
            status: parsed.data.isError ? "failed" : "completed",
            resultText: extractResultText(parsed.data.result),
            exitCode: parsed.data.isError ? 1 : 0,
            ...(aggregatedOutput === undefined ? {} : { aggregatedOutput }),
          },
        ];
      }

      case "agent_end": {
        const parsed = agentEndEventSchema.safeParse(event);
        if (!parsed.success) {
          return unhandled(event, context);
        }
        const lastAssistant = [
          ...parsed.data.messages,
        ]
          .reverse()
          .find(isAssistantMessage);
        const error = assistantError(lastAssistant);
        const status = stopReasonToStatus(lastAssistant);
        const deltas: ThreadDelta[] = [...closeOpenStreams(context)];
        if (error !== undefined) {
          deltas.push({
            kind: "provider.error",
            message: "prime-agent failed to answer",
            detail: error,
            settlesTurn: true,
          });
        } else if (parsed.data.willRetry === true) {
          deltas.push({
            kind: "provider.error",
            message: "prime-agent is retrying the request",
            willRetry: true,
          });
        }
        deltas.push(...usageDeltas(lastAssistant, context));
        if (context.suppressTurnBoundary !== true) {
          deltas.push({
            kind: "turn.boundary",
            status,
            ...(context.providerCheckpointId === undefined
              ? {}
              : { providerCheckpointId: context.providerCheckpointId }),
            ...(error === undefined ? {} : { error: { message: error } }),
            claimIfIdle: true,
          });
          context.onTurnSettled?.({ settled: status, errorMessage: error });
        }
        return deltas;
      }

      case "compaction_start": {
        const parsed = compactionStartEventSchema.safeParse(event);
        if (!parsed.success) {
          return unhandled(event, context);
        }
        const manual = parsed.data.reason === "manual";
        stateFor(context.threadId).compaction = { manual };
        const open: ThreadDelta = {
          kind: "item.open",
          key: { channel: "compaction" },
          item: { type: "compaction" },
          attach: manual ? "open" : "currentOrLast",
        };
        return manual ? [{ kind: "turn.open" }, open] : [open];
      }

      case "compaction_end": {
        const parsed = compactionEndEventSchema.safeParse(event);
        if (!parsed.success) {
          return unhandled(event, context);
        }
        const manual = stateFor(context.threadId).compaction?.manual ?? true;
        stateFor(context.threadId).compaction = undefined;
        const aborted = parsed.data.aborted === true;
        const errorMessage = parsed.data.errorMessage;
        // prime skips benignly ("nothing to compact yet"): a warning-severity
        // end is not a compaction, so it must not claim one.
        const skipped =
          !aborted && errorMessage !== undefined && parsed.data.errorSeverity === "warning";
        const failed =
          !aborted &&
          errorMessage !== undefined &&
          parsed.data.errorSeverity !== "warning";
        if (skipped) {
          const warning: ThreadDelta = {
            kind: "provider.warning",
            category: "compaction-skipped",
            summary: "Context compaction skipped",
            details: errorMessage,
            vouchedTurn: true,
          };
          // The compaction item opened for this closes with the turn (nothing
          // was compacted, so there is no compaction row to settle); a manual
          // compaction still owes bb its turn boundary.
          return manual ? [warning, { kind: "turn.boundary", status: "completed" }] : [warning];
        }
        const close: ThreadDelta = {
          kind: "item.close",
          key: { channel: "compaction" },
          item: { type: "compaction" },
          status: aborted ? "interrupted" : failed ? "failed" : "completed",
          ...(errorMessage === undefined ? {} : { resultText: errorMessage }),
        };
        if (!manual) {
          const automatic: ThreadDelta[] = [close];
          if (failed) {
            automatic.push({
              kind: "provider.error",
              message: "prime-agent failed to compact the context",
              detail: errorMessage,
            });
          } else if (!aborted) {
            automatic.push({ kind: "context.compacted" });
          }
          return automatic;
        }
        const manualDeltas: ThreadDelta[] = [close];
        if (!failed && !aborted) {
          manualDeltas.push({ kind: "context.compacted" });
        }
        manualDeltas.push({
          kind: "turn.boundary",
          status: aborted ? "interrupted" : failed ? "failed" : "completed",
          ...(errorMessage === undefined ? {} : { error: { message: errorMessage } }),
          claimIfIdle: true,
        });
        return manualDeltas;
      }

      case "auto_retry_start": {
        const parsed = autoRetryStartEventSchema.safeParse(event);
        if (!parsed.success) {
          return unhandled(event, context);
        }
        return [
          {
            kind: "provider.error",
            message: "prime-agent is retrying the request",
            detail: parsed.data.errorMessage,
            willRetry: true,
          },
        ];
      }

      case "auto_retry_end": {
        const parsed = autoRetryEndEventSchema.safeParse(event);
        if (!parsed.success) {
          return unhandled(event, context);
        }
        if (parsed.data.success === true) {
          return [];
        }
        return [
          {
            kind: "provider.error",
            message: "prime-agent gave up retrying the request",
            detail: parsed.data.finalError,
            settlesTurn: true,
          },
        ];
      }

      case "auth_stale": {
        const parsed = authStaleEventSchema.safeParse(event);
        if (!parsed.success) {
          return unhandled(event, context);
        }
        return [
          {
            kind: "provider.error",
            message: "prime-agent authentication is stale",
            detail: `Run prime-agent and /login again${
              parsed.data.provider === undefined
                ? ""
                : ` (provider ${parsed.data.provider})`
            }.`,
            threadScoped: true,
          },
        ];
      }

      case "session_action_update": {
        // Prime announces its waiting-message lanes here (bbpa-ggf.5): the
        // queue becomes visible in the thread as queue state while it waits,
        // and clears (`null` payload) once both lanes are empty.
        const parsed = sessionActionUpdateEventSchema.safeParse(event);
        if (!parsed.success) {
          return unhandled(event, context);
        }
        return queueUpdateDeltas(context.threadId, {
          steering: parsed.data.actions.steering.filter(
            (preview): preview is string => typeof preview === "string",
          ),
          followUps: parsed.data.actions.followUps.filter(
            (preview): preview is string => typeof preview === "string",
          ),
        });
      }

      case "rlm_child_update": {
        const parsed = rlmChildUpdateEventSchema.safeParse(event);
        if (!parsed.success) {
          return unhandled(event, context);
        }
        return childDeltas(parsed.data.child, context.threadId);
      }

      default:
        return unhandled(event, context);
    }
  }

  /**
   * Timeline reconstruction from an attach snapshot: user messages become
   * `input.provider` rows, assistant blocks become the items they would have
   * streamed as, and prime's tool results fill their tool call's close.
   */
  function snapshotDeltas(messages: readonly unknown[]): ThreadDelta[] {
    const parsed = messages.flatMap((message) => {
      const result = agentMessageSchema.safeParse(message);
      return result.success ? [result.data] : [];
    });
    const toolResults = new Map<string, AgentMessage>();
    for (const message of parsed) {
      if (message.role !== "toolResult") {
        continue;
      }
      const toolCallId =
        typeof (message as Record<string, unknown>).toolCallId === "string"
          ? String((message as Record<string, unknown>).toolCallId)
          : undefined;
      if (toolCallId !== undefined) {
        toolResults.set(toolCallId, message);
      }
    }
    const deltas: ThreadDelta[] = [];
    // Session-command items (bbpa-b1m.1) render with the same shapes as the
    // live path, but keys and the open stack are local to this pass: it runs
    // once per attach against a message list the live stream never replays,
    // and repeating `session-command-N` channels across passes is the
    // grammar's normal key reuse (the compaction channel has always worked
    // that way).
    const openCommands: OpenSessionCommand[] = [];
    let commandOrdinal = 0;
    const nextCommandKey = (): DeltaItemKey => {
      commandOrdinal += 1;
      return { channel: `session-command-${commandOrdinal}` };
    };
    for (const message of parsed) {
      if (message.role === "user") {
        const text = messageText(message);
        if (text !== undefined) {
          deltas.push({ kind: "input.provider", text });
        }
        continue;
      }
      if (message.role === "custom") {
        // Custom messages were skipped outright before bbpa-b1m.1; the two
        // session-command types now render in message order — command opens
        // pending, its result closes. Every other custom type keeps today's
        // behavior: skipped.
        const customType = (message as Record<string, unknown>).customType;
        const ref = sessionCommandRef(message);
        if (customType === SESSION_COMMAND_CUSTOM_TYPE && ref !== undefined) {
          const key = nextCommandKey();
          openCommands.push({ key, ref });
          deltas.push(
            sessionCommandOpenDelta(key, {
              command: ref.name,
              args: ref.args,
              text: ref.text,
              phase: "requested",
            }),
          );
          continue;
        }
        if (customType === SESSION_COMMAND_RESULT_CUSTOM_TYPE) {
          deltas.push(
            ...sessionCommandResultDeltas(message, openCommands, nextCommandKey),
          );
        }
        continue;
      }
      if (message.role !== "assistant") {
        continue;
      }
      const content = message.content;
      if (typeof content === "string") {
        const text = messageText(message);
        if (text !== undefined) {
          deltas.push({
            kind: "item.open",
            key: { channel: ASSISTANT_STREAM_KEY },
            item: { type: "agentMessage", text },
            attach: "currentOrLast",
          });
        }
        continue;
      }
      for (const block of content ?? []) {
        if (block.type === "text") {
          const parsedBlock = textBlockSchema.safeParse(block);
          const text = parsedBlock.success ? parsedBlock.data.text.trim() : "";
          if (text.length > 0) {
            deltas.push({
              kind: "item.open",
              key: { channel: ASSISTANT_STREAM_KEY },
              item: { type: "agentMessage", text },
              attach: "currentOrLast",
            });
          }
          continue;
        }
        if (block.type === "thinking") {
          // pi-lineage thinking blocks carry the text in `thinking`.
          const text = stringArg(block, "thinking");
          if (text !== undefined) {
            deltas.push({
              kind: "item.open",
              key: { channel: "reasoning" },
              item: { type: "reasoning", content: [text], summary: [] },
              attach: "currentOrLast",
            });
          }
          continue;
        }
        if (block.type === "toolCall") {
          const toolCallId = stringArg(block, "id");
          const toolName = stringArg(block, "name");
          if (toolName === undefined) {
            continue;
          }
          const args = (block as Record<string, unknown>).arguments;
          const result = toolCallId === undefined ? undefined : toolResults.get(toolCallId);
          deltas.push({
            kind: "item.open",
            key:
              toolCallId === undefined
                ? { channel: `tool-${toolName}` }
                : { providerItemId: toolCallId },
            item: classifyToolCall(toolName, args, undefined),
            attach: "currentOrLast",
          });
          if (result !== undefined) {
            deltas.push({
              kind: "item.close",
              key:
                toolCallId === undefined
                  ? { channel: `tool-${toolName}` }
                  : { providerItemId: toolCallId },
              item: classifyToolCall(toolName, args, undefined),
              status: result.stopReason === undefined && isErrorResult(result) ? "failed" : "completed",
              resultText: extractResultText(
                (result as Record<string, unknown>).content,
              ),
            });
          }
        }
      }
    }
    // A command still open when the transcript ends — prime writes its result
    // immediately after the command, so a missing result means a truncated
    // session — must not survive replay as a pending row: close it
    // interrupted, outcome unknown. The close lands beside the open this pass
    // already emitted, so no second open is minted here.
    for (const open of openCommands) {
      deltas.push({
        kind: "item.close",
        key: open.key,
        item: sessionCommandItem({
          command: open.ref.name,
          args: open.ref.args,
          text: open.ref.text,
          phase: "interrupted",
        }),
        status: "interrupted",
      });
    }
    return deltas;
  }

  return {
    translate,
    snapshotDeltas,
    queueStateDeltas(threadId, queue) {
      return queueUpdateDeltas(threadId, queue);
    },
    childrenDeltas(children, threadId) {
      return parsePrimeChildren(children).flatMap((child) =>
        childDeltas(child, threadId),
      );
    },
    interruptDeltas(threadId) {
      const deltas = closeOpenStreams({ threadId, cwd: undefined });
      deltas.push({ kind: "turn.boundary", status: "interrupted" });
      return deltas;
    },
    failureDeltas(threadId, args) {
      const deltas = closeOpenStreams({ threadId, cwd: undefined });
      deltas.push({
        kind: "provider.error",
        message: args.message,
        ...(args.detail === undefined ? {} : { detail: args.detail }),
        settlesTurn: true,
      });
      deltas.push({
        kind: "turn.boundary",
        status: "failed",
        error: { message: args.detail ?? args.message },
        claimIfIdle: true,
      });
      return deltas;
    },
    resetThread(threadId) {
      states.delete(threadId);
    },
  };
}

function isErrorResult(result: AgentMessage): boolean {
  return (result as Record<string, unknown>).isError === true;
}

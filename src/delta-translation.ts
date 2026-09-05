import {
  addTokenUsage,
  normalizeProviderCommandOutput,
  textBlockSchema,
  toNonNegativeNumber,
  ZERO_TOKEN_USAGE,
  extractResultText,
  type DeltaItemKey,
  type DeltaItemShape,
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
  messageUpdateEventSchema,
  rlmChildUpdateEventSchema,
  toolExecutionEndEventSchema,
  toolExecutionStartEventSchema,
  toolExecutionUpdateEventSchema,
  usageShapeSchema,
  type AgentMessage,
} from "./daemon/wire.js";
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
 *
 * The translator is stateless per thread apart from four bookkeeping maps
 * (streamed-tool shapes, still-open text streams, still-open delegation items,
 * cumulative usage), which `resetThread` clears at every provider id-space
 * boundary.
 */

const ASSISTANT_STREAM_KEY = "assistant";
const MAX_STATE_ENTRIES = 1024;

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
   * The bridge settled the turn itself (soft stop): prime's `agent_end` still
   * carries item closes, but its boundary must not close the turn twice.
   */
  suppressTurnBoundary?: boolean;
  /** Called when an `agent_end` settles the turn prime is running. */
  onTurnSettled?: (observation: TurnObservation) => void;
}

interface ThreadState {
  toolCalls: Map<string, ToolCallContext>;
  openTextStreams: Set<string>;
  /** Child ids whose delegation item is open on the timeline. */
  openDelegations: Set<string>;
  usage: ThreadEventTokenUsageBreakdown;
  /** Set between `compaction_start` and `compaction_end`; prime's reason decides the settlement. */
  compaction: { manual: boolean } | undefined;
}

export interface PrimeDeltaTranslator {
  translate(event: unknown, context: TranslationContext): ThreadDelta[];
  /** Deltas that rebuild a session's timeline from an attach snapshot. */
  snapshotDeltas(messages: readonly unknown[]): ThreadDelta[];
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
      usage: ZERO_TOKEN_USAGE,
      compaction: undefined,
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
    return [{ kind: "usage", total, last, modelContextWindow: null }];
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
        const failed =
          !aborted &&
          typeof parsed.data.errorMessage === "string" &&
          parsed.data.errorSeverity !== "warning";
        const close: ThreadDelta = {
          kind: "item.close",
          key: { channel: "compaction" },
          item: { type: "compaction" },
          status: aborted ? "interrupted" : failed ? "failed" : "completed",
          ...(parsed.data.errorMessage === undefined
            ? {}
            : { resultText: parsed.data.errorMessage }),
        };
        if (!manual) {
          const automatic: ThreadDelta[] = [close];
          if (failed) {
            automatic.push({
              kind: "provider.error",
              message: "prime-agent failed to compact the context",
              detail: parsed.data.errorMessage,
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
          ...(parsed.data.errorMessage === undefined
            ? {}
            : { error: { message: parsed.data.errorMessage } }),
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
    for (const message of parsed) {
      if (message.role === "user") {
        const text = messageText(message);
        if (text !== undefined) {
          deltas.push({ kind: "input.provider", text });
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
    return deltas;
  }

  return {
    translate,
    snapshotDeltas,
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
    resetThread(threadId) {
      states.delete(threadId);
    },
  };
}

function isErrorResult(result: AgentMessage): boolean {
  return (result as Record<string, unknown>).isError === true;
}

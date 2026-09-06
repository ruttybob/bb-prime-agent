import { z } from "zod";
import { agentMessageSchema, type AgentMessage } from "../daemon/wire.js";

/**
 * A child session's transcript as the Subagents panel renders it (bbpa-b1m.8):
 * role-shaped entries parsed from the wire messages an attach snapshot seeds
 * and `message_end` pushes append.
 *
 * This module is the only place that knows how prime's durable messages map to
 * panel rows. The parse is deliberately tolerant — a prime that adds a message
 * kind (or sends garbage) loses its row, never the panel: every consumer here
 * reads an entry list that is validated once, at this parse.
 *
 * Transcripts are bounded history (the ticket's shape): bounding lives in
 * `boundTranscript` below, and the tracker (`transcripts.ts`) applies it to
 * both the attach seed and every append.
 */

/**
 * One panel row. `toolCallId` is pairing glue for the tracker (a pushed
 * `toolResult` fills the tool row its call opened) and is stripped by the
 * contract schema — the panel never sees it.
 */
export interface TranscriptEntry {
  kind: "user" | "assistant" | "thinking" | "tool";
  text?: string;
  toolName?: string;
  argsPreview?: string;
  resultText?: string;
  isError?: boolean;
  toolCallId?: string;
}

/**
 * One row as the panel receives it. No `passthrough`: the contract is where
 * the tracker's pairing glue (`toolCallId`) is stripped from the wire.
 */
export const transcriptEntrySchema = z.object({
  kind: z.enum(["user", "assistant", "thinking", "tool"]),
  text: z.string().optional(),
  toolName: z.string().optional(),
  argsPreview: z.string().optional(),
  resultText: z.string().optional(),
  isError: z.boolean().optional(),
});

/** The bounded transcript a transcript read answers with. */
export const boundedTranscriptSchema = z.object({
  entries: z.array(transcriptEntrySchema).default([]),
  /** Older entries were dropped to hold the history bounds. */
  truncated: z.boolean(),
});
export type BoundedTranscript = z.infer<typeof boundedTranscriptSchema>;

/**
 * Prime's wire text: a plain string or content blocks, where only `text`
 * blocks carry renderable prose. Anything else (`toolCall` blocks, images,
 * unknown future kinds) contributes nothing here.
 */
function wireText(content: AgentMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  return (content ?? [])
    .map((block) => {
      const text = (block as { text?: unknown }).text;
      return block.type === "text" && typeof text === "string" ? text : "";
    })
    .join("");
}

/**
 * Per-text caps: one oversized text must not evict the whole history through
 * the byte bound, so each kept string is capped where it is read. The result
 * cap mirrors prime's own `SESSION_COMMAND_RESULT_MAX_CHARS` rationale — tool
 * output can run much longer than anything worth rendering.
 */
const MAX_USER_TEXT_CHARS = 8000;
const MAX_ASSISTANT_TEXT_CHARS = 8000;
const MAX_THINKING_CHARS = 2000;
const MAX_RESULT_TEXT_CHARS = 2000;
const MAX_ARGS_PREVIEW_CHARS = 400;
const TRUNCATION_MARKER = "\u2026";

/** Keep the head of a long text under `maxChars`, marking the cut honestly. */
function capped(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(0, maxChars) + TRUNCATION_MARKER;
}

/** Compact one-line JSON for tool arguments (render preview, not a re-encode). */
function argsPreview(args: unknown): string | undefined {
  if (args === undefined || args === null) {
    return undefined;
  }
  try {
    return capped(JSON.stringify(args), MAX_ARGS_PREVIEW_CHARS);
  } catch {
    return capped(String(args), MAX_ARGS_PREVIEW_CHARS);
  }
}

/** Entries for one wire message, or none when prime sent something unrenderable. */
function entriesForMessage(
  message: AgentMessage,
  resultsByCallId: Map<string, { text: string; isError: boolean }>,
): TranscriptEntry[] {
  const text = wireText(message.content).trim();
  if (message.role === "user") {
    return text.length > 0
      ? [{ kind: "user", text: capped(text, MAX_USER_TEXT_CHARS) }]
      : [];
  }
  if (message.role === "assistant") {
    const entries: TranscriptEntry[] = [];
    const content = Array.isArray(message.content) ? message.content : [];
    for (const block of content) {
      if (block.type === "thinking") {
        const thinking = (block as { thinking?: unknown }).thinking;
        if (typeof thinking === "string" && thinking.trim().length > 0) {
          entries.push({
            kind: "thinking",
            text: capped(thinking.trim(), MAX_THINKING_CHARS),
          });
        }
        continue;
      }
      if (block.type === "text") {
        const blockText = (block as { text?: unknown }).text;
        if (typeof blockText === "string" && blockText.trim().length > 0) {
          entries.push({
            kind: "assistant",
            text: capped(blockText.trim(), MAX_ASSISTANT_TEXT_CHARS),
          });
        }
        continue;
      }
      if (block.type === "toolCall") {
        const toolName = (block as { name?: unknown }).name;
        if (typeof toolName !== "string" || toolName.length === 0) {
          continue;
        }
        const id = (block as { id?: unknown }).id;
        entries.push({
          kind: "tool",
          toolName,
          argsPreview: argsPreview((block as { arguments?: unknown }).arguments),
          ...(typeof id === "string" ? { toolCallId: id } : {}),
        });
      }
    }
    // A string-content assistant message is still an answer worth a row.
    if (entries.length === 0 && text.length > 0) {
      entries.push({
        kind: "assistant",
        text: capped(text, MAX_ASSISTANT_TEXT_CHARS),
      });
    }
    return entries;
  }
  if (message.role === "toolResult") {
    // The result belongs to the tool row its call opened; a result whose call
    // is not in the list (a branch point, say) has no row to fill.
    return [];
  }
  return [];
}

/**
 * The result a `toolResult` message carries (its text, and prime's error
 * verdict), or `undefined` for any other message. The tracker pairs pushed
 * results into the tool rows their calls opened.
 */
export function toolResultOf(
  durable: unknown,
): { text: string; isError: boolean } | undefined {
  const shape = durable as {
    role?: unknown;
    content?: unknown;
    isError?: unknown;
    toolCallId?: unknown;
  };
  if (shape?.role !== "toolResult" || typeof shape.toolCallId !== "string") {
    return undefined;
  }
  const content = shape.content;
  return {
    text: capped(
      wireText(
        typeof content === "string" || Array.isArray(content) ? content : undefined,
      ).trim(),
      MAX_RESULT_TEXT_CHARS,
    ),
    isError: shape.isError === true,
  };
}

/**
 * Parse a wire message list into panel rows, in order. A `toolResult` message
 * fills the tool row its `toolCallId` opened — results always follow their
 * calls in a session, so one pass over the parsed rows closes each pair.
 */
export function entriesFromWireMessages(messages: readonly unknown[]): TranscriptEntry[] {
  const resultsByCallId = new Map<
    string,
    { text: string; isError: boolean }
  >();
  for (const raw of messages) {
    const parsed = agentMessageSchema.safeParse(raw);
    if (!parsed.success) {
      continue;
    }
    const result = toolResultOf(parsed.data);
    if (result === undefined) {
      continue;
    }
    const callId = (parsed.data as { toolCallId?: unknown }).toolCallId;
    if (typeof callId !== "string") {
      continue;
    }
    resultsByCallId.set(callId, result);
  }
  const entries: TranscriptEntry[] = [];
  for (const raw of messages) {
    const parsed = agentMessageSchema.safeParse(raw);
    if (!parsed.success) {
      continue;
    }
    for (const entry of entriesForMessage(parsed.data, resultsByCallId)) {
      if (entry.kind === "tool" && entry.toolCallId !== undefined) {
        const result = resultsByCallId.get(entry.toolCallId);
        if (result !== undefined) {
          entry.resultText = result.text.length > 0 ? result.text : undefined;
          entry.isError = result.isError;
        }
      }
      entries.push(entry);
    }
  }
  return entries;
}

/* ------------------------------- bounds ------------------------------- */

/** The history bounds a transcript is held to (count and rendered size). */
export interface TranscriptBounds {
  maxEntries: number;
  maxTotalBytes: number;
}

const utf8 = new TextEncoder();

/** UTF-8 bytes of the text one row keeps — the size the panel actually renders. */
function entryBytes(entry: TranscriptEntry): number {
  const kept = [entry.text, entry.argsPreview, entry.resultText]
    .filter((value): value is string => typeof value === "string");
  return utf8.encode(kept.join("\n")).length;
}

/**
 * Hold a transcript to its bounds by dropping the OLDEST rows first — the
 * shape of a bounded history is "the most recent things", never a hole in the
 * middle. `truncated` is honest about anything dropped, even when a later
 * append would fit again (the history did not grow back).
 */
export function boundTranscript(
  entries: TranscriptEntry[],
  bounds: TranscriptBounds,
): BoundedTranscript {
  const kept = [...entries];
  let dropped = false;
  while (
    kept.length > 0 &&
    (kept.length > bounds.maxEntries ||
      kept.reduce((total, entry) => total + entryBytes(entry), 0) > bounds.maxTotalBytes)
  ) {
    kept.shift();
    dropped = true;
  }
  return { entries: kept, truncated: dropped };
}

/**
 * The bridge ↔ companion-extension channel wire contract (bridge half).
 *
 * The channel is how bb's dynamic tools reach a prime session and how the
 * model's calls to them come back: at session create the bridge starts a
 * per-session unix socket and hands its path to the companion extension via
 * `create.config.extensionFlagValues[BB_TOOLS_CHANNEL_FLAG]` (ADR-0003 — no
 * env-var channel exists in prime 0.7.3, and no daemon command adds extension
 * paths after create). The extension side is `extension/bb-tools-extension.ts`;
 * the message reference both halves implement is `extension/PROTOCOL.md`, and a
 * unit test asserts the two files keep the same vocabulary.
 *
 * JSONL, one message per line. Ordering: the extension is the responder — the
 * bridge pushes `tools/set` whenever the desired set is (re)published, and
 * answers every `tool/call` with exactly one `tool/result`.
 */

/**
 * The `create.config.extensionFlagValues` key carrying the channel endpoint.
 * Must match `BB_TOOLS_CHANNEL_FLAG` in `extension/bb-tools-extension.ts`.
 */
export const BB_TOOLS_CHANNEL_FLAG = "bb_tools_channel";

/** Bumped on a breaking change to the message set in PROTOCOL.md. */
export const BB_TOOLS_PROTOCOL_VERSION = 1;

/** A bb dynamic tool as published over the channel. */
export interface BbChannelTool {
  name: string;
  description: string;
  /**
   * Adopted JSON Schema (bb's `DynamicTool.inputSchema`) for the parameters
   * object — what prime hands to the model verbatim.
   */
  parameters?: Record<string, unknown>;
  /** Human-readable label for prime's UI; defaults to the tool name. */
  label?: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
}

/** Bridge → extension: replace the session's whole bb tool set. Idempotent. */
export interface ToolsSetMessage {
  type: "tools/set";
  tools: BbChannelTool[];
}

/** Extension → bridge: outcome of applying a `tools/set`. */
export type ToolsAckMessage =
  | { type: "tools/ack"; ok: true; registered: string[]; active: string[] }
  | { type: "tools/ack"; ok: false; error: string };

/** Extension → bridge: the model called a bb tool; the bridge executes it. */
export interface ToolCallMessage {
  type: "tool/call";
  callId: string;
  name: string;
  args: Record<string, unknown>;
}

/**
 * A tool result payload, structurally the SDK's `BridgeToolCallResult` (which
 * the SDK declares but does not export) — what the `item/tool/call` wiring
 * (bbpa-ggf.3) hands back for a bb tool.
 */
export interface BbChannelToolResult {
  content: string;
  contentBlocks?: (ToolResultTextBlock | ToolResultImageBlock)[];
  images?: { data: string; mimeType: string }[];
  isError?: boolean;
}

export interface ToolResultTextBlock {
  type: "text";
  text: string;
}

export interface ToolResultImageBlock {
  type: "image";
  data: string;
  mimeType: string;
}

/** Bridge → extension: the answer to a `tool/call`. Exactly one per call. */
export type ToolResultMessage =
  | { type: "tool/result"; callId: string; ok: true; result: BbChannelToolResult }
  | { type: "tool/result"; callId: string; ok: false; error: string };

/** Any message the extension may send the bridge. */
export type ExtensionChannelMessage = ToolsAckMessage | ToolCallMessage;

/** Any message the bridge may send the extension. */
export type BridgeChannelMessage = ToolsSetMessage | ToolResultMessage;

/** Structural parse of one extension→bridge line. `null` = ignore the line. */
export function parseExtensionChannelMessage(value: unknown): ExtensionChannelMessage | null {
  if (!isJsonObject(value) || typeof value.type !== "string") {
    return null;
  }
  switch (value.type) {
    case "tools/ack": {
      if (value.ok === true) {
        return {
          type: "tools/ack",
          ok: true,
          registered: stringArray(value.registered),
          active: stringArray(value.active),
        };
      }
      return {
        type: "tools/ack",
        ok: false,
        error: typeof value.error === "string" ? value.error : "the extension rejected the tool set",
      };
    }
    case "tool/call": {
      if (typeof value.callId !== "string" || typeof value.name !== "string") {
        return null;
      }
      return {
        type: "tool/call",
        callId: value.callId,
        name: value.name,
        args: isJsonObject(value.args) ? value.args : {},
      };
    }
    default:
      return null;
  }
}

/** Structural check of a bridge→extension `tools/set` payload. */
export function toolsSetMessage(tools: readonly BbChannelTool[]): ToolsSetMessage {
  return {
    type: "tools/set",
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      ...(tool.parameters === undefined ? {} : { parameters: tool.parameters }),
      ...(tool.label === undefined ? {} : { label: tool.label }),
      ...(tool.promptSnippet === undefined ? {} : { promptSnippet: tool.promptSnippet }),
      ...(tool.promptGuidelines === undefined ? {} : { promptGuidelines: tool.promptGuidelines }),
    })),
  };
}

/** True when the value is a JSON object (arrays are not objects here). */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

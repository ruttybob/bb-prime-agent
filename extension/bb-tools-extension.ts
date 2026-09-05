/**
 * The bb ↔ prime companion extension (the dynamic-tools channel, ADR-0003).
 *
 * prime-agent loads this file directly — through jiti, so plain TypeScript with
 * **no imports beyond node builtins** is the contract. It is passed per session
 * as `create.config.extensions[0]` alongside `noExtensions: true` (the `-e` +
 * `-ne` combo), and learns where its channel lives from the
 * `create.config.extensionFlagValues` value of the `bb_tools_channel` flag:
 *
 *     config: {
 *       noExtensions: true,
 *       extensions: [<this file>],
 *       extensionFlagValues: { bb_tools_channel: <unix socket path> },
 *     }
 *
 * The flag value is applied *after* extension load (prime populates flag
 * values once the resource loader has finished), so it is read lazily in
 * `session_start`, never at factory time.
 *
 * Over that channel the bridge publishes the bb tool set (`tools/set`, full-set
 * replace) and answers this extension's forwardings of model tool calls
 * (`tool/call` → `tool/result`). See PROTOCOL.md next to this file; the
 * bridge-side half of the wire lives in `src/dynamic-tools/`.
 *
 * There is no `unregisterTool` in prime 0.7.3, so removal is availability
 * toggling: every requested tool is (re-)registered once, and
 * `pi.setActiveTools()` is reconciled to the requested set — bb tools that
 * dropped out of the set are deactivated, everything prime had active stays
 * active.
 */

import { connect, type Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";

/**
 * The `create.config.extensionFlagValues` key the bridge sets to hand this
 * extension its channel endpoint. Must match `BB_TOOLS_CHANNEL_FLAG` in
 * `src/dynamic-tools/protocol.ts` (a unit test asserts the two stay in sync).
 */
export const BB_TOOLS_CHANNEL_FLAG = "bb_tools_channel";

/** Wire version of this channel; bumped on a breaking PROTOCOL.md change. */
export const BB_TOOLS_PROTOCOL_VERSION = 1;

/** A bb tool as published by a `tools/set` message. */
export interface BbExtensionTool {
  name: string;
  description: string;
  /**
   * Adopted JSON Schema for the tool's parameters object. A plain JSON Schema
   * object is exactly what prime's `ToolDefinition.parameters` is at runtime,
   * and what the model sees.
   */
  parameters?: Record<string, unknown>;
  /** Human-readable label; defaults to the tool name (prime UI). */
  label?: string;
  /** Optional extra text prime may use when composing prompts. */
  promptSnippet?: string;
  /** Optional guideline bullets prime appends while this tool is active. */
  promptGuidelines?: string[];
}

/**
 * The subset of prime's ExtensionAPI this extension touches, typed
 * structurally so this file stays free of prime imports (and therefore loads
 * from any path, on any prime release that keeps these names).
 */
export interface BbExtensionApi {
  registerFlag(
    name: string,
    options: { description?: string; type: "boolean" | "string"; default?: boolean | string },
  ): void;
  getFlag(name: string): boolean | string | undefined;
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    promptSnippet?: string;
    promptGuidelines?: string[];
    parameters: Record<string, unknown>;
    execute(
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal | undefined,
    ): Promise<{ content: unknown[]; details: unknown }>;
  }): void;
  getActiveTools(): string[];
  setActiveTools(toolNames: string[]): void;
  on(event: string, handler: (event: unknown, ctx: unknown) => void): void;
}

/** Per-extension state: registration bookkeeping plus the channel socket. */
export interface BbExtensionState {
  /** The ExtensionAPI of the session this state serves (set at factory time). */
  pi?: BbExtensionApi;
  /** Every name this extension ever registered (removal needs the superset). */
  readonly everRegistered: Set<string>;
  /** Names in the most recently applied bb tool set (replaced per set). */
  requested: Set<string>;
  readonly pendingCalls: Map<
    string,
    { resolve: (result: { content: unknown[]; details: unknown }) => void; reject: (error: Error) => void }
  >;
  nextCallId: number;
  socket: Socket | null;
  buffer: string;
  decoder: StringDecoder | null;
  channelPath: string | null;
  connectAttempts: number;
  reconnectTimer: NodeJS.Timeout | null;
  closedForGood: boolean;
}

export function createBbExtensionState(): BbExtensionState {
  return {
    everRegistered: new Set<string>(),
    requested: new Set<string>(),
    pendingCalls: new Map(),
    nextCallId: 0,
    socket: null,
    buffer: "",
    decoder: null,
    channelPath: null,
    connectAttempts: 0,
    reconnectTimer: null,
    closedForGood: false,
  };
}

const EMPTY_OBJECT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {},
  required: [],
};

/**
 * Reconcile prime's tool registry and active set with the requested bb set.
 *
 * Registration: `registerTool` replaces the definition for a known name and
 * auto-activates a brand-new one, so re-registering the full set on every
 * `tools/set` keeps descriptions in sync with bb at the cost of one registry
 * rebuild. Availability: the active set becomes (everything prime had active)
 * ∪ (requested bb tools) − (bb tools that left the set).
 */
export function applyBbToolSet(
  pi: BbExtensionApi,
  state: BbExtensionState,
  desired: readonly BbExtensionTool[],
): { registered: string[]; active: string[] } {
  // The requested set is whatever this message says — tools absent from it are
  // being removed, so it is replaced, never merged.
  state.requested = new Set(desired.map((tool) => tool.name));
  for (const tool of desired) {
    pi.registerTool(toToolDefinition(tool, state));
    state.everRegistered.add(tool.name);
  }
  const current = pi.getActiveTools();
  const active = new Set(current);
  for (const tool of desired) {
    active.add(tool.name);
  }
  for (const name of state.everRegistered) {
    if (!state.requested.has(name)) {
      active.delete(name);
    }
  }
  const next = [...active];
  if (!sameMembers(current, next)) {
    pi.setActiveTools(next);
  }
  return { registered: [...state.requested], active: next };
}

function toToolDefinition(
  tool: BbExtensionTool,
  state: BbExtensionState,
): {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: Record<string, unknown>;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<{ content: unknown[]; details: unknown }>;
} {
  return {
    name: tool.name,
    label: tool.label ?? tool.name,
    description: tool.description,
    ...(tool.promptSnippet === undefined ? {} : { promptSnippet: tool.promptSnippet }),
    ...(tool.promptGuidelines === undefined ? {} : { promptGuidelines: tool.promptGuidelines }),
    parameters: isRecord(tool.parameters) ? tool.parameters : EMPTY_OBJECT_SCHEMA,
    execute: (_toolCallId, params, signal) => forwardToolCall(state, tool.name, params, signal),
  };
}

/** Forward one model tool call to the bridge and wait for its verdict. */
function forwardToolCall(
  state: BbExtensionState,
  name: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<{ content: unknown[]; details: unknown }> {
  return new Promise((resolve, reject) => {
    state.nextCallId += 1;
    const callId = `bb-tc-${String(state.nextCallId)}`;
    const abort = (): void => {
      if (!state.pendingCalls.has(callId)) {
        return;
      }
      state.pendingCalls.delete(callId);
      reject(new Error(`bb tool "${name}" was aborted before the bridge answered`));
    };
    // Register before the abort check's window: once the entry exists, either
    // path (already-aborted signal or a later abort event) rejects the call.
    if (signal !== undefined) {
      if (signal.aborted) {
        reject(new Error(`bb tool "${name}" was aborted before the bridge answered`));
        return;
      }
      signal.addEventListener("abort", abort, { once: true });
    }
    state.pendingCalls.set(callId, { resolve, reject });
    sendLine(state, { type: "tool/call", callId, name, args: isRecord(params) ? params : {} });
  });
}

/**
 * The extension entry point prime calls with the ExtensionAPI.
 *
 * The channel is opened on `session_start` (flag values exist by then) and is
 * reused across reloads; a `session_shutdown` closes it without reconnecting.
 */
export default function bbToolsExtension(pi: BbExtensionApi): void {
  const state = createBbExtensionState();
  state.pi = pi;

  pi.registerFlag(BB_TOOLS_CHANNEL_FLAG, {
    type: "string",
    description:
      "bb provider bridge: path of the per-session unix socket that carries this session's bb tool set",
  });

  pi.on("session_start", () => {
    const channelPath = pi.getFlag(BB_TOOLS_CHANNEL_FLAG);
    if (typeof channelPath === "string" && channelPath.trim() !== "") {
      openChannel(pi, state, channelPath);
    }
  });

  pi.on("session_shutdown", () => {
    state.closedForGood = true;
    closeChannel(state);
  });
}

/** Connect to the bridge channel (retrying briefly), or reuse a live socket. */
function openChannel(pi: BbExtensionApi, state: BbExtensionState, channelPath: string): void {
  if (state.socket !== null || state.closedForGood) {
    return;
  }
  state.channelPath = channelPath;
  const socket = connect(channelPath);
  state.socket = socket;
  state.buffer = "";
  state.decoder = new StringDecoder("utf8");

  socket.on("data", (chunk: Buffer | string) => {
    handleChunk(state, typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
  });
  socket.on("connect", () => {
    // A live connection is the only state the bridge needs; it pushes the
    // current `tools/set` the moment this socket is accepted.
    state.connectAttempts = 0;
  });
  socket.on("error", () => {
    // Reported through `close`; a missing bridge channel is not a session error.
  });
  socket.on("close", () => {
    state.socket = null;
    state.buffer = "";
    state.decoder = null;
    failPendingCalls(state, "the bb tools channel closed");
    scheduleReconnect(pi, state);
  });
}

/**
 * Bounded reconnect: the bridge listens before `create`, so a healthy pairing
 * connects on the first try; the budget only covers startup races. After it
 * expires the extension stays quiescent until the next `session_start`.
 */
function scheduleReconnect(pi: BbExtensionApi, state: BbExtensionState): void {
  if (state.closedForGood || state.channelPath === null || state.connectAttempts >= 12) {
    return;
  }
  state.connectAttempts += 1;
  const path = state.channelPath;
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    openChannel(pi, state, path);
  }, 500);
  state.reconnectTimer.unref?.();
}

function closeChannel(state: BbExtensionState): void {
  if (state.reconnectTimer !== null) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  const socket = state.socket;
  state.socket = null;
  state.buffer = "";
  state.decoder = null;
  if (socket !== null) {
    socket.destroy();
  }
  failPendingCalls(state, "the bb tools channel closed");
}

function failPendingCalls(state: BbExtensionState, message: string): void {
  const pending = [...state.pendingCalls.values()];
  state.pendingCalls.clear();
  for (const call of pending) {
    call.reject(new Error(message));
  }
}

function handleChunk(state: BbExtensionState, chunk: Buffer): void {
  const decoder = state.decoder;
  if (decoder === null) {
    return;
  }
  state.buffer += decoder.write(chunk);
  let newline = state.buffer.indexOf("\n");
  while (newline >= 0) {
    const line = state.buffer.slice(0, newline).trim();
    state.buffer = state.buffer.slice(newline + 1);
    if (line !== "") {
      handleLine(state, line);
    }
    newline = state.buffer.indexOf("\n");
  }
}

function handleLine(state: BbExtensionState, line: string): void {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (!isRecord(message)) {
    return;
  }
  if (message.type === "tools/set") {
    handleToolsSet(state, message);
    return;
  }
  if (message.type === "tool/result") {
    handleToolResult(state, message);
    return;
  }
  // Anything else (a newer bridge, a stray line) is ignored: this extension
  // never answers what it does not understand.
}

function handleToolsSet(state: BbExtensionState, message: Record<string, unknown>): void {
  const pi = state.pi;
  if (pi === undefined) {
    return;
  }
  const desired = parseToolSet(message.tools);
  try {
    const applied = applyBbToolSet(pi, state, desired);
    sendLine(state, { type: "tools/ack", ok: true, ...applied });
  } catch (error) {
    sendLine(state, {
      type: "tools/ack",
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function handleToolResult(state: BbExtensionState, message: Record<string, unknown>): void {
  const callId = message.callId;
  if (typeof callId !== "string") {
    return;
  }
  const pending = state.pendingCalls.get(callId);
  if (pending === undefined) {
    // Aborted before the answer came back, or the turn moved on: drop it.
    return;
  }
  state.pendingCalls.delete(callId);
  if (message.ok === true) {
    pending.resolve({ content: toContentBlocks(message.result), details: { bb: true } });
    return;
  }
  pending.reject(
    new Error(
      typeof message.error === "string" && message.error !== ""
        ? message.error
        : "the bb tool call failed",
    ),
  );
}

/** Bridge `tool/result` payload → prime's `AgentToolResult.content`. */
function toContentBlocks(result: unknown): unknown[] {
  const blocks: unknown[] = [];
  const source = isRecord(result) ? result : {};
  if (typeof source.content === "string" && source.content !== "") {
    blocks.push({ type: "text", text: source.content });
  }
  const candidates = [
    ...(Array.isArray(source.contentBlocks) ? source.contentBlocks : []),
    ...(Array.isArray(source.images) ? source.images : []),
  ];
  for (const candidate of candidates) {
    if (!isRecord(candidate)) {
      continue;
    }
    if (candidate.type === "text" && typeof candidate.text === "string") {
      blocks.push({ type: "text", text: candidate.text });
    } else if (
      candidate.type === "image" &&
      typeof candidate.data === "string" &&
      typeof candidate.mimeType === "string"
    ) {
      blocks.push({ type: "image", data: candidate.data, mimeType: candidate.mimeType });
    }
  }
  if (blocks.length === 0) {
    blocks.push({ type: "text", text: "" });
  }
  return blocks;
}

function parseToolSet(value: unknown): BbExtensionTool[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const tools: BbExtensionTool[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate) || typeof candidate.name !== "string" || candidate.name === "") {
      continue;
    }
    tools.push({
      name: candidate.name,
      description: typeof candidate.description === "string" ? candidate.description : "",
      ...(isRecord(candidate.parameters) ? { parameters: candidate.parameters } : {}),
      ...(typeof candidate.label === "string" ? { label: candidate.label } : {}),
      ...(typeof candidate.promptSnippet === "string" ? { promptSnippet: candidate.promptSnippet } : {}),
      ...(Array.isArray(candidate.promptGuidelines)
        ? { promptGuidelines: candidate.promptGuidelines.filter((g) => typeof g === "string") }
        : {}),
    });
  }
  return tools;
}

function sendLine(state: BbExtensionState, message: Record<string, unknown>): void {
  const socket = state.socket;
  if (socket === null || socket.destroyed) {
    // The bridge is gone; nothing to report to.
    return;
  }
  socket.write(`${JSON.stringify(message)}\n`);
}

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const seen = new Set(left);
  for (const name of right) {
    if (!seen.has(name)) {
      return false;
    }
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

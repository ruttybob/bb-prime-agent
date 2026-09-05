import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";
import {
  parseExtensionChannelMessage,
  toolsSetMessage,
  type BbChannelTool,
  type BbChannelToolResult,
  type ToolsAckMessage,
  type ToolResultMessage,
} from "./protocol.js";

/** How long `setTools` waits for the extension's `tools/ack` by default. */
export const DEFAULT_ACK_TIMEOUT_MS = 10_000;

/**
 * A successful `tools/set` application, straight from the extension.
 */
export type ToolsAck = Extract<ToolsAckMessage, { ok: true }>;

/** A bb tool call the model made, forwarded by the companion extension. */
export interface BbToolCall {
  callId: string;
  name: string;
  args: Record<string, unknown>;
}

/**
 * What the caller of the `onToolCall` hook produces. The success payload is
 * the SDK's `BridgeToolCallResult` shape, i.e. exactly what the
 * `item/tool/call` outbound request (bbpa-ggf.3) returns for a bb tool — the
 * scripted executor in tests and the real wiring produce the same shape.
 */
export type BbToolCallOutcome =
  | ({ ok: true } & BbChannelToolResult)
  | { ok: false; error: string };

export type BbToolCallHandler = (call: BbToolCall) => Promise<BbToolCallOutcome>;

export type DynamicToolsChannelStatus =
  | { status: "listening"; socketPath: string }
  | { status: "extension-connected"; socketPath: string }
  | { status: "extension-disconnected"; socketPath: string }
  | { status: "server-error"; socketPath: string; message: string }
  | { status: "closed"; socketPath: string };

export interface DynamicToolsChannelOptions {
  /** The bb thread's provider session id; names the socket file. */
  providerThreadId: string;
  /**
   * Executes a model call to a bb tool. The chat path (bbpa-ggf.3) implements
   * this as the bridge's `item/tool/call` outbound request; tests script it.
   */
  onToolCall: BbToolCallHandler;
  /** Overrides the minted socket path (tests, exotic sandboxes). */
  socketPath?: string;
  /** Directory for the minted socket. Defaults to a per-user temp dir. */
  socketDir?: string;
  ackTimeoutMs?: number;
  onStatus?: (status: DynamicToolsChannelStatus) => void;
  /** Receives lines the extension sent that this protocol does not define. */
  onUnknownMessage?: (value: unknown) => void;
}

interface AckWaiter<T = ToolsAck> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * The bridge side of one session's dynamic-tools channel: a unix socket the
 * companion prime extension connects to, over which the bridge publishes the
 * bb tool set (`tools/set`, full-set replace, idempotent) and answers the
 * extension's `tool/call` forwardings.
 *
 * Lifecycle mirrors the daemon session: `listen()` before the `create` command
 * (the extension connects while the prime worker boots), `setTools()` once the
 * bb thread knows its tools, `close()` when the thread is released. A
 * reconnecting extension (prime worker replacement, `/reload`) is re-published
 * the current desired set automatically, so the session's tool state survives
 * the replacement without bb knowing.
 */
export class DynamicToolsChannel {
  private readonly providerThreadId: string;
  private readonly onToolCall: BbToolCallHandler;
  private readonly ackTimeoutMs: number;
  private readonly onStatus: ((status: DynamicToolsChannelStatus) => void) | undefined;
  private readonly onUnknownMessage: ((value: unknown) => void) | undefined;

  private server: Server | null = null;
  private socket: Socket | null = null;
  private decoder: StringDecoder | null = null;
  private buffer = "";
  private readonly socketPath: string;
  private ownsSocketFile = false;
  /** The set the extension should be reconciled to; re-published on reconnect. */
  private desiredTools: readonly BbChannelTool[] | null = null;
  /** Serializes `setTools` so every caller awaits its own ack, in order. */
  private setChain: Promise<unknown> = Promise.resolve();
  private readonly ackWaiters: AckWaiter[] = [];
  private connectionWaiters: AckWaiter<void>[] = [];
  private closed = false;

  constructor(options: DynamicToolsChannelOptions) {
    this.providerThreadId = options.providerThreadId;
    this.onToolCall = options.onToolCall;
    this.ackTimeoutMs = options.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
    this.onStatus = options.onStatus;
    this.onUnknownMessage = options.onUnknownMessage;
    this.socketPath =
      options.socketPath ?? mintChannelSocketPath(options.providerThreadId, options.socketDir);
  }

  /** The path the bridge passes to the extension via `extensionFlagValues`. */
  get path(): string {
    return this.socketPath;
  }

  /** Whether the companion extension is currently attached. */
  get connected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }

  get desiredSet(): readonly BbChannelTool[] {
    return this.desiredTools ?? [];
  }

  /** Start listening. Must happen before the daemon `create` command. */
  listen(): Promise<void> {
    if (this.server !== null) {
      return Promise.resolve();
    }
    if (this.closed) {
      return Promise.reject(new Error("the dynamic-tools channel is closed"));
    }
    if (process.platform !== "win32") {
      // The per-user channel dir is created on demand, like prime's own
      // `prime-agent-<uid>` socket dir.
      try {
        mkdirSync(dirname(this.socketPath), { recursive: true });
      } catch (error) {
        return Promise.reject(
          new Error(
            `the dynamic-tools channel for ${this.providerThreadId} could not create ${dirname(this.socketPath)}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
      }
    }
    return new Promise<void>((resolve, reject) => {
      const server = createServer((socket) => this.handleConnection(socket));
      this.server = server;
      server.once("error", (error: Error) => {
        this.server = null;
        reject(
          new Error(
            `the dynamic-tools channel for ${this.providerThreadId} could not listen on ${this.socketPath}: ${error.message}`,
          ),
        );
      });
      server.listen(this.socketPath, () => {
        server.off("error", reject);
        server.on("error", (error: Error) => this.handleServerError(error));
        this.ownsSocketFile = process.platform !== "win32";
        if (this.ownsSocketFile) {
          // Same-user-only, like prime's own daemon socket.
          try {
            chmodSync(this.socketPath, 0o600);
          } catch {
            this.ownsSocketFile = false;
          }
        }
        this.onStatus?.({ status: "listening", socketPath: this.socketPath });
        resolve();
      });
    });
  }

  /**
   * Publish the session's bb tool set and wait for the extension to confirm
   * it. Idempotent and full-set: publish the same set twice and the extension
   * converges on it twice. If the extension has not connected yet, the set is
   * remembered and pushed the moment it does.
   */
  async setTools(
    tools: readonly BbChannelTool[],
    args: { timeoutMs?: number } = {},
  ): Promise<ToolsAck> {
    if (this.closed) {
      throw new Error(`the dynamic-tools channel for ${this.providerThreadId} is closed`);
    }
    const run = this.setChain.then(
      () => this.publish(tools, args.timeoutMs ?? this.ackTimeoutMs),
      () => this.publish(tools, args.timeoutMs ?? this.ackTimeoutMs),
    );
    this.setChain = run;
    return run;
  }

  /** Close the channel: drop the extension, stop listening, remove the socket. */
  async close(): Promise<void> {
    if (this.closed && this.server === null) {
      return;
    }
    this.closed = true;
    this.dropConnection();
    const server = this.server;
    this.server = null;
    if (server !== null) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    if (this.ownsSocketFile) {
      try {
        rmSync(this.socketPath, { force: true });
      } catch {
        // The socket file is in a temp dir; a stale one harms nobody.
      }
      this.ownsSocketFile = false;
    }
    this.failAckWaiters(new Error("the dynamic-tools channel closed before the extension answered"));
    this.failConnectionWaiters(new Error("the dynamic-tools channel closed before the extension connected"));
    this.onStatus?.({ status: "closed", socketPath: this.socketPath });
  }

  private async publish(tools: readonly BbChannelTool[], timeoutMs: number): Promise<ToolsAck> {
    // Recorded first: if the extension is not attached yet, the auto-publish
    // on its next connection delivers exactly this set, and the ack below
    // settles then.
    this.desiredTools = [...tools];
    const deadline = Date.now() + timeoutMs;
    await this.waitForConnection(deadline);
    if (this.connected) {
      this.write(toolsSetMessage(this.desiredTools));
    }
    const remaining = deadline - Date.now();
    return new Promise<ToolsAck>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          const index = this.ackWaiters.findIndex((waiter) => waiter.timer === timer);
          if (index >= 0) {
            this.ackWaiters.splice(index, 1);
          }
          reject(
            new Error(
              `the companion extension did not acknowledge the tool set within ${timeoutMs}ms (${this.socketPath})`,
            ),
          );
        },
        Math.max(remaining, 1),
      );
      this.ackWaiters.push({ resolve, reject, timer });
    });
  }

  /** Resolves once the extension is attached; rejects when the deadline passes. */
  private waitForConnection(deadline: number): Promise<void> {
    if (this.connected) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.connectionWaiters = this.connectionWaiters.filter((entry) => entry.timer !== timer);
        reject(
          new Error(
            `the companion extension never connected to ${this.socketPath}; the tool set stays queued and is pushed if it connects later`,
          ),
        );
      }, Math.max(deadline - Date.now(), 1));
      this.connectionWaiters.push({ resolve, reject, timer });
    });
  }

  private settleConnectionWaiters(): void {
    if (!this.connected) {
      return;
    }
    const waiters = this.connectionWaiters;
    this.connectionWaiters = [];
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }

  private failConnectionWaiters(error: Error): void {
    const waiters = this.connectionWaiters;
    this.connectionWaiters = [];
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  private handleConnection(socket: Socket): void {
    // Latest extension wins: a prime worker replacement opens a fresh socket
    // while the previous one may still be draining. The new connection is
    // re-published the current desired set, so tool state follows the worker.
    this.dropConnection();
    this.socket = socket;
    this.decoder = new StringDecoder("utf8");
    this.buffer = "";
    this.onStatus?.({ status: "extension-connected", socketPath: this.socketPath });
    socket.on("data", (chunk: Buffer) => this.handleChunk(chunk));
    socket.on("error", () => {
      // Surface as a close; the extension retries on its own side.
    });
    socket.on("close", () => {
      if (this.socket === socket) {
        this.socket = null;
        this.decoder = null;
        this.buffer = "";
        this.onStatus?.({
          status: "extension-disconnected",
          socketPath: this.socketPath,
        });
      }
    });
    this.settleConnectionWaiters();
    const desired = this.desiredTools;
    if (desired !== null) {
      // No waiter: a caller is not awaiting this publish. Its ack resolves any
      // `setTools` that is still pending on a reconnect.
      this.write(toolsSetMessage(desired));
    }
  }

  private dropConnection(): void {
    const socket = this.socket;
    this.socket = null;
    this.decoder = null;
    this.buffer = "";
    if (socket !== null && !socket.destroyed) {
      socket.destroy();
    }
  }

  private handleServerError(error: Error): void {
    // Post-listen failures (a deleted socket file, EMFILE) keep the channel
    // alive; the next `setTools` reports an unconnected channel either way.
    this.onStatus?.({ status: "server-error", socketPath: this.socketPath, message: error.message });
  }

  private handleChunk(chunk: Buffer): void {
    const decoder = this.decoder;
    if (decoder === null) {
      return;
    }
    this.buffer += decoder.write(chunk);
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line !== "") {
        this.handleLine(line);
      }
      newline = this.buffer.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    const message = parseExtensionChannelMessage(parsed);
    if (message === null) {
      this.onUnknownMessage?.(parsed);
      return;
    }
    if (message.type === "tools/ack") {
      this.handleAck(message);
      return;
    }
    void this.handleToolCall(message.callId, message.name, message.args);
  }

  private handleAck(message: ToolsAckMessage): void {
    const waiters = this.ackWaiters.splice(0, this.ackWaiters.length);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      if (message.ok) {
        waiter.resolve(message);
      } else {
        waiter.reject(new Error(`the companion extension rejected the tool set: ${message.error}`));
      }
    }
  }

  private async handleToolCall(
    callId: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<void> {
    let outcome: BbToolCallOutcome;
    try {
      outcome = await this.onToolCall({ callId, name, args });
    } catch (error) {
      outcome = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    const reply: ToolResultMessage =
      outcome.ok
        ? {
            type: "tool/result",
            callId,
            ok: true,
            result: {
              content: outcome.content,
              ...(outcome.contentBlocks === undefined ? {} : { contentBlocks: outcome.contentBlocks }),
              ...(outcome.images === undefined ? {} : { images: outcome.images }),
            },
          }
        : { type: "tool/result", callId, ok: false, error: outcome.error };
    this.write(reply);
  }

  private write(message: unknown): void {
    const socket = this.socket;
    if (socket === null || socket.destroyed) {
      return;
    }
    socket.write(`${JSON.stringify(message)}\n`);
  }

  private failAckWaiters(error: Error): void {
    const waiters = this.ackWaiters.splice(0, this.ackWaiters.length);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
}

/**
 * Where the bridge's per-session channels live, mirroring prime's own
 * `os.tmpdir()/prime-agent-<uid>/` layout.
 */
export function defaultChannelSocketDir(): string {
  const suffix = typeof process.getuid === "function" ? String(process.getuid()) : "user";
  return join(tmpdir(), `bb-prime-agent-${suffix}`);
}

/** A unique, filesystem-safe socket path for one session's channel. */
export function mintChannelSocketPath(providerThreadId: string, dir?: string): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\bb-prime-agent-${sanitize(providerThreadId)}-${randomBytes(4).toString("hex")}`;
  }
  const base = dir ?? defaultChannelSocketDir();
  return join(base, `${sanitize(providerThreadId)}-${randomBytes(4).toString("hex")}.sock`);
}

function sanitize(value: string): string {
  const cleaned = value.replaceAll(/[^A-Za-z0-9._-]/gu, "_").slice(0, 64);
  return cleaned === "" ? "session" : cleaned;
}

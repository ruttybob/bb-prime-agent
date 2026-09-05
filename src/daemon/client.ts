import { createConnection, type Socket } from "node:net";
import {
  checkDaemonCommandSupport,
  createDaemonCommandEnvelope,
  parseDaemonHello,
  validateDaemonHello,
  type DaemonCommandEnvelope,
  type DaemonCommandUnsupported,
  type DaemonHello,
  type DaemonHelloRejection,
  type DaemonPushMessage,
  type DaemonResponse,
} from "./protocol.js";

const CONNECT_TIMEOUT_MS = 3_000;
const RECONNECT_BUDGET_MS = 30_000;
const RECONNECT_ATTEMPT_DELAY_MS = 500;

/** Raised when the socket drops under an in-flight request. */
export class DaemonConnectionClosedError extends Error {
  readonly socketPath: string;
  constructor(socketPath: string, cause: string) {
    super(
      `the prime-agent daemon connection closed before answering (${cause}); socket ${socketPath}`,
    );
    this.name = "DaemonConnectionClosedError";
    this.socketPath = socketPath;
  }
}

/** Raised by the client-side compat gate, before anything hits the wire. */
export class DaemonCapabilityUnavailableError extends Error {
  readonly command: string;
  readonly missing: DaemonCommandUnsupported["missing"];
  constructor(unsupported: DaemonCommandUnsupported) {
    super(
      `the connected prime-agent daemon cannot run "${unsupported.command}": ${unsupported.detail}`,
    );
    this.name = "DaemonCapabilityUnavailableError";
    this.command = unsupported.command;
    this.missing = unsupported.missing;
  }
}

/** The daemon answered, but not with a hello this bridge can speak to. */
export class DaemonHandshakeError extends Error {
  readonly socketPath: string;
  readonly rejection:
    | DaemonHelloRejection
    | { kind: "invalid_hello"; detail: string };
  /** Set when the greeting parsed but failed validation (version floor). */
  readonly hello: DaemonHello | undefined;
  constructor(
    socketPath: string,
    rejection: DaemonHelloRejection | { kind: "invalid_hello"; detail: string },
    hello?: DaemonHello,
  ) {
    super(`prime-agent daemon handshake failed on ${socketPath}: ${rejection.detail}`);
    this.name = "DaemonHandshakeError";
    this.socketPath = socketPath;
    this.rejection = rejection;
    this.hello = hello;
  }
}

export interface DaemonCommandResult {
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
  errorInfo?: unknown;
}

export interface PrimeDaemonClientOptions {
  socketPath: string;
  clientId?: string;
  requestTimeoutMs?: number;
}

export type ReconnectStatus =
  | { status: "reconnecting"; cause: string }
  | { status: "reconnected"; hello: DaemonHello }
  | { status: "failed"; cause: string };

interface HelloWaiter {
  resolve: (hello: DaemonHello) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface PendingRequest {
  resolve: (result: DaemonCommandResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  command: string;
}

/**
 * A JSONL client for the prime-agent daemon socket: hello handshake,
 * client-side compat gate, request/response correlation, push routing, and
 * bounded auto-reconnect.
 *
 * Every connection begins with the daemon pushing `daemon_hello` — the client
 * never sends a greeting of its own. A reconnect replays nothing: in-flight
 * requests are rejected and the session layer (bbpa-ggf.3) decides what to
 * re-attach, mirroring prime's own recovery model.
 */
export class PrimeDaemonClient {
  private readonly socketPath: string;
  private readonly clientId: string | undefined;
  private readonly requestTimeoutMs: number;
  private socket: Socket | null = null;
  private buffer = "";
  private greeted = false;
  private helloValue: DaemonHello | undefined;
  private handshakeError: Error | undefined;
  private lastSocketError: Error | undefined;
  private helloWaiters: HelloWaiter[] = [];
  private readonly pending = new Map<string, PendingRequest>();
  private requestCounter = 0;
  private closedByUs = false;
  private peerCloseListeners = new Set<(error: Error | undefined) => void>();

  /** Push messages (session events, progress, …) that are not responses. */
  onPush: ((message: DaemonPushMessage) => void) | undefined;

  /**
   * Wire taps, used by the provider-side recording lanes (`bridge→provider`,
   * `provider→bridge`): every JSONL line exactly as it crosses the socket,
   * greeting included. They are notifications, never a gate.
   */
  onWireWrite: ((line: string) => void) | undefined;
  onWireRead: ((line: string) => void) | undefined;

  constructor(options: PrimeDaemonClientOptions) {
    this.socketPath = options.socketPath;
    this.clientId = options.clientId;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  get socketFilePath(): string {
    return this.socketPath;
  }

  get connected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }

  get hello(): DaemonHello | undefined {
    return this.helloValue;
  }

  /** Open the socket and settle only once a valid hello has arrived. */
  async connect(connectTimeoutMs: number = CONNECT_TIMEOUT_MS): Promise<DaemonHello> {
    if (this.socket !== null) {
      throw new Error(`already connected to the prime-agent daemon at ${this.socketPath}`);
    }
    this.helloValue = undefined;
    this.handshakeError = undefined;
    this.lastSocketError = undefined;
    this.closedByUs = false;
    this.greeted = false;
    const socket = await this.openSocket(connectTimeoutMs);
    this.socket = socket;
    this.buffer = "";
    socket.on("data", (chunk: Buffer) => this.handleData(chunk));
    socket.on("close", () => this.handlePeerClose());
    socket.on("error", (error: Error) => {
      // Runtime errors surface as a close; keep the cause for listeners.
      this.lastSocketError = error;
    });
    try {
      return await this.waitForHello(connectTimeoutMs);
    } catch (error) {
      this.disposeSocket(error instanceof Error ? error : undefined);
      throw error;
    }
  }

  /** Wait for the greeting (also how `connect` settles internally). */
  waitForHello(timeoutMs: number = CONNECT_TIMEOUT_MS): Promise<DaemonHello> {
    if (this.helloValue !== undefined) {
      return Promise.resolve(this.helloValue);
    }
    if (this.handshakeError !== undefined) {
      return Promise.reject(this.handshakeError);
    }
    return new Promise<DaemonHello>((resolve, reject) => {
      const waiter: HelloWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.helloWaiters = this.helloWaiters.filter((candidate) => candidate !== waiter);
          reject(
            new Error(
              `timed out after ${timeoutMs}ms waiting for the prime-agent daemon hello at ${this.socketPath}`,
            ),
          );
        }, timeoutMs),
      };
      this.helloWaiters.push(waiter);
    });
  }

  /**
   * Send a command after the compat gate. The gate consults the answered
   * hello, so an unconnected client fails before the wire.
   */
  async request(
    command: { type: string } & Record<string, unknown>,
    args: { timeoutMs?: number } = {},
  ): Promise<DaemonCommandResult> {
    const hello = this.helloValue;
    if (hello === undefined) {
      throw new Error(`cannot send "${command.type}" before the daemon hello completes`);
    }
    const unsupported = checkDaemonCommandSupport(hello, command.type);
    if (unsupported !== null) {
      throw new DaemonCapabilityUnavailableError(unsupported);
    }
    this.requestCounter += 1;
    const id = `bb-${this.requestCounter}`;
    const envelope: DaemonCommandEnvelope = createDaemonCommandEnvelope({
      command,
      id,
      clientId: this.clientId,
      hello,
    });
    return new Promise<DaemonCommandResult>((resolve, reject) => {
      const timeoutMs = args.timeoutMs ?? this.requestTimeoutMs;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `timed out after ${timeoutMs}ms waiting for the daemon to answer "${command.type}"`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, command: command.type });
      this.write(envelope);
    });
  }

  /** Listen for the transport dying under us; reconnect logic hangs off this. */
  onPeerClose(listener: (error: Error | undefined) => void): () => void {
    this.peerCloseListeners.add(listener);
    return () => {
      this.peerCloseListeners.delete(listener);
    };
  }

  /**
   * Reconnect once, coalescing concurrent callers. In-flight requests have
   * already been rejected by the time this runs.
   */
  async reconnect(connectTimeoutMs: number = CONNECT_TIMEOUT_MS): Promise<DaemonHello> {
    this.disposeSocket(undefined);
    return this.connect(connectTimeoutMs);
  }

  /**
   * Reconnect until `budgetMs` elapses; call once the transport has dropped
   * (from an `onPeerClose` listener). Statuses stream through `onStatus`.
   * Commands are never replayed automatically.
   */
  async enableAutoReconnect(
    args: {
      budgetMs?: number;
      attemptDelayMs?: number;
      onStatus?: (status: ReconnectStatus) => void;
    } = {},
  ): Promise<DaemonHello> {
    const budgetMs = args.budgetMs ?? RECONNECT_BUDGET_MS;
    const attemptDelayMs = args.attemptDelayMs ?? RECONNECT_ATTEMPT_DELAY_MS;
    const deadline = Date.now() + budgetMs;
    let cause = "connection lost";
    let attempt = 0;
    while (Date.now() < deadline) {
      args.onStatus?.({ status: "reconnecting", cause });
      try {
        const remaining = deadline - Date.now();
        const hello = await this.connect(Math.min(CONNECT_TIMEOUT_MS, remaining));
        args.onStatus?.({ status: "reconnected", hello });
        return hello;
      } catch (error) {
        cause = error instanceof Error ? error.message : String(error);
        attempt += 1;
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        const wait = Math.min(attemptDelayMs * attempt, 5_000, remaining);
        await new Promise((resolve) => {
          setTimeout(resolve, wait).unref?.();
        });
      }
    }
    args.onStatus?.({ status: "failed", cause });
    throw new Error(
      `gave up reconnecting to the prime-agent daemon at ${this.socketPath} after ${budgetMs}ms: ${cause}`,
    );
  }

  /** Close the socket and fail everything in flight. Idempotent. */
  close(): void {
    this.closedByUs = true;
    this.disposeSocket(undefined);
  }

  private openSocket(connectTimeoutMs: number): Promise<Socket> {
    return new Promise<Socket>((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      const timer = setTimeout(
        () => {
          cleanup();
          socket.destroy();
          reject(
            new Error(
              `timed out after ${connectTimeoutMs}ms connecting to the prime-agent daemon at ${this.socketPath}`,
            ),
          );
        },
        connectTimeoutMs,
      );
      const cleanup = (): void => {
        clearTimeout(timer);
        socket.off("connect", onConnect);
        socket.off("error", onError);
      };
      const onConnect = (): void => {
        cleanup();
        resolve(socket);
      };
      const onError = (error: Error): void => {
        cleanup();
        socket.destroy();
        reject(
          new Error(
            `could not connect to the prime-agent daemon at ${this.socketPath}: ${error.message}`,
          ),
        );
      };
      socket.once("connect", onConnect);
      socket.once("error", onError);
    });
  }

  private write(envelope: DaemonCommandEnvelope): void {
    const socket = this.socket;
    if (socket === null || socket.destroyed) {
      throw new DaemonConnectionClosedError(this.socketPath, "not connected");
    }
    const line = JSON.stringify(envelope);
    this.onWireWrite?.(line);
    socket.write(`${line}\n`);
  }

  private handleData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
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
    this.onWireRead?.(line);
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      // A daemon that speaks gibberish is answered by the handshake or the
      // request timeout; keep the socket so the caller sees that failure.
      return;
    }
    if (typeof message !== "object" || message === null) {
      return;
    }
    const type = (message as Record<string, unknown>).type;
    if (!this.greeted) {
      // The daemon always speaks first: the first line must be its greeting.
      this.greeted = true;
      if (type !== "daemon_hello") {
        this.failHelloWaiters(
          new DaemonHandshakeError(this.socketPath, {
            kind: "invalid_hello",
            detail: `the daemon's first message was "${String(type)}", not a daemon_hello greeting`,
          }),
        );
        return;
      }
    }
    if (type === "response") {
      this.handleResponse(message as DaemonResponse);
      return;
    }
    if (type === "daemon_hello") {
      this.handleHelloLine(message);
      return;
    }
    this.onPush?.(message as DaemonPushMessage);
  }

  private handleHelloLine(message: unknown): void {
    const hello = parseDaemonHello(message);
    if (hello === null) {
      this.failHelloWaiters(
        new DaemonHandshakeError(this.socketPath, {
          kind: "invalid_hello",
          detail: "the daemon's greeting is not a daemon_hello message",
        }),
      );
      return;
    }
    const rejection = validateDaemonHello(hello);
    if (rejection !== null) {
      this.failHelloWaiters(
        new DaemonHandshakeError(this.socketPath, rejection, hello),
      );
      return;
    }
    this.helloValue = hello;
    const waiters = this.helloWaiters;
    this.helloWaiters = [];
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(hello);
    }
  }

  private failHelloWaiters(error: Error): void {
    this.handshakeError = error;
    const waiters = this.helloWaiters;
    this.helloWaiters = [];
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  private handleResponse(message: DaemonResponse): void {
    const pending = this.pending.get(message.id);
    if (pending === undefined) {
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    pending.resolve({
      command:
        typeof message.command === "string" ? message.command : pending.command,
      success: message.success === true,
      ...(message.data === undefined ? {} : { data: message.data }),
      ...(message.error === undefined ? {} : { error: message.error }),
      ...(message.errorInfo === undefined ? {} : { errorInfo: message.errorInfo }),
    });
  }

  private handlePeerClose(): void {
    if (this.closedByUs || this.socket === null) {
      // A transport we closed (or that already failed to come up) has been
      // disposed; its listeners were already told.
      return;
    }
    this.disposeSocket(this.lastSocketError);
  }

  private disposeSocket(closeError: Error | undefined): void {
    const socket = this.socket;
    this.socket = null;
    this.buffer = "";
    if (socket !== null && !socket.destroyed) {
      socket.destroy();
    }
    const inFlight = [...this.pending.values()];
    this.pending.clear();
    for (const pending of inFlight) {
      clearTimeout(pending.timer);
      pending.reject(
        closeError ??
          new DaemonConnectionClosedError(
            this.socketPath,
            `during "${pending.command}"`,
          ),
      );
    }
    this.failHelloWaiters(
      new DaemonConnectionClosedError(
        this.socketPath,
        closeError?.message ?? "socket closed",
      ),
    );
    const listeners = this.peerCloseListeners;
    this.peerCloseListeners = new Set();
    for (const listener of listeners) {
      listener(closeError);
    }
  }
}

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DynamicTool } from "@get-bb/plugin-sdk/provider-bridge";
import {
  BB_TOOLS_CHANNEL_FLAG,
  isJsonObject,
  type BbChannelTool,
} from "./protocol.js";
import {
  DynamicToolsChannel,
  defaultChannelSocketDir,
  type BbToolCallHandler,
  type ToolsAck,
} from "./channel-server.js";

/**
 * Per-session ownership of the dynamic-tools channel.
 *
 * The chat path (bbpa-ggf.3) holds one registry for the bridge process: it
 * starts a channel before each daemon `create` that carries dynamic tools,
 * spreads `sessionConfig()` into that create's `config`, publishes the bb tool
 * set once the thread is known, and stops the channel when the thread is
 * released. Nothing in here touches the session table or the daemon client —
 * the registry is only the channel's lifecycle, so the wiring stays a
 * two-call affair on top of it.
 */
export class DynamicToolsRegistry {
  private readonly channels = new Map<string, DynamicToolsChannel>();
  private readonly socketDir: string | undefined;
  private readonly extensionPath: string;

  constructor(args: { socketDir?: string; extensionPath?: string } = {}) {
    this.socketDir = args.socketDir;
    this.extensionPath = args.extensionPath ?? companionExtensionPath();
  }

  /** All channels started so far (provider thread id → channel). */
  get size(): number {
    return this.channels.size;
  }

  channel(providerThreadId: string): DynamicToolsChannel | undefined {
    return this.channels.get(providerThreadId);
  }

  /**
   * Start (or replace) the channel for a session. Call before the daemon
   * `create` command: the companion extension connects while the prime worker
   * boots, and a channel that listens late is a channel that never connects.
   */
  async start(args: {
    providerThreadId: string;
    onToolCall: BbToolCallHandler;
    socketPath?: string;
  }): Promise<DynamicToolsChannel> {
    await this.stop(args.providerThreadId);
    const channel = new DynamicToolsChannel({
      providerThreadId: args.providerThreadId,
      onToolCall: args.onToolCall,
      socketPath: args.socketPath,
      socketDir: this.socketDir,
    });
    await channel.listen();
    this.channels.set(args.providerThreadId, channel);
    return channel;
  }

  /** Publish a session's bb tool set; resolves with the extension's ack. */
  setTools(
    providerThreadId: string,
    tools: readonly DynamicTool[],
    args: { timeoutMs?: number } = {},
  ): Promise<ToolsAck> {
    const channel = this.channels.get(providerThreadId);
    if (channel === undefined) {
      return Promise.reject(
        new Error(`no dynamic-tools channel is running for ${providerThreadId}`),
      );
    }
    return channel.setTools(toChannelTools(tools), args);
  }

  /**
   * The `create.config` fragment that loads the companion extension and points
   * it at this session's channel. Undefined when the session has no channel —
   * a session without bb dynamic tools should not load the extension at all.
   */
  sessionConfig(providerThreadId: string): DynamicToolsSessionConfig | undefined {
    const channel = this.channels.get(providerThreadId);
    if (channel === undefined) {
      return undefined;
    }
    return {
      noExtensions: true,
      extensions: [this.extensionPath],
      extensionFlagValues: { [BB_TOOLS_CHANNEL_FLAG]: channel.path },
    };
  }

  /** The absolute path of the companion extension this registry loads. */
  get extensionModulePath(): string {
    return this.extensionPath;
  }

  /** Stop one session's channel (thread release / discard). */
  async stop(providerThreadId: string): Promise<void> {
    const channel = this.channels.get(providerThreadId);
    if (channel === undefined) {
      return;
    }
    this.channels.delete(providerThreadId);
    await channel.close();
  }

  /** Stop every channel (bridge process shutdown). */
  async clear(): Promise<void> {
    const ids = [...this.channels.keys()];
    for (const id of ids) {
      await this.stop(id);
    }
  }
}

/**
 * The config fragment `DynamicToolsRegistry.sessionConfig` produces — spread
 * into the daemon `create` command's `config`.
 */
export interface DynamicToolsSessionConfig {
  noExtensions: true;
  extensions: string[];
  extensionFlagValues: Record<string, string>;
}

/** bb's `DynamicTool` → the channel's tool shape (bb display metadata stays bb-side). */
export function toChannelTools(tools: readonly DynamicTool[]): BbChannelTool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    ...(isJsonObject(tool.inputSchema) ? { parameters: tool.inputSchema } : {}),
    ...(tool.presentation?.title === undefined ? {} : { label: tool.presentation.title }),
  }));
}

/**
 * The companion extension artifact prime loads. The plugin ships it as
 * TypeScript source next to the bridge (`extension/bb-tools-extension.ts`);
 * prime transpiles extensions at load, so no build step is involved and the
 * installed plugin directory is self-contained.
 */
export function companionExtensionPath(): string {
  const override = process.env.BB_TOOLS_EXTENSION_PATH;
  if (typeof override === "string" && override.trim() !== "") {
    return override;
  }
  const candidate = fileURLToPath(new URL("../../extension/bb-tools-extension.ts", import.meta.url));
  if (!existsSync(candidate)) {
    throw new Error(
      `the bb companion prime extension is missing at ${candidate}; reinstall the bb-plugin-prime-agent plugin`,
    );
  }
  return candidate;
}

/** The default channel directory, re-exported for callers minting paths. */
export const DEFAULT_CHANNEL_SOCKET_DIR = defaultChannelSocketDir;

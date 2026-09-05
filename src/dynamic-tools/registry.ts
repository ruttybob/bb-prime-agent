import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { DynamicTool } from "@get-bb/plugin-sdk/provider-bridge";
import { BB_TOOLS_EXTENSION_SOURCE } from "./embedded-extension-source.js";
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
  private readonly extensionPath: string | undefined;

  constructor(args: { socketDir?: string; extensionPath?: string } = {}) {
    this.socketDir = args.socketDir;
    // Resolved lazily: a plugin whose extension artifact is missing must still
    // load (sessions just run without bb tools) — the bridge module itself
    // imports this registry at module scope.
    this.extensionPath = args.extensionPath;
  }

  /** All channels started so far (provider thread id → channel). */
  get size(): number {
    return this.channels.size;
  }

  channel(providerThreadId: string): DynamicToolsChannel | undefined {
    return this.channels.get(providerThreadId);
  }

  private extensionModule(): string {
    return this.extensionPath ?? companionExtensionPath();
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
      extensions: [this.extensionModule()],
      extensionFlagValues: { [BB_TOOLS_CHANNEL_FLAG]: channel.path },
    };
  }

  /** The absolute path of the companion extension this registry loads. */
  get extensionModulePath(): string {
    return this.extensionModule();
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
 * prime transpiles extensions at load, so no build step is involved.
 *
 * Resolution order, by where this module runs:
 * - `BB_TOOLS_EXTENSION_PATH` override (tests, exotic setups);
 * - the sibling layouts — `src/dynamic-tools/` (tests, `bb plugin dev`) and
 *   the built `dist/` bundle of a path-install;
 * - the daemon's artifact cache: bb delivers the bb.host artifact as a single
 *   digest-verified file (`~/.bb/plugin-host-artifacts/<plugin>/<digest>/host.mjs`),
 *   which cannot carry a sibling, so the extension source travels embedded in
 *   the bundle and is materialized to a scratch file here (bbpa-9ah).
 */
export function companionExtensionPath(): string {
  const override = process.env.BB_TOOLS_EXTENSION_PATH;
  if (typeof override === "string" && override.trim() !== "") {
    return override;
  }
  const here = new URL(".", import.meta.url);
  const candidates = [
    fileURLToPath(new URL("../../extension/bb-tools-extension.ts", here)),
    fileURLToPath(new URL("../extension/bb-tools-extension.ts", here)),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return materializedExtensionPath();
}

/** Scratch directory for the materialized companion extension. */
const EMBEDDED_EXTENSION_SCRATCH_DIR = join(tmpdir(), "bb-plugin-prime-agent");

/**
 * Write the embedded extension source to a scratch file and return its path.
 *
 * The file is reused across sessions and rewritten when the embedded source
 * changes (a plugin update materializes its own content). The write lands via
 * a staged file and an atomic rename, so a concurrently booting session worker
 * never reads a half-written extension.
 */
export function materializedExtensionPath(
  scratchDir: string = EMBEDDED_EXTENSION_SCRATCH_DIR,
): string {
  const target = join(scratchDir, "bb-tools-extension.ts");
  try {
    if (existsSync(target) && readFileSync(target, "utf8") === BB_TOOLS_EXTENSION_SOURCE) {
      return target;
    }
  } catch {
    // Unreadable or half-written from an older layout: fall through and rewrite.
  }
  mkdirSync(scratchDir, { recursive: true });
  const staged = join(scratchDir, `.staging-${process.pid}-${randomUUID()}.ts`);
  writeFileSync(staged, BB_TOOLS_EXTENSION_SOURCE);
  renameSync(staged, target);
  return target;
}

/** The default channel directory, re-exported for callers minting paths. */
export const DEFAULT_CHANNEL_SOCKET_DIR = defaultChannelSocketDir;

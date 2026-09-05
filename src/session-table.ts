import type { DynamicTool } from "@get-bb/plugin-sdk/provider-bridge";
import type { PrimeSession } from "./prime-session.js";

/**
 * Session bookkeeping for bb threads on prime-agent.
 *
 * Since bbpa-ggf.3 a record stands for a *daemon-resident* session:
 * `activeSessionId` is the daemon's handle (the provider thread id is derived
 * from it, so it is stable across bridge processes), `sessionFile` is the
 * durable artifact bb's thread points at, and `session` is the live lane that
 * streams prime's events into the thread. The table stays process-local by
 * design — a bridge process rediscovers its sessions on `thread/resume`
 * (bbpa-ggf.4 owns the cross-process file-based discovery).
 */
export interface SessionRecord {
  threadId: string;
  /** `prime_<activeSessionId>`: daemon-derived, so it survives a restart. */
  providerThreadId: string;
  cwd: string;
  createdAt: number;
  /** bb-injected dynamic tools, forwarded to the companion extension later. */
  dynamicTools: readonly DynamicTool[];
  turns: number;
  /** The daemon's handle for the resident session, set by `create`. */
  activeSessionId?: string;
  /** The session file prime wrote; survives daemon restarts and evictions. */
  sessionFile?: string;
  /** The session name prime shows in its own catalog (the "[bb] " prefix). */
  sessionName?: string;
  /** The live lane; present once the daemon session exists. */
  session?: PrimeSession;
  /** Messages from the latest attach snapshot (the adopted-session timeline source). */
  snapshotMessages?: readonly unknown[];
}

/** Skill roots handed over by `skills/configure`, kept for session creation. */
export interface ConfiguredSkillRoot {
  id: string;
  path: string;
  skills: readonly { name: string; description: string }[];
}

export class SessionTable {
  private readonly byThreadId = new Map<string, SessionRecord>();
  private readonly byProviderThreadId = new Map<string, SessionRecord>();

  register(record: SessionRecord): SessionRecord {
    this.byThreadId.set(record.threadId, record);
    this.byProviderThreadId.set(record.providerThreadId, record);
    return record;
  }

  /**
   * Adopt the daemon-derived provider thread id (`prime_<activeSessionId>`)
   * once `create` answered: the provisional id is un-indexed so lookups by
   * either name keep finding this record.
   */
  adoptProviderThreadId(record: SessionRecord, providerThreadId: string): void {
    const existing = this.byProviderThreadId.get(record.providerThreadId);
    if (existing === record) {
      this.byProviderThreadId.delete(record.providerThreadId);
    }
    record.providerThreadId = providerThreadId;
    this.byProviderThreadId.set(providerThreadId, record);
  }

  byThread(threadId: string): SessionRecord | undefined {
    return this.byThreadId.get(threadId);
  }

  byProviderThread(providerThreadId: string): SessionRecord | undefined {
    return this.byProviderThreadId.get(providerThreadId);
  }

  drop(threadId: string): SessionRecord | undefined {
    const record = this.byThreadId.get(threadId);
    if (record === undefined) {
      return undefined;
    }
    this.byThreadId.delete(threadId);
    const byProvider = this.byProviderThreadId.get(record.providerThreadId);
    if (byProvider === record) {
      this.byProviderThreadId.delete(record.providerThreadId);
    }
    return record;
  }

  clear(): void {
    this.byThreadId.clear();
    this.byProviderThreadId.clear();
  }

  /** Every live record (shutdown, tests). */
  all(): SessionRecord[] {
    return [...this.byThreadId.values()];
  }
}

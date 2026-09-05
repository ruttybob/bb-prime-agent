import type { DynamicTool } from "@get-bb/plugin-sdk/provider-bridge";

/**
 * Skeleton session bookkeeping.
 *
 * bbpa-ggf.2 owns the protocol surface, not the prime sessions: every bb
 * thread gets an in-process record with a synthetic provider thread id, and
 * nothing on the daemon side is created, attached, or destroyed. bbpa-ggf.3
 * replaces this table with daemon resident sessions (`create` +
 * `lifecycle: "resident"`, attach with snapshot); the record below is the
 * shape that swap consumes, so the protocol lifecycle around it — identity
 * notification, `session.reset`, turn settling, stop/discard — is already
 * exercised end to end in-process by the conformance suite.
 */
export interface SessionRecord {
  threadId: string;
  providerThreadId: string;
  cwd: string;
  createdAt: number;
  /** bb-injected dynamic tools, forwarded to the companion extension later. */
  dynamicTools: readonly DynamicTool[];
  turns: number;
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
}

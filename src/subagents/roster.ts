import type { DaemonCommandResult } from "../daemon/client.js";
import type { DaemonPushMessage } from "../daemon/protocol.js";
import {
  parsePrimeChild,
  parsePrimeChildren,
  type PrimeChild,
} from "./children.js";

/**
 * The backend's roster of one daemon session's subagents.
 *
 * The daemon only pushes session events to *attached* clients, and this
 * backend is a second client on the session (the bridge lane is the first —
 * multi-client attach is by design). So a session enters this roster by
 * `attach`: the snapshot's `children` seed it, and `rlm_child_update` pushes
 * keep it current. Attaching once per session per backend process — not once
 * per panel open — is what keeps this a roster rather than a poll, and the
 * read-only attach (no prompt, no cancel; bbpa-ggf.10 owns control) has no
 * effect on the resident session.
 *
 * Interest is time-limited: a session nobody has asked about for
 * `interestTtlMs` is detached and dropped by `sweepIdle`, so panels that came
 * and went do not accumulate attached sessions. The daemon's own idle rules
 * are untouched — passivation targets idle subagent children only, and worker
 * eviction keys on the creating (owner) client, never on this one.
 */

/** The backend hands the roster its wire; tests hand it a script. */
export interface SubagentsRosterSeams {
  request(
    command: { type: string } & Record<string, unknown>,
    args?: { timeoutMs?: number },
  ): Promise<DaemonCommandResult>;
  subscribePush(listener: (message: DaemonPushMessage) => void): () => void;
  /** The connection came back: watched sessions need a fresh attach. */
  onReconnect?(listener: () => void): () => void;
}

export interface RosterChange {
  activeSessionId: string;
  children: readonly PrimeChild[];
}

/** Attach slim: the roster reads `snapshot.children`, never the transcript twice. */
const ROSTER_ATTACH_CAPABILITIES = [
  "attach_snapshot",
  "event_sequence",
  "slim_attach",
];

/** How long a session nobody asks about stays attached. */
const DEFAULT_INTEREST_TTL_MS = 10 * 60_000;
/** How often idle sessions are swept. */
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

interface RosterEntry {
  activeSessionId: string;
  attached: boolean;
  children: Map<string, PrimeChild>;
  lastInterestAt: number;
}

function detachCommand(activeSessionId: string) {
  return { type: "detach", activeSessionId };
}

export class SubagentsRoster {
  private readonly entries = new Map<string, RosterEntry>();
  private readonly changeListeners = new Set<(change: RosterChange) => void>();
  private readonly unsubscribe: () => void;
  private readonly reconnectUnsubscribe: (() => void) | undefined;
  private readonly interestTtlMs: number;
  private readonly sweepIntervalMs: number;
  private sweepTimer: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(
    private readonly seams: SubagentsRosterSeams,
    args: { interestTtlMs?: number; sweepIntervalMs?: number } = {},
  ) {
    this.interestTtlMs = args.interestTtlMs ?? DEFAULT_INTEREST_TTL_MS;
    this.sweepIntervalMs = args.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.unsubscribe = seams.subscribePush((message) => this.handlePush(message));
    this.reconnectUnsubscribe = seams.onReconnect?.(() => {
      void this.reattachAll();
    });
  }

  /** Roster changes (seed, update, drop), for whatever republishes them. */
  onChange(listener: (change: RosterChange) => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  /** Sessions currently watched (health, tests). */
  watched(): readonly string[] {
    return [...this.entries.keys()];
  }

  /** Last known children of a session; empty when it was never watched. */
  childrenOf(activeSessionId: string): PrimeChild[] {
    return [...(this.entries.get(activeSessionId)?.children.values() ?? [])];
  }

  /**
   * Make sure a session is watched, refreshing its interest stamp, and answer
   * with the roster as the daemon last reported it. The first watch attaches;
   * the attach answer's `children` are the seed, so a panel opened on a
   * reopened thread shows the resident roster without waiting for a push.
   */
  async watch(activeSessionId: string): Promise<PrimeChild[]> {
    this.assertAlive();
    const existing = this.entries.get(activeSessionId);
    if (existing?.attached === true) {
      existing.lastInterestAt = Date.now();
      this.startSweepTimer();
      return this.childrenOf(activeSessionId);
    }
    // Reuse an existing (detached) entry: a re-attach from a reconnect or a
    // session replacement may be in flight, and two entry objects for one
    // session would split its roster.
    const entry: RosterEntry = existing ?? {
      activeSessionId,
      attached: false,
      children: new Map(),
      lastInterestAt: Date.now(),
    };
    this.entries.set(activeSessionId, entry);
    entry.lastInterestAt = Date.now();
    await this.attach(entry);
    this.startSweepTimer();
    return this.childrenOf(activeSessionId);
  }

  /**
   * Stop watching a session (detached best-effort — a daemon that already went
   * away has nothing left to detach).
   */
  async release(activeSessionId: string): Promise<void> {
    const entry = this.entries.get(activeSessionId);
    if (entry === undefined) {
      return;
    }
    this.entries.delete(activeSessionId);
    this.stopSweepTimerWhenIdle();
    if (entry.attached) {
      entry.attached = false;
      await this.detachQuietly(activeSessionId);
    }
    this.notify(activeSessionId);
  }

  /** Detach every session and stop listening (host worker dispose, tests). */
  async dispose(): Promise<void> {
    this.disposed = true;
    const ids = [...this.entries.keys()];
    this.entries.clear();
    this.stopSweepTimerWhenIdle();
    this.unsubscribe();
    this.reconnectUnsubscribe?.();
    this.changeListeners.clear();
    for (const id of ids) {
      await this.detachQuietly(id);
    }
  }

  /**
   * Detach sessions whose last interest is older than the TTL. Returns the
   * session ids dropped — tests assert on them, the timer ignores the answer.
   */
  async sweepIdle(now: number = Date.now()): Promise<string[]> {
    const stale = [...this.entries.values()]
      .filter((entry) => now - entry.lastInterestAt >= this.interestTtlMs)
      .map((entry) => entry.activeSessionId);
    for (const id of stale) {
      await this.release(id);
    }
    return stale;
  }

  private assertAlive(): void {
    if (this.disposed) {
      throw new Error("the subagents roster was disposed");
    }
  }

  private async attach(entry: RosterEntry): Promise<void> {
    const answer = await this.seams.request({
      type: "attach",
      activeSessionId: entry.activeSessionId,
      capabilities: ROSTER_ATTACH_CAPABILITIES,
    });
    if (!answer.success) {
      // An unknown session id (the daemon restarted and lost it, say) is a
      // legible failure, not an empty roster: the caller may have another
      // machine to ask.
      throw new Error(
        `prime-agent refused to attach for the subagents roster of ${entry.activeSessionId}: ${
          answer.error ?? "unknown daemon error"
        }`,
      );
    }
    entry.attached = true;
    entry.children = new Map(
      parsePrimeChildren(
        (answer.data as { snapshot?: { children?: unknown } } | undefined)
          ?.snapshot?.children,
      ).map((child) => [child.id, child]),
    );
    this.notify(entry.activeSessionId);
  }

  /** A reconnect wipes the daemon's attach state: watch everything again. */
  private async reattachAll(): Promise<void> {
    for (const entry of this.entries.values()) {
      entry.attached = false;
    }
    for (const entry of [...this.entries.values()]) {
      try {
        await this.attach(entry);
      } catch {
        // The session may be gone after a daemon restart; it drops out of the
        // roster rather than failing every later panel open.
        this.entries.delete(entry.activeSessionId);
        this.stopSweepTimerWhenIdle();
      }
    }
  }

  private handlePush(message: DaemonPushMessage): void {
    if (this.disposed) {
      return;
    }
    const activeSessionId = (
      message as { activeSessionId?: unknown }
    ).activeSessionId;
    if (typeof activeSessionId !== "string") {
      return;
    }
    const entry = this.entries.get(activeSessionId);
    if (entry === undefined) {
      return;
    }
    if (message.type === "session_closed") {
      // The daemon closed the session; there is no roster to hold.
      this.entries.delete(activeSessionId);
      this.stopSweepTimerWhenIdle();
      this.notify(activeSessionId);
      return;
    }
    if (message.type === "session_resynced" || message.type === "session_replaced") {
      // Prime replaced the worker under us: re-attach for a fresh roster.
      entry.attached = false;
      void this.attach(entry).catch(() => {
        this.entries.delete(activeSessionId);
        this.stopSweepTimerWhenIdle();
      });
      return;
    }
    if (message.type !== "session_event") {
      return;
    }
    const event = (message as { event?: unknown }).event;
    const child = parsePrimeChild(
      (event as { child?: unknown } | undefined)?.child,
    );
    if (child === undefined || (event as { type?: unknown }).type !== "rlm_child_update") {
      return;
    }
    entry.children.set(child.id, child);
    this.notify(activeSessionId);
  }

  private notify(activeSessionId: string): void {
    const change: RosterChange = {
      activeSessionId,
      children: this.childrenOf(activeSessionId),
    };
    for (const listener of this.changeListeners) {
      listener(change);
    }
  }

  private startSweepTimer(): void {
    if (
      this.disposed ||
      this.sweepIntervalMs <= 0 ||
      this.sweepTimer !== undefined ||
      this.entries.size === 0
    ) {
      return;
    }
    this.sweepTimer = setInterval(() => {
      void this.sweepIdle();
    }, this.sweepIntervalMs);
    // Never a reason for the worker to stay alive on its own.
    this.sweepTimer.unref?.();
  }

  private stopSweepTimerWhenIdle(): void {
    if (this.entries.size === 0 && this.sweepTimer !== undefined) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }

  private detachQuietly(activeSessionId: string): Promise<void> {
    return this.seams.request(detachCommand(activeSessionId)).then(
      () => undefined,
      () => undefined,
    );
  }
}

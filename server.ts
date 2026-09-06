import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { primeProviderDeclaration } from "./src/declaration.js";
import {
  primeSubagentsHostContract,
  primeSubagentsHostSignals,
  primeSubagentsRpcContract,
  type SubagentsRosterResult,
  type SubagentsTranscriptHostResult,
} from "./src/subagents/contract.js";
import {
  primeHeartbeatsHostContract,
  primeHeartbeatsHostSignals,
  primeHeartbeatsRpcContract,
  type HeartbeatsListHostResult,
} from "./src/heartbeats/contract.js";
import {
  discoverUserPrimeExtensions,
  userExtensionSettingsDescriptors,
} from "./src/user-extensions.js";
import {
  childThreadMarkerInput,
  createChildThreadService,
} from "./src/child-threads.js";
import { errorMessage } from "./src/error-message.js";
import {
  HEARTBEATS_REALTIME_CHANNEL,
  PRIME_PROVIDER_ID,
  PRIME_PROVIDER_THREAD_PREFIX,
  SUBAGENTS_REALTIME_CHANNEL,
  primeProviderThreadId,
} from "./src/vocabulary.js";

/**
 * bb.server entry: what the plugin contributes to bb's own surfaces.
 *
 * The extension picker (bbpa-ggf.12) lives here too: the user-level extension
 * scan is a snapshot taken once per plugin load (the descriptors are plain data
 * the host renders without running plugin code — see `src/user-extensions.ts`
 * for why that is the right place), and the same snapshot feeds both the
 * settings toggles and the declaration's `deriveProviderOptions`, so the page
 * the user sees and the paths a new session loads can never disagree.
 *
 * The Subagents panel's server half (bbpa-ggf.9) is here as well: it answers
 * the panel's roster question by resolving the bb thread's prime session and
 * asking the connected hosts (the machine the daemon lives on), then
 * republishes host roster changes onto one realtime channel for the windows.
 * The server holds no daemon state of its own — the per-machine client is the
 * `bb.host` entry's, which is what keeps the panel's data on the machine the
 * daemon actually runs on.
 */
export default function plugin(bb: BbPluginApi): void {
  const userExtensions = discoverUserPrimeExtensions();
  bb.settings.define(userExtensionSettingsDescriptors(userExtensions));
  const registered = bb.providers.register(
    primeProviderDeclaration({ userExtensions }),
  );
  const stopSubagents = registerSubagents(bb);
  const stopHeartbeats = registerHeartbeats(bb);
  const stopChildThreads = registerChildThreads(bb);
  bb.onDispose(() => {
    registered.dispose();
    stopSubagents();
    stopHeartbeats();
    stopChildThreads();
  });
}

/**
 * bb thread id → the prime session its identity named (small, sticky). Shared
 * by every panel's server half: the bridge announces `thread/identity` at
 * every session construction, so the latest row names the resident session —
 * including after a resume.
 */
function createSessionResolver(bb: BbPluginApi) {
  const sessionByThread = new Map<string, string>();
  /** The reverse edge (prime session -> bb thread), for the child threads. */
  const threadBySession = new Map<string, string>();

  /** The providerThreadId a thread's latest thread/identity event names. */
  async function latestIdentity(threadId: string): Promise<string | undefined> {
    const rows = await bb.sdk.threads.events.list({
      threadId,
      types: ["thread/identity"],
      order: "desc",
      limit: "1",
    });
    const providerThreadId = (
      rows[0]?.data as { providerThreadId?: unknown } | undefined
    )?.providerThreadId;
    return typeof providerThreadId === "string" ? providerThreadId : undefined;
  }

  async function resolveActiveSessionId(
    threadId: string,
  ): Promise<string | undefined> {
    const cached = sessionByThread.get(threadId);
    if (cached !== undefined) {
      return cached;
    }
    const providerThreadId = await latestIdentity(threadId);
    if (
      providerThreadId === undefined ||
      !providerThreadId.startsWith(PRIME_PROVIDER_THREAD_PREFIX)
    ) {
      return undefined;
    }
    const activeSessionId = providerThreadId.slice(
      PRIME_PROVIDER_THREAD_PREFIX.length,
    );
    if (activeSessionId.length === 0) {
      return undefined;
    }
    sessionByThread.set(threadId, activeSessionId);
    threadBySession.set(activeSessionId, threadId);
    return activeSessionId;
  }

  /**
   * The bb thread a prime session backs, resolved on demand: recent
   * prime-agent threads are scanned for the identity that named the session,
   * then cached. Only the child-threads service needs this direction, and a
   * spawn is a rare event, so the per-thread identity lookup is fine.
   */
  async function resolveThreadBySession(
    sessionId: string,
  ): Promise<string | undefined> {
    const cached = threadBySession.get(sessionId);
    if (cached !== undefined) {
      return cached;
    }
    const threads = await bb.sdk.threads.list({ limit: 100 });
    for (const thread of threads) {
      if (thread.providerId !== PRIME_PROVIDER_ID) {
        continue;
      }
      const providerThreadId = await latestIdentity(thread.id);
      if (providerThreadId === primeProviderThreadId(sessionId)) {
        threadBySession.set(sessionId, thread.id);
        return thread.id;
      }
    }
    return undefined;
  }

  return { resolveActiveSessionId, resolveThreadBySession };
}

/**
 * The "ask every connected host in turn" fan-out both panels share: a read
 * whose no host can answer is a state (`undefined` — the panel renders it),
 * while callers decide which of their actions must instead refuse. A host
 * listing that fails says so in the log and answers nothing.
 */
function createHostFanOut(bb: BbPluginApi, panel: string) {
  async function firstHostAnswer<Answer>(
    activeSessionId: string,
    what: string,
    ask: (hostId: string) => Promise<Answer>,
  ): Promise<Answer | undefined> {
    let hosts: Awaited<ReturnType<typeof bb.sdk.hosts.list>>;
    try {
      hosts = await bb.sdk.hosts.list();
    } catch (error) {
      bb.log.warn(`${panel}: could not list hosts (${errorMessage(error)})`);
      return undefined;
    }
    for (const host of hosts) {
      if (host.status !== "connected") {
        continue;
      }
      try {
        return await ask(host.id);
      } catch (error) {
        bb.log.debug(
          `${panel}: host ${host.id} could not ${what} ${activeSessionId} (${errorMessage(error)})`,
        );
      }
    }
    return undefined;
  }

  function noHostHolds(activeSessionId: string): Error {
    return new Error(
      `No connected machine has prime-agent session ${activeSessionId}. Is prime-agent running on the machine this thread runs on?`,
    );
  }

  return { firstHostAnswer, noHostHolds };
}

/**
 * The Subagents panel's server half: thread id → prime session → roster, plus
 * the host-signal → realtime hop that makes transitions live. The control
 * actions (bbpa-ggf.10) take the same road — the panel's steer and stop are
 * relayed to the connected hosts, and one daemon (the one holding the session)
 * acts — with one difference: a control action that no host can perform is an
 * rpc error, never a quiet success.
 */
function registerSubagents(bb: BbPluginApi): () => void {
  const hostClient = bb.hosts.experimental_client({
    contract: primeSubagentsHostContract,
    experimental_signals: primeSubagentsHostSignals,
  });
  const { resolveActiveSessionId } = createSessionResolver(bb);
  const { firstHostAnswer, noHostHolds } = createHostFanOut(bb, "Subagents panel");

  /** The thread's session, or a refusal the panel can show as-is. */
  async function requireActiveSessionId(
    threadId: string,
    activeSessionId: string | undefined,
  ): Promise<string> {
    const resolved = activeSessionId ?? (await resolveActiveSessionId(threadId));
    if (resolved === undefined) {
      throw new Error(
        "This thread has no prime-agent session yet. Start it on prime-agent and its subagents become steerable.",
      );
    }
    return resolved;
  }

  bb.rpc.register(primeSubagentsRpcContract, {
    async roster(input): Promise<SubagentsRosterResult> {
      const activeSessionId =
        input.activeSessionId ?? (await resolveActiveSessionId(input.threadId));
      if (activeSessionId === undefined) {
        return { state: "unknown_thread", activeSessionId: null, children: [] };
      }
      const children = await firstHostAnswer(
        activeSessionId,
        "read a roster for",
        (hostId) =>
          hostClient.call(
            "subagents.roster",
            { activeSessionId },
            { hostId },
          ).then((answer) => answer.children),
      );
      if (children === undefined) {
        return { state: "unavailable", activeSessionId, children: [] };
      }
      return { state: "ready", activeSessionId, children };
    },

    async steer(input) {
      const activeSessionId = await requireActiveSessionId(
        input.threadId,
        input.activeSessionId,
      );
      const answer = await firstHostAnswer(
        activeSessionId,
        "steer a subagent in",
        (hostId) =>
          hostClient.call(
            "subagents.steer",
            {
              activeSessionId,
              childId: input.childId,
              message: input.message,
            },
            { hostId },
          ),
      );
      if (answer === undefined) {
        throw noHostHolds(activeSessionId);
      }
      return { activeSessionId, delivery: answer.delivery };
    },

    async stop(input) {
      const activeSessionId = await requireActiveSessionId(
        input.threadId,
        input.activeSessionId,
      );
      const answer = await firstHostAnswer(
        activeSessionId,
        "stop a subagent in",
        (hostId) =>
          hostClient.call(
            "subagents.stop",
            { activeSessionId, childId: input.childId },
            { hostId },
          ),
      );
      if (answer === undefined) {
        throw noHostHolds(activeSessionId);
      }
      return { activeSessionId, cancelled: answer.cancelled };
    },

    /**
     * The transcript read (bbpa-b1m.8) is a question, not an action: an
     * unreachable daemon answers `unavailable` (the panel shows it), and a
     * host whose daemon lost the session answers the same way a session that
     * never existed would — the panel cannot tell the difference and does not
     * need to. `no_session` passes straight through: the child has not booted.
     */
    async transcript(
      input,
    ): Promise<{
      state: "ready" | "unknown_thread" | "unavailable" | "no_session";
      activeSessionId: string | null;
      entries: SubagentsTranscriptHostResult["entries"];
      truncated: boolean;
    }> {
      const activeSessionId =
        input.activeSessionId ?? (await resolveActiveSessionId(input.threadId));
      if (activeSessionId === undefined) {
        return { state: "unknown_thread", activeSessionId: null, entries: [], truncated: false };
      }
      const answer = await firstHostAnswer<SubagentsTranscriptHostResult>(
        activeSessionId,
        "read a transcript in",
        (hostId) =>
          hostClient.call(
            "subagents.transcript",
            { activeSessionId, childId: input.childId },
            { hostId },
          ),
      );
      if (answer === undefined) {
        return { state: "unavailable", activeSessionId, entries: [], truncated: false };
      }
      return { ...answer, activeSessionId };
    },
  });

  // Host workers push roster changes; windows hear them on one channel and
  // each panel refetches its own thread's roster (read-only, so a refresh is
  // always safe and never lost).
  const unsubscribe = hostClient.experimental_onSignal(
    "subagents.changed",
    (event) => {
      bb.realtime.publish(SUBAGENTS_REALTIME_CHANNEL, event.payload);
    },
  );
  return unsubscribe;
}

/**
 * The Heartbeats panel's server half (bbpa-b1m.3, schedules bbpa-b1m.4): the
 * same road the Subagents panel paved — thread id in, the resolved prime
 * session fanned out to the connected hosts, host pushes republished on one
 * realtime channel. Reads answer a state the panel renders; actions throw
 * when no host can perform them. prime's `heartbeats_changed` push is global
 * (no session id — wire fact), so the republished payload is a bare
 * timestamp and every open panel refetches its own session.
 */
function registerHeartbeats(bb: BbPluginApi): () => void {
  const hostClient = bb.hosts.experimental_client({
    contract: primeHeartbeatsHostContract,
    experimental_signals: primeHeartbeatsHostSignals,
  });
  const { resolveActiveSessionId } = createSessionResolver(bb);
  const { firstHostAnswer, noHostHolds } = createHostFanOut(bb, "Heartbeats panel");

  async function requireActiveSessionId(
    threadId: string,
    activeSessionId: string | undefined,
  ): Promise<string> {
    const resolved = activeSessionId ?? (await resolveActiveSessionId(threadId));
    if (resolved === undefined) {
      throw new Error(
        "This thread has no prime-agent session yet. Start it on prime-agent to manage its heartbeats.",
      );
    }
    return resolved;
  }

  bb.rpc.register(primeHeartbeatsRpcContract, {
    async list(input) {
      const activeSessionId =
        input.activeSessionId ?? (await resolveActiveSessionId(input.threadId));
      if (activeSessionId === undefined) {
        return {
          state: "unknown_thread" as const,
          activeSessionId: null,
          heartbeats: [],
          schedules: [],
        };
      }
      const answer = await firstHostAnswer<HeartbeatsListHostResult>(
        activeSessionId,
        "read heartbeats for",
        (hostId) =>
          hostClient.call("heartbeats.list", { activeSessionId }, { hostId }),
      );
      if (answer === undefined) {
        return {
          state: "unavailable" as const,
          activeSessionId,
          heartbeats: [],
          schedules: [],
        };
      }
      return {
        state: "ready" as const,
        activeSessionId,
        heartbeats: answer.heartbeats,
        schedules: answer.schedules,
      };
    },

    async set(input) {
      const activeSessionId = await requireActiveSessionId(
        input.threadId,
        input.activeSessionId,
      );
      const answer = await firstHostAnswer(
        activeSessionId,
        "set a heartbeat in",
        (hostId) =>
          hostClient.call(
            "heartbeats.set",
            {
              activeSessionId,
              schedule: input.schedule,
              prompt: input.prompt,
              ...(input.deliveryMode === undefined
                ? {}
                : { deliveryMode: input.deliveryMode }),
            },
            { hostId },
          ),
      );
      if (answer === undefined) {
        throw noHostHolds(activeSessionId);
      }
      return { activeSessionId, heartbeat: answer.heartbeat };
    },

    async manage(input) {
      const activeSessionId = await requireActiveSessionId(
        input.threadId,
        input.activeSessionId,
      );
      const answer = await firstHostAnswer(
        activeSessionId,
        `${input.action} a heartbeat in`,
        (hostId) =>
          hostClient.call(
            "heartbeats.manage",
            {
              activeSessionId,
              jobId: input.jobId,
              action: input.action,
            },
            { hostId },
          ),
      );
      if (answer === undefined) {
        throw noHostHolds(activeSessionId);
      }
      return { activeSessionId };
    },

    async scheduleAdd(input) {
      const activeSessionId = await requireActiveSessionId(
        input.threadId,
        input.activeSessionId,
      );
      const answer = await firstHostAnswer(
        activeSessionId,
        "add a schedule in",
        (hostId) =>
          hostClient.call(
            "heartbeats.scheduleAdd",
            {
              activeSessionId,
              schedule: input.schedule,
              prompt: input.prompt,
            },
            { hostId },
          ),
      );
      if (answer === undefined) {
        throw noHostHolds(activeSessionId);
      }
      return { activeSessionId };
    },

    async scheduleCancel(input) {
      const activeSessionId = await requireActiveSessionId(
        input.threadId,
        input.activeSessionId,
      );
      const answer = await firstHostAnswer(
        activeSessionId,
        "cancel a schedule in",
        (hostId) =>
          hostClient.call(
            "heartbeats.scheduleCancel",
            { activeSessionId, jobId: input.jobId },
            { hostId },
          ),
      );
      if (answer === undefined) {
        throw noHostHolds(activeSessionId);
      }
      return { activeSessionId };
    },
  });

  return hostClient.experimental_onSignal("heartbeats.changed", (event) => {
    bb.realtime.publish(HEARTBEATS_REALTIME_CHANNEL, event.payload);
  });
}


/**
 * Child subagent sessions as bb threads (bbpa-b1m.11, ADR-0005): the
 * `subagents.changed` signal names a parent session and its live children;
 * each child with its own daemon session gets one bb thread, spawned into
 * the parent's project and environment with the parent thread as its parent.
 * The spawn's marker input is consumed by the bridge (see
 * `startChildThread`), which binds the thread to the child's session.
 */
function registerChildThreads(bb: BbPluginApi): () => void {
  const { resolveActiveSessionId, resolveThreadBySession } =
    createSessionResolver(bb);
  const { firstHostAnswer } = createHostFanOut(bb, "Child threads");
  const hostClient = bb.hosts.experimental_client({
    contract: primeSubagentsHostContract,
    experimental_signals: primeSubagentsHostSignals,
  });

  const service = createChildThreadService({
    log: {
      info: (message) => bb.log.info(message),
      warn: (message) => bb.log.warn(message),
    },
    resolveParentThreadId: resolveThreadBySession,
    resolveThreadSession: resolveActiveSessionId,
    getParentThread: async (threadId) => {
      const thread = await bb.sdk.threads.get({ threadId });
      return thread === null
        ? undefined
        : { projectId: thread.projectId, environmentId: thread.environmentId };
    },
    findExistingChildThread: async (parentThreadId, title) => {
      // Bound the scan: a parent with more live children than this is
      // beyond any real grilling fleet, and the dedupe is a restart-only
      // safety net (the in-process claim covers the steady state).
      const children = await bb.sdk.threads.list({
        parentThreadId,
        limit: 100,
      });
      return children.some((thread) => thread.title === title);
    },
    spawnChildThread: async (args) => {
      await bb.sdk.threads.spawn({
        projectId: args.projectId,
        providerId: PRIME_PROVIDER_ID,
        title: args.title,
        parentThreadId: args.parentThreadId,
        environment:
          args.environmentId === null
            ? { type: "project-default" }
            : { type: "reuse", environmentId: args.environmentId },
        input: [childThreadMarkerInput(args.childSessionId)],
      });
    },
    watchSession: async (sessionId) => {
      // Ask every connected host; the one holding the session keeps its
      // roster live. A host without the session refuses — skipped, not fatal.
      await firstHostAnswer(sessionId, "watch", (hostId) =>
        hostClient.call(
          "subagents.watch",
          { activeSessionId: sessionId },
          { hostId },
        ),
      );
    },
    listRecentPrimeThreadIds: async () => {
      const threads = await bb.sdk.threads.list({ limit: 25, archived: false });
      return threads
        .filter((thread) => thread.providerId === PRIME_PROVIDER_ID)
        .map((thread) => thread.id);
    },
  });

  const unsubscribe = hostClient.experimental_onSignal(
    "subagents.changed",
    (event) => {
      // Fire and forget: a spawn failure is logged inside the service; the
      // signal stream must never see a slow consumer.
      void service
        .onChildren(event.payload.activeSessionId, event.payload.children)
        .catch(() => {});
    },
  );

  // Spawns are only seen for watched sessions; a slow sweep keeps the
  // parents of recent threads watched so a child surfaces with no panel
  // open. The first sweep runs immediately — registration happens before
  // the server listens, and the sdk is already bound.
  const sweep = setInterval(() => {
    void service.watchRecentThreads().catch(() => {});
  }, 60_000);
  void service.watchRecentThreads().catch(() => {});

  return () => {
    clearInterval(sweep);
    unsubscribe();
  };
}

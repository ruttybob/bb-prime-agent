import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { primeProviderDeclaration } from "./src/declaration.js";
import {
  primeSubagentsHostContract,
  primeSubagentsHostSignals,
  primeSubagentsRpcContract,
  type SubagentsRosterResult,
} from "./src/subagents/contract.js";
import {
  discoverUserPrimeExtensions,
  userExtensionSettingsDescriptors,
} from "./src/user-extensions.js";
import {
  PRIME_PROVIDER_THREAD_PREFIX,
  SUBAGENTS_REALTIME_CHANNEL,
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
  bb.onDispose(() => {
    registered.dispose();
    stopSubagents();
  });
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

  /** bb thread id → the prime session its identity named (small, sticky). */
  const sessionByThread = new Map<string, string>();

  async function resolveActiveSessionId(
    threadId: string,
  ): Promise<string | undefined> {
    const cached = sessionByThread.get(threadId);
    if (cached !== undefined) {
      return cached;
    }
    // The bridge announces `thread/identity` at every session construction, so
    // the latest row names the resident session — including after a resume.
    const rows = await bb.sdk.threads.events.list({
      threadId,
      types: ["thread/identity"],
      order: "desc",
      limit: "1",
    });
    const providerThreadId = (
      rows[0]?.data as { providerThreadId?: unknown } | undefined
    )?.providerThreadId;
    if (
      typeof providerThreadId !== "string" ||
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
    return activeSessionId;
  }

  /**
   * Ask every connected host in turn; the first one whose daemon holds the
   * session answers. A host without the session refuses (there is nothing to
   * attach to, nothing to steer), which is why only a universal refusal is an
   * answer — and why a control action lands on exactly one daemon.
   */
  async function firstHostAnswer<Answer>(
    activeSessionId: string,
    what: string,
    ask: (hostId: string) => Promise<Answer>,
  ): Promise<Answer | undefined> {
    let hosts: Awaited<ReturnType<typeof bb.sdk.hosts.list>>;
    try {
      hosts = await bb.sdk.hosts.list();
    } catch (error) {
      bb.log.warn(
        `Subagents panel: could not list hosts (${errorMessage(error)})`,
      );
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
          `Subagents panel: host ${host.id} could not ${what} ${activeSessionId} (${errorMessage(error)})`,
        );
      }
    }
    return undefined;
  }

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

  function noHostHolds(activeSessionId: string): Error {
    return new Error(
      `No connected machine has prime-agent session ${activeSessionId}. Is prime-agent running on the machine this thread runs on?`,
    );
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

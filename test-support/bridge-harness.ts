import { afterEach, beforeEach } from "vitest";
import {
  experimental_captureBridgeJsonRpcOutput as captureBridgeJsonRpcOutput,
  type CapturedBridgeJsonRpcOutput,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import {
  handleLine,
  resetDaemonForTests,
  sessionTableForTests,
} from "../src/provider-bridge.js";
import { setPrimeDaemonTransportFactoryForTests } from "../src/daemon/connection.js";
import {
  createScriptedDaemon,
  type ScriptedDaemonHandle,
  type ScriptedSession,
} from "./scripted-daemon.js";

/**
 * The one harness every scripted bridge test drives (formerly re-declared per
 * file): a capture of the bridge's stdout, one scripted prime daemon at the
 * transport seam, and the read/poll helpers over both. Call `startBridgeHarness`
 * once per test file at module scope — it registers the file's beforeEach/
 * afterEach — and take the returned handle everywhere. Per-test differences
 * stay in the file: extra teardown (`afterEachExtra`), a scripted setup
 * (`beforeEachExtra`), and local helpers over these pieces.
 *
 * The daemon and the capture exist per test, so the handle exposes them as
 * getters. A file that wants a bare `daemon` binding re-binds it in
 * `beforeEachExtra` — a module-scope destructure would capture the pre-test
 * `undefined` and every test would fail.
 *
 * The suite stays hermetic: the bridge runs its real chat path against a
 * scripted daemon instead of the machine's prime install.
 */

/** bb's full-permission options, as the runtime sends them in these tests. */
export const FULL_OPTIONS = {
  permissionMode: "full",
  permissionScope: "full",
  approvalReviewer: null,
  permissionEscalation: null,
};

/** The runtime mints client request ids as `creq_` + ten [2-9a-kmnp-z] characters. */
export const CLIENT_REQUEST_ID = "creq_abcdefghij";

export interface BridgeResponse {
  id: string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

export interface BridgeHarness {
  /** The scripted daemon every bridge command lands on. */
  readonly daemon: ScriptedDaemonHandle;
  /** The thread environment cwd (the session's, unless overridden). */
  readonly cwd: string;
  /** The stdout capture, for tests that assemble timelines from it directly. */
  readonly output: CapturedBridgeJsonRpcOutput;
  /** Every message so far. Accumulates: the capture drains destructively. */
  messages(): unknown[];
  /** Drop what `messages()` has gathered so far (scope later reads). */
  forgetMessages(): void;
  responses(): BridgeResponse[];
  response(id: string): BridgeResponse;
  /** Poll for an answer that lands on a later tick (async handlers). */
  waitForResponse(id: string, timeoutMs?: number): Promise<BridgeResponse>;
  /** Any answer to a request id — result or error; the caller asserts which. */
  waitForAnyResponse(
    id: string,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>>;
  notifications(method: string): Array<{
    method: string;
    params: Record<string, unknown>;
  }>;
  /** The params of `provider/raw` notifications of one inner method. */
  rawNotifications(method: string): Array<Record<string, unknown>>;
  deltas(threadId: string): Array<Record<string, unknown>>;
  sendRequest(id: string, method: string, params?: unknown): void;
  waitFor(
    label: string,
    predicate: () => boolean,
    timeoutMs?: number,
  ): Promise<void>;
  /** Poll until the scripted daemon has received a command of this type. */
  waitForDaemonCommand(commandType: string, timeoutMs?: number): Promise<void>;
}

export function startBridgeHarness(
  args: {
    /** Overrides for the scripted session (ids, files, cwd). */
    session?: Partial<ScriptedSession>;
    /** Extra setup, after the daemon exists and is wired (enqueue blocks). */
    beforeEachExtra?: (harness: BridgeHarness) => void;
    /** Extra teardown, after the standard resets (registries, env, files). */
    afterEachExtra?: () => void | Promise<void>;
  } = {},
): BridgeHarness {
  const collected: unknown[] = [];
  const cwd = args.session?.cwd ?? "/tmp/prime-workspace";
  let daemon: ScriptedDaemonHandle | undefined;
  let output: CapturedBridgeJsonRpcOutput | undefined;

  function messages(): unknown[] {
    collected.push(...output!.takeMessages());
    return collected;
  }

  function responses(): BridgeResponse[] {
    return messages().filter(
      (message): message is BridgeResponse =>
        typeof message === "object" &&
        message !== null &&
        !("method" in (message as Record<string, unknown>)),
    );
  }

  async function waitForResponse(
    id: string,
    timeoutMs = 2_000,
  ): Promise<BridgeResponse> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = responses().find((message) => message.id === id);
      if (found !== undefined) {
        return found;
      }
      if (Date.now() > deadline) {
        throw new Error(`no response with id ${id} within ${timeoutMs}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  async function waitForAnyResponse(
    id: string,
    timeoutMs = 4_000,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = messages().find(
        (message) =>
          (message as { id?: unknown }).id === id &&
          (message as { method?: unknown }).method === undefined,
      );
      if (found !== undefined) {
        return found as Record<string, unknown>;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `no response with id ${id} within ${timeoutMs}ms; got ${JSON.stringify(messages())}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  function notifications(
    method: string,
  ): Array<{ method: string; params: Record<string, unknown> }> {
    return messages().filter(
      (message): message is { method: string; params: Record<string, unknown> } =>
        typeof message === "object" &&
        message !== null &&
        (message as Record<string, unknown>).method === method,
    );
  }

  async function waitFor(
    label: string,
    predicate: () => boolean,
    timeoutMs = 2_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) {
        throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  const harness: BridgeHarness = {
    get daemon(): ScriptedDaemonHandle {
      return daemon!;
    },
    cwd,
    get output(): CapturedBridgeJsonRpcOutput {
      return output!;
    },
    messages,
    forgetMessages() {
      collected.length = 0;
    },
    responses,
    response(id: string): BridgeResponse {
      const reply = responses().find((message) => message.id === id);
      if (reply === undefined) {
        throw new Error(`no response with id ${id}`);
      }
      return reply;
    },
    waitForResponse,
    waitForAnyResponse,
    notifications,
    rawNotifications(method: string): Array<Record<string, unknown>> {
      return notifications("provider/raw")
        .map((message) => message.params as Record<string, unknown>)
        .filter((params) => params.method === method);
    },
    deltas(threadId: string): Array<Record<string, unknown>> {
      return notifications("thread/delta")
        .filter((message) => message.params.threadId === threadId)
        .flatMap(
          (message) => message.params.deltas as Array<Record<string, unknown>>,
        );
    },
    sendRequest(id: string, method: string, params: unknown = {}): void {
      handleLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    },
    waitFor,
    async waitForDaemonCommand(
      commandType: string,
      timeoutMs = 2_000,
    ): Promise<void> {
      await waitFor(
        `the scripted daemon to receive "${commandType}"`,
        () => daemon!.commands.some((command) => command.type === commandType),
        timeoutMs,
      );
    },
  };

  beforeEach(() => {
    output = captureBridgeJsonRpcOutput();
    collected.length = 0;
    const scripted = createScriptedDaemon({ session: { cwd, ...args.session } });
    daemon = scripted;
    setPrimeDaemonTransportFactoryForTests(() => scripted.transport);
    args.beforeEachExtra?.(harness);
  });

  afterEach(async () => {
    output?.restore();
    setPrimeDaemonTransportFactoryForTests(undefined);
    resetDaemonForTests();
    sessionTableForTests().clear();
    await args.afterEachExtra?.();
  });

  return harness;
}

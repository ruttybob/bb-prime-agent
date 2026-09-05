import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * An in-process stand-in for the prime-agent daemon: a unix socket that pushes
 * a `daemon_hello` greeting on connect and optionally answers command
 * envelopes. Tests use it to exercise the handshake, the compat gate, and
 * reconnect without a prime install — it is a fixture, not a daemon, and it
 * imports nothing from the SDK or the test runtime so it stays off every
 * allowlist.
 */

/** The calibrated greeting, as the 0.7.3 daemon pushes it. */
export function calibratedHello(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "daemon_hello",
    socketPath: "<fixture>",
    protocol: { name: "prime-agent.daemon", version: 7 },
    schemaId: "protocol-7-schema-16-1bcb9e7f1a49",
    schemaRevision: 16,
    appVersion: "0.7.3",
    runtime: { platform: process.platform, node: process.version },
    clientId: "fixture-client",
    serverCapabilities: [
      "attach_snapshot",
      "event_sequence",
      "extension_ui",
      "slim_attach",
      "chunked_snapshot",
      "client_owned_sessions",
      "delete_rlm_subagent",
      "heartbeat_catalog",
      "heartbeat_management",
      "model_catalog",
      "side_question_transcript",
      "transient_bash",
      "session_input_admission",
      "prompt_admission_cancellation",
      "queue_message_mutation",
    ],
    ...overrides,
  };
}

export interface FakeDaemonOptions {
  /** First line pushed on every connection. Defaults to the calibrated hello. */
  hello?: unknown;
  /** Push nothing at all (hello-timeout paths). */
  silent?: boolean;
  /**
   * Answer command envelopes: return the object to send, or undefined to
   * answer nothing.
   */
  respond?: (envelope: Record<string, unknown>) => unknown | undefined;
}

export class FakeDaemon {
  private readonly connections = new Set<Socket>();

  private constructor(
    private readonly server: Server,
    private readonly directory: string,
    private readonly options: FakeDaemonOptions,
  ) {}

  static async start(options: FakeDaemonOptions = {}): Promise<FakeDaemon> {
    const directory = mkdtempSync(join(tmpdir(), "bbpa-fake-"));
    const socketPath = join(directory, "daemon.sock");
    const server = createServer((socket: Socket) => {
      daemon.connections.add(socket);
      socket.on("close", () => daemon.connections.delete(socket));
      if (options.silent !== true) {
        socket.write(`${JSON.stringify(options.hello ?? calibratedHello())}\n`);
      }
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line !== "") {
            FakeDaemon.handleLine(socket, line, options);
          }
          newline = buffer.indexOf("\n");
        }
      });
    });
    const daemon = new FakeDaemon(server, directory, options);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => resolve());
    });
    return daemon;
  }

  private static handleLine(
    socket: Socket,
    line: string,
    options: FakeDaemonOptions,
  ): void {
    if (options.respond === undefined) {
      return;
    }
    let envelope: Record<string, unknown>;
    try {
      envelope = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const reply = options.respond(envelope);
    if (reply !== undefined) {
      socket.write(`${JSON.stringify(reply)}\n`);
    }
  }

  get socketPath(): string {
    return join(this.directory, "daemon.sock");
  }

  /** Drop every open connection; the daemon itself keeps listening. */
  dropConnections(): void {
    for (const connection of [...this.connections]) {
      connection.destroy();
    }
  }

  /** Send an unsolicited (push) message to every connected client. */
  pushAll(message: Record<string, unknown>): void {
    for (const connection of [...this.connections]) {
      connection.write(`${JSON.stringify(message)}\n`);
    }
  }

  /** Envelopes the fixture failed to answer (used to assert a timeout). */
  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
      for (const connection of [...this.connections]) {
        connection.destroy();
      }
    });
    rmSync(this.directory, { recursive: true, force: true });
  }
}

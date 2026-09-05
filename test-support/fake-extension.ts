import { createConnection, type Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";

/**
 * A stand-in for the companion prime extension
 * (`extension/bb-tools-extension.ts`): connects to a dynamic-tools channel and
 * speaks the extension half of `extension/PROTOCOL.md`. Deliberately dumb — it
 * does exactly what the messages say, so the behavior under test is the other
 * side's. It imports nothing from the extension itself, so a regression in the
 * real extension cannot hide behind it.
 */
export class FakeExtension {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private socket: Socket | undefined;
  /** Every message the channel sent this extension, in arrival order. */
  readonly received: Record<string, unknown>[] = [];
  /** How a `tools/set` is answered: promptly, never, or with a rejection. */
  mode: "ack" | "silent" | "nack" = "ack";
  nackError = "registerTool: runtime is stale";

  static connect(socketPath: string): Promise<FakeExtension> {
    const extension = new FakeExtension();
    return new Promise<FakeExtension>((resolve, reject) => {
      const socket = createConnection(socketPath);
      socket.once("connect", () => {
        extension.socket = socket;
        socket.on("data", (chunk: Buffer) => extension.handleChunk(chunk));
        resolve(extension);
      });
      socket.once("error", reject);
    });
  }

  private handleChunk(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk);
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
    const message = JSON.parse(line) as Record<string, unknown>;
    this.received.push(message);
    if (message.type === "tools/set") {
      const tools = Array.isArray(message.tools) ? (message.tools as { name: string }[]) : [];
      const names = tools.map((tool) => tool.name);
      if (this.mode === "ack") {
        this.send({ type: "tools/ack", ok: true, registered: names, active: [...names, "read"] });
      } else if (this.mode === "nack") {
        this.send({ type: "tools/ack", ok: false, error: this.nackError });
      }
    }
  }

  send(message: Record<string, unknown>): void {
    this.socket?.write(`${JSON.stringify(message)}\n`);
  }

  call(name: string, args: Record<string, unknown>, callId = "bb-tc-1"): void {
    this.send({ type: "tool/call", callId, name, args });
  }

  async close(): Promise<void> {
    const socket = this.socket;
    if (socket === undefined) {
      return;
    }
    await new Promise<void>((resolve) => {
      socket.end(() => resolve());
    });
  }
}

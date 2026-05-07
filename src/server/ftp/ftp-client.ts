import type { Commands } from "@s/ftp/types";
import { env } from "@/env";

type Config = { host: string; port: number };

type PendingResponse = {
  resolve: (value: string) => void;
  reject: (reason?: unknown) => void;
};

const RESPONSE_TIMEOUT = 30_000 as const;
const RESPONSE_DELIMITER = "\r\n" as const;

export class FTPClient {
  private controlSocket: Bun.Socket<undefined> | null = null;
  private dataSocket: Bun.Socket<undefined> | null = null;

  private controlBuffer = "";
  private dataBuffer: Uint8Array[] = [];
  private pendingResponses: PendingResponse[] = [];
  private responseQueue: string[] = [];

  private dataSocketClosed: Promise<void> | null = null;
  private resolveDataClosed: (() => void) | null = null;
  private rejectDataClosed: ((reason?: unknown) => void) | null = null;

  /**
   * Wrapper around Bun.connect(...)
   * Meant to be used with connectControlSocket or connectDataSocket
   */
  private async connect(
    config: Config,
    kind: "control" | "data",
  ): Promise<Bun.Socket<undefined>> {
    return await Bun.connect({
      hostname: config.host,
      port: config.port,
      socket: {
        data: (_socket, data) => {
          if (kind === "control") {
            this.controlBuffer += data.toString("utf-8");
            this.drainControlBuffer();
          } else {
            this.dataBuffer.push(new Uint8Array(data));
          }
        },
        close: () => {
          if (kind === "data") {
            this.resolveDataClosed?.();
          }
        },
        error: (_socket, error) => {
          if (kind === "control") {
            while (this.pendingResponses.length) {
              this.pendingResponses.shift()!.reject(error);
            }
          } else {
            this.rejectDataClosed?.(error);
          }
        },
      },
    });
  }

  /**
   * Parses the control buffer for complete responses (terminated by \r\n)
   * and resolves pending response promises. Handles multi-line responses
   * following RFC 959 (e.g. "220-..." then "220 end"). Unsolicited
   * responses are queued for the next awaitResponse() call.
   */
  private drainControlBuffer() {
    while (true) {
      const newlineIdx = this.controlBuffer.indexOf(RESPONSE_DELIMITER);
      if (newlineIdx === -1) break;

      const line = this.controlBuffer.slice(0, newlineIdx);
      let full: string;

      // Multi-line: "xyz-..." continues until "xyz " appears
      if (/^\d{3}-/.test(line)) {
        const code = line.slice(0, 3);
        const endIdx = this.controlBuffer.indexOf(
          `${RESPONSE_DELIMITER}${code} `,
          newlineIdx,
        );
        if (endIdx === -1) break; // wait for more data
        const afterStart = endIdx + 2;
        const finalNewline = this.controlBuffer.indexOf("\r\n", afterStart);
        if (finalNewline === -1) break;
        full = this.controlBuffer.slice(0, finalNewline);
        this.controlBuffer = this.controlBuffer.slice(finalNewline + 2);
      } else {
        full = line;
        this.controlBuffer = this.controlBuffer.slice(newlineIdx + 2);
      }

      const pending = this.pendingResponses.shift();
      if (pending) {
        pending.resolve(full);
      } else {
        this.responseQueue.push(full);
      }
    }
  }

  async connectControlSocket(config: Config): Promise<string> {
    if (this.controlSocket) throw new Error("Control socket already exists");
    this.controlSocket = await this.connect(config, "control");
    return this.awaitResponse();
  }

  private async connectDataSocket(config: Config): Promise<void> {
    if (this.dataSocket) this.dataSocket.end();
    this.dataBuffer = [];
    this.dataSocketClosed = new Promise((resolve, reject) => {
      this.resolveDataClosed = resolve;
      this.rejectDataClosed = reject;
    });
    this.dataSocket = await this.connect(config, "data");
  }

  private awaitResponse(): Promise<string> {
    const queued = this.responseQueue.shift();
    if (queued !== undefined) return Promise.resolve(queued);

    return new Promise((resolve, reject) => {
      const entry: PendingResponse = { resolve, reject };
      this.pendingResponses.push(entry);

      const timeout = setTimeout(() => {
        const idx = this.pendingResponses.indexOf(entry);
        if (idx !== -1) {
          this.pendingResponses.splice(idx, 1);
          reject(new Error("FTP response timeout"));
        }
      }, RESPONSE_TIMEOUT);

      const wrap =
        <T extends (v: never) => void>(fn: T) =>
        (v: never) => {
          clearTimeout(timeout);
          fn(v);
        };
      entry.resolve = wrap(resolve) as PendingResponse["resolve"];
      entry.reject = wrap(reject) as PendingResponse["reject"];
    });
  }

  // ---------- Commands ----------

  /**
   * Sends a command on the control socket and awaits the server response.
   */
  private async sendMessage(command: Commands, arg?: string): Promise<string> {
    if (!this.controlSocket) throw new Error("No control socket connected");
    const line = `${command}${arg ? " " + arg : ""}\r\n`;
    this.controlSocket.write(line);
    return this.awaitResponse();
  }

  async setTransferType(type: "ASCII" | "BINARY") {
    return this.sendMessage("TYPE", type === "ASCII" ? "A" : "I");
  }

  async username(user: string): Promise<string> {
    return this.sendMessage("USER", user);
  }

  async password(pass: string): Promise<string> {
    return this.sendMessage("PASS", pass);
  }

  private async passive() {
    const res = await this.sendMessage("PASV");
    const config = this.parsePassiveResponse(res);
    await this.connectDataSocket(config);
  }

  private parsePassiveResponse(res: string): Config {
    // Response format: "227 Entering Passive Mode (h1,h2,h3,h4,p1,p2)."
    const match = res.match(/\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/);
    if (!match) throw new Error(`Invalid PASV response: ${res}`);

    const [, h1, h2, h3, h4, p1, p2] = match;
    const host = `${h1}.${h2}.${h3}.${h4}`;
    const port = (Number(p1) << 8) + Number(p2);

    const min = env.FTP_MIN_PASV_PORT;
    const max = env.FTP_MAX_PASV_PORT;

    if (port < min || port > max) {
      throw new Error(`Port ${port} out of allowed range [${min}, ${max}]`);
    }

    return { host, port };
  }

  async currentDirectory() {
    return this.sendMessage("PWD");
  }

  private concatDataBuffer(): Uint8Array {
    const total = this.dataBuffer.reduce((n, c) => n + c.byteLength, 0);
    const merged = new Uint8Array(total);
    let off = 0;
    for (const chunk of this.dataBuffer) {
      merged.set(chunk, off);
      off += chunk.byteLength;
    }
    return merged;
  }

  /**
   * @param path - Optional path. If not passed, lists current directory.
   */
  async list(path?: string): Promise<string> {
    await this.passive();
    await this.sendMessage("LIST", path);
    const transferComplete = this.awaitResponse();
    await this.dataSocketClosed;
    await transferComplete; // "226 Transfer complete"

    const merged = this.concatDataBuffer();
    this.dataSocket = null;

    return new TextDecoder().decode(merged);
  }

  async upload(file: {
    path: string;
    data: Uint8Array | string;
  }): Promise<void> {
    await this.passive();
    await this.sendMessage("STOR", file.path);
    const transferComplete = this.awaitResponse();
    this.dataSocket!.write(file.data);
    this.dataSocket!.end();
    await this.dataSocketClosed;
    await transferComplete;
    this.dataSocket = null;
  }

  async download(path: string): Promise<Uint8Array> {
    await this.passive();
    await this.sendMessage("RETR", path);
    const transferComplete = this.awaitResponse();
    await this.dataSocketClosed;
    await transferComplete;

    const merged = this.concatDataBuffer();
    this.dataSocket = null;
    return merged;
  }

  /** Resets internals. */
  private disconnect() {
    this.controlSocket?.end();
    this.dataSocket?.end();
    this.controlSocket = null;
    this.dataSocket = null;
    this.controlBuffer = "";
    this.dataBuffer = [];
    this.responseQueue = [];
    for (const p of this.pendingResponses) {
      p.reject(new Error("Client disconnected"));
    }
    this.pendingResponses = [];
    this.rejectDataClosed?.(new Error("Client disconnected"));
    this.dataSocketClosed = null;
    this.resolveDataClosed = null;
    this.rejectDataClosed = null;
  }

  /** Wrapper around disconnect with graceful QUIT */
  async close() {
    try {
      if (this.controlSocket) {
        // Race QUIT against a short timeout so a hung server doesn't block close.
        await Promise.race([
          this.sendMessage("QUIT"),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("QUIT timeout")), 2_000),
          ),
        ]);
      }
    } catch {
      // ignore – we're closing anyway
    } finally {
      this.disconnect();
    }
  }
}

import type { Commands } from "@s/ftp/types";
import { env } from "@/env";

type Config = { host: string; port: number };

type PendingResponse = {
  resolve: (value: string) => void;
  reject: (reason?: unknown) => void;
};

const RESPONSE_TIMEOUT = 30_000 as const;
const RESPONSE_DELIMITER = "\r\n" as const;

type Response = {
  raw: string;
  code: number;
  message: string;
  ok: boolean;
};

type FTPResponse = Promise<Response>;

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
   * Initializes a socket connection for either control or data streams.
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
   * Processes the control buffer to extract and resolve FTP responses.
   * Handles RFC 959 multi-line responses.
   */
  private drainControlBuffer() {
    while (true) {
      const newlineIdx = this.controlBuffer.indexOf(RESPONSE_DELIMITER);
      if (newlineIdx === -1) break;

      const line = this.controlBuffer.slice(0, newlineIdx);
      let full: string;

      if (/^\d{3}-/.test(line)) {
        const code = line.slice(0, 3);
        const endIdx = this.controlBuffer.indexOf(
          `${RESPONSE_DELIMITER}${code} `,
          newlineIdx,
        );
        if (endIdx === -1) break;

        const afterStart = endIdx + 2;
        const finalNewline = this.controlBuffer.indexOf(
          RESPONSE_DELIMITER,
          afterStart,
        );
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

  /**
   * Transforms a raw FTP string into a structured Response object.
   */
  private parseResponse(raw: string): Response {
    const code = parseInt(raw.slice(0, 3), 10);
    return {
      raw,
      code,
      message: raw.slice(4),
      ok: code > 0 && code < 400,
    };
  }

  /**
   * Establishes the primary control connection to the FTP server.
   */
  async connectControlSocket(config: Config): FTPResponse {
    if (this.controlSocket) throw new Error("Control socket already exists");
    this.controlSocket = await this.connect(config, "control");
    return this.awaitResponse();
  }

  private closeDataSocket() {
    if (this.dataSocket) {
      this.dataSocket.end();
      this.dataSocket = null;
    }
  }

  /**
   * Establishes a secondary connection for data transfer.
   */
  private async connectDataSocket(config: Config): Promise<void> {
    this.closeDataSocket();
    this.dataBuffer = [];
    this.dataSocketClosed = new Promise((resolve, reject) => {
      this.resolveDataClosed = resolve;
      this.rejectDataClosed = reject;
    });
    this.dataSocket = await this.connect(config, "data");
  }

  /**
   * Returns a promise that resolves with the next available FTP response.
   */
  private async awaitResponse(): FTPResponse {
    const queued = this.responseQueue.shift();
    if (queued !== undefined) {
      return this.parseResponse(queued);
    }

    const raw = await new Promise<string>((resolve, reject) => {
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
        <T extends (v: any) => void>(fn: T) =>
        (v: any) => {
          clearTimeout(timeout);
          fn(v);
        };
      entry.resolve = wrap(resolve);
      entry.reject = wrap(reject);
    });

    return this.parseResponse(raw);
  }

  /**
   * Sends a raw FTP command over the control socket.
   */
  private async sendMessage(command: Commands, arg?: string): FTPResponse {
    if (!this.controlSocket) throw new Error("No control socket connected");
    const line = `${command}${arg ? " " + arg : ""}\r\n`;
    this.controlSocket.write(line);
    return this.awaitResponse();
  }

  /**
   * Sets the transfer mode to either ASCII or Image (Binary).
   */
  async setTransferType(type: "ASCII" | "BINARY") {
    return this.sendMessage("TYPE", type === "ASCII" ? "A" : "I");
  }

  /**
   * Sends the USER command for authentication.
   */
  async username(user: string): FTPResponse {
    return this.sendMessage("USER", user);
  }

  /**
   * Sends the PASS command for authentication.
   */
  async password(pass: string): FTPResponse {
    return this.sendMessage("PASS", pass);
  }

  /**
   * Enters passive mode and initializes the data socket connection.
   */
  private async passive(): FTPResponse {
    const res = await this.sendMessage("PASV");
    if (!res.ok) return res;
    const config = this.parsePassiveResponse(res.raw);
    await this.connectDataSocket(config);
    return res;
  }

  /**
   * Parses the host and port information from a PASV response.
   */
  private parsePassiveResponse(res: string): Config {
    const match = res.match(/\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/);
    if (!match) throw new Error(`Invalid PASV response: ${res}`);

    const [, h1, h2, h3, h4, p1, p2] = match;
    const host = `${h1}.${h2}.${h3}.${h4}`;
    const port = (Number(p1) << 8) + Number(p2);

    if (env.NODE_ENV === "dev") {
      const min = env.FTP_MIN_PASV_PORT;
      const max = env.FTP_MAX_PASV_PORT;
      if (port < min || port > max) {
        throw new Error(`Port ${port} out of allowed range [${min}, ${max}]`);
      }
    }

    return { host, port };
  }

  async currentDirectory(): FTPResponse {
    return this.sendMessage("PWD");
  }

  /**
   * Merges all collected data chunks into a single Uint8Array.
   */
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
   * Lists files in the specified path or current directory.
   */
  async list(path?: string): Promise<Response & { data?: string }> {
    const pRes = await this.passive();
    if (!pRes.ok) return pRes;

    try {
      const cmdRes = await this.sendMessage("LIST", path);
      if (!cmdRes.ok) return cmdRes;

      const transferComplete = this.awaitResponse();
      await this.dataSocketClosed;
      const transferRes = await transferComplete;

      const merged = this.concatDataBuffer();
      this.dataSocket = null;

      return { ...transferRes, data: new TextDecoder().decode(merged) };
    } finally {
      this.closeDataSocket();
    }
  }

  /**
   * Uploads a file to the FTP server using the STOR command.
   */
  async upload(file: { path: string; data: Uint8Array | string }): FTPResponse {
    const pRes = await this.passive();
    if (!pRes.ok) return pRes;

    try {
      const cmdRes = await this.sendMessage("STOR", file.path);
      if (!cmdRes.ok) return cmdRes;

      const transferComplete = this.awaitResponse();
      this.dataSocket!.write(file.data);
      this.dataSocket!.end();

      await this.dataSocketClosed;
      return await transferComplete;
    } finally {
      this.closeDataSocket();
    }
  }

  /**
   * Downloads a file from the FTP server using the RETR command.
   */
  async download(path: string): Promise<Response & { data?: Uint8Array }> {
    const pRes = await this.passive();
    if (!pRes.ok) return pRes;

    try {
      const cmdRes = await this.sendMessage("RETR", path);
      if (!cmdRes.ok) return cmdRes;

      const transferComplete = this.awaitResponse();
      await this.dataSocketClosed;
      const transferRes = await transferComplete;

      return { ...transferRes, data: this.concatDataBuffer() };
    } finally {
      this.closeDataSocket();
    }
  }

  /**
   * Closes all connections and clears internal state.
   */
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

  /**
   * Gracefully shuts down the FTP session.
   */
  async close() {
    try {
      if (this.controlSocket) {
        await Promise.race([
          this.sendMessage("QUIT"),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("QUIT timeout")), 2_000),
          ),
        ]);
      }
    } catch {
      // Ignore errors during graceful shutdown
    } finally {
      this.disconnect();
    }
  }
}

import type { Commands } from "@s/ftp/types";
import { env } from "@/env";

type Config = { host: string; port: number };

type PendingResponse = {
  resolve: (value: string) => void;
  reject: (reason?: unknown) => void;
};

export class FTPClient {
  private controlSocket: Bun.Socket<undefined> | null = null;
  private dataSocket: Bun.Socket<undefined> | null = null;

  private controlBuffer = "";
  private dataBuffer: Uint8Array[] = [];
  private pendingResponses: PendingResponse[] = [];
  private dataSocketClosed: Promise<void> | null = null;
  private resolveDataClosed: (() => void) | null = null;

  /**
   * Wrapper around Bun.connect(...)
   * Meant to be used with createControlSocket or createDataSocket
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
        open: () => {
          // connection established
        },
        close: () => {
          if (kind === "data") {
            this.resolveDataClosed?.();
          }
        },
        error: (_socket, error) => {
          if (kind === "control") {
            // Reject all pending responses
            while (this.pendingResponses.length) {
              this.pendingResponses.shift()!.reject(error);
            }
          }
        },
      },
    });
  }

  /**
   * Parses the control buffer for complete responses (terminated by \r\n)
   * and resolves pending response promises. Handles multi-line responses
   * following RFC 959 (e.g. "220-..." then "220 end").
   */
  private drainControlBuffer() {
    while (true) {
      const newlineIdx = this.controlBuffer.indexOf("\r\n");
      if (newlineIdx === -1) break;

      const line = this.controlBuffer.slice(0, newlineIdx);
      // Multi-line: "xyz-..." continues until "xyz " appears
      if (/^\d{3}-/.test(line)) {
        const code = line.slice(0, 3);
        const endIdx = this.controlBuffer.indexOf(`\r\n${code} `);
        if (endIdx === -1) break; // wait for more data
        // find end-of-line of the terminating line
        const afterStart = endIdx + 2;
        const finalNewline = this.controlBuffer.indexOf("\r\n", afterStart);
        if (finalNewline === -1) break;
        const full = this.controlBuffer.slice(0, finalNewline);
        this.controlBuffer = this.controlBuffer.slice(finalNewline + 2);
        this.pendingResponses.shift()?.resolve(full);
      } else {
        this.controlBuffer = this.controlBuffer.slice(newlineIdx + 2);
        this.pendingResponses.shift()?.resolve(line);
      }
    }
  }

  async connectControlSocket(config: Config) {
    if (this.controlSocket) throw new Error("Control socket already exists");
    this.controlSocket = await this.connect(config, "control");
    // Await the server greeting (220)
    return await this.awaitResponse();
  }

  private async connectDataSocket(config: Config): Promise<void> {
    if (this.dataSocket) this.dataSocket.end();
    this.dataBuffer = [];
    this.dataSocketClosed = new Promise((resolve) => {
      this.resolveDataClosed = resolve;
    });
    this.dataSocket = await this.connect(config, "data");
  }

  private awaitResponse(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.pendingResponses.push({ resolve, reject });
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

  async responseType(type: "UTF-8" | "ASCII") {
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

    const min = env.FTP_MIN_PORT;
    const max = env.FTP_MAX_PORT;

    if (port < min || port > max) {
      throw new Error(`Port ${port} out of allowed range (${min}, ${max})`);
    }

    return { host, port };
  }

  /** Prints current working directory */
  async current() {
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
    await this.sendMessage("LIST", path ?? "/");
    await this.dataSocketClosed;
    await this.awaitResponse();

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
    this.dataSocket!.write(file.data);
    this.dataSocket!.end();
    await this.dataSocketClosed;
    await this.awaitResponse();
    this.dataSocket = null;
  }

  async download(path: string): Promise<Uint8Array> {
    await this.passive();
    await this.sendMessage("RETR", path);
    await this.dataSocketClosed;
    await this.awaitResponse();

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
    for (const p of this.pendingResponses) {
      p.reject(new Error("Client disconnected"));
    }
    this.pendingResponses = [];
    this.dataSocketClosed = null;
    this.resolveDataClosed = null;
  }

  /** Wrapper around disconnect with graceful QUIT */
  async close() {
    try {
      if (this.controlSocket) {
        await this.sendMessage("QUIT");
      }
    } catch {
      // ignore – we're closing anyway
    } finally {
      this.disconnect();
    }
  }
}

import type { ServerWebSocket } from "bun";
import type { WSContext } from "hono/ws";
import { FTPClient } from "../ftp/ftp-client";
import type { ServerMessage } from "../../shared/messages";

export class Session {
  readonly id: string;
  private ftp: FTPClient | null = null;
  private ws: WSContext<ServerWebSocket>;

  constructor(ws: WSContext<ServerWebSocket>) {
    this.id = crypto.randomUUID();
    this.ws = ws;
  }

  get client(): FTPClient | null {
    return this.ftp;
  }

  get isConnected(): boolean {
    return this.ftp !== null;
  }

  send(msg: ServerMessage): void {
    try {
      this.ws.send(JSON.stringify(msg));
    } catch (err) {
      console.error(`[session ${this.id}] send failed:`, err);
    }
  }

  async connect(config: {
    host: string;
    port: number;
    user: string;
    pass: string;
    encoding: "UTF-8" | "ASCII";
  }): Promise<void> {
    if (this.ftp) throw new Error("Already connected. Disconnect first.");

    const ftp = new FTPClient();

    await ftp.connectControlSocket({ host: config.host, port: config.port });
    await ftp.username(config.user);
    await ftp.password(config.pass);
    await ftp.responseType(config.encoding);

    this.ftp = ftp;
  }

  async disconnect(): Promise<void> {
    if (!this.ftp) return;
    try {
      await this.ftp.close();
    } catch {
      // ignore — underlying socket may already be torn down
    } finally {
      this.ftp = null;
    }
  }

  requireClient(): FTPClient {
    if (!this.ftp) throw new Error("Not connected");
    return this.ftp;
  }
}

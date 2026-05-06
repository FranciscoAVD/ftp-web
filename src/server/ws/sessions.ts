import type { ServerMessage } from "@/shared/messages";
import type { FTPClient } from "@s/ftp/ftp-client";
import type { ServerWebSocket } from "bun";
import { CryptoKeyUsage } from "hono/utils/jwt/types";
import type { WSContext } from "hono/ws";

/**
Maintains sessions attached to a web socket id
*/
export class Sessions {
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
      console.error(`[SESSION ${this.id}] Send failed.`);
    }
  }

  async connect(config: { host: string; port: number }): Promise<void> {}
}

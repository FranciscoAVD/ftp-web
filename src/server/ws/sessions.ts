import type { FTPClient } from "@s/ftp/ftp-client";

/**
Maintains sessions attached to a web socket id
*/
export const FTPClients = new Map<string, FTPClient>();

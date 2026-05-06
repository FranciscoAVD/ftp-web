import { z } from "zod";

export const ClientMessage = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("connect"),
    host: z.string().min(1),
    port: z.number().int().positive().default(21),
    user: z.string().default("anonymous"),
    pass: z.string().default(""),
    secure: z.boolean().default(false),
  }),
  z.object({ type: z.literal("disconnect") }),
  z.object({ type: z.literal("list"), path: z.string().optional() }),
  z.object({ type: z.literal("cwd"), path: z.string() }),
  z.object({ type: z.literal("pwd") }),
  z.object({ type: z.literal("mkdir"), path: z.string() }),
  z.object({ type: z.literal("rmdir"), path: z.string() }),
  z.object({ type: z.literal("delete"), path: z.string() }),
  z.object({
    type: z.literal("rename"),
    from: z.string(),
    to: z.string(),
  }),
  z.object({ type: z.literal("raw"), command: z.string() }),
]);

export type ClientMessage = z.infer<typeof ClientMessage>;

export type ServerMessage =
  | { type: "ready"; sessionId: string }
  | { type: "connected"; host: string }
  | { type: "disconnected" }
  | { type: "pwd"; path: string }
  | { type: "listing"; path: string; entries: FileEntry[] }
  | { type: "ok"; op: string; message?: string }
  | { type: "error"; op?: string; message: string }
  | { type: "log"; direction: "in" | "out"; line: string }
  | {
      type: "progress";
      transferId: string;
      bytes: number;
      total?: number;
    };

export interface FileEntry {
  name: string;
  type: "file" | "dir" | "link";
  size: number;
  modified?: string;
  permissions?: string;
}

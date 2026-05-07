import { env } from "@/env";
import { z } from "zod";

export const ClientMessage = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("connect"),
    host: z.string().min(1),
    port: z.number().int().positive().default(21),
    user: z.string(),
    pass: z.string(),
    encoding: z.enum(["UTF-8", "ASCII"]).default("UTF-8"),
  }),
  z.object({ type: z.literal("disconnect") }),
  z.object({ type: z.literal("pwd") }),
  z.object({ type: z.literal("list") }),
  z.object({
    type: z.literal("encoding"),
    value: z.enum(["UTF-8", "ASCII"]),
  }),
  // Upload/download triggered over WS act as *control* signals;
  // actual bytes flow over HTTP routes.
  z.object({
    type: z.literal("upload"),
    transferId: z.string(),
    remotePath: z.string(),
  }),
  z.object({
    type: z.literal("download"),
    transferId: z.string(),
    remotePath: z.string(),
  }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

export type ServerMessage =
  | { type: "ready"; sessionId: string }
  | { type: "connected"; host: string }
  | { type: "disconnected" }
  | { type: "pwd"; path: string }
  | { type: "listing"; raw: string }
  | { type: "ok"; op: string; message?: string }
  | { type: "error"; op?: string; message: string }
  | { type: "log"; direction: "in" | "out"; line: string };

import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  clientPrefix: "PUBLIC",
  client: {},
  server: {
    NODE_ENV: z.enum(["prod", "dev"]),
    FTP_SERVER_HOST: z.string(),
    FTP_CONTROL_PORT: z
      .string()
      .refine((p) => Number.isInteger(parseInt(p)))
      .transform((p) => Number(p)),
    FTP_MIN_PASV_PORT: z
      .string()
      .refine((p) => Number.isInteger(parseInt(p)))
      .transform((p) => Number(p)),
    FTP_MAX_PASV_PORT: z
      .string()
      .refine((p) => Number.isInteger(parseInt(p)))
      .transform((p) => Number(p)),
  },
  shared: {
    FTP_DEFAULT_USER: z.string(),
    FTP_DEFAULT_USER_PASS: z.string(),
  },
  runtimeEnv: {
    NODE_ENV: Bun.env.NODE_ENV,
    FTP_SERVER_HOST: Bun.env.FTP_SERVER_HOST,
    FTP_CONTROL_PORT: Bun.env.FTP_CONTROL_PORT,
    FTP_MIN_PASV_PORT: Bun.env.FTP_MIN_PASV_PORT,
    FTP_MAX_PASV_PORT: Bun.env.FTP_MAX_PASV_PORT,
    FTP_DEFAULT_USER: Bun.env.FTP_DEFAULT_USER,
    FTP_DEFAULT_USER_PASS: Bun.env.FTP_DEFAULT_USER_PASS,
  },
  emptyStringAsUndefined: true,
});

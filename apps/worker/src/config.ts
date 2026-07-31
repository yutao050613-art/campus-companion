import { platform } from "node:os";
import { z } from "zod";

const WorkerEnvironmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "staging", "production"]).default("development"),
  REDIS_URL: z
    .string()
    .url()
    .refine((value) => value.startsWith("redis://") || value.startsWith("rediss://"), {
      message: "REDIS_URL must use redis:// or rediss://",
    }),
  DATABASE_URL: z.string().min(1).optional(),
  LOCAL_OBJECT_UPLOAD_SECRET: z.string().default(""),
  LOCAL_OBJECT_STORE_ROOT: z.string().min(1).optional(),
  PUBLIC_API_BASE_URL: z.string().url().default("http://127.0.0.1:3000"),
  QUEUE_PREFIX: z
    .string()
    .regex(/^[a-z0-9_-]{1,40}$/)
    .default("campus"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

export interface WorkerConfig {
  readonly nodeEnv: "development" | "test" | "staging" | "production";
  readonly redisUrl: string;
  readonly databaseUrl?: string;
  readonly localObjectUploadSecret: string;
  readonly localObjectStoreRoot: string;
  readonly publicApiBaseUrl: string;
  readonly queuePrefix: string;
  readonly logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
}

export function loadWorkerConfig(environment: NodeJS.ProcessEnv): WorkerConfig {
  const parsed = WorkerEnvironmentSchema.parse(environment);
  if (
    (parsed.NODE_ENV === "staging" || parsed.NODE_ENV === "production") &&
    (parsed.DATABASE_URL === undefined ||
      Buffer.byteLength(parsed.LOCAL_OBJECT_UPLOAD_SECRET, "utf8") < 32)
  ) {
    throw new Error("worker database and object-store credentials are required");
  }
  return {
    nodeEnv: parsed.NODE_ENV,
    redisUrl: parsed.REDIS_URL,
    ...(parsed.DATABASE_URL === undefined ? {} : { databaseUrl: parsed.DATABASE_URL }),
    localObjectUploadSecret: parsed.LOCAL_OBJECT_UPLOAD_SECRET,
    localObjectStoreRoot:
      parsed.LOCAL_OBJECT_STORE_ROOT ??
      (platform() === "win32"
        ? "D:\\CodexWorkspace\\work\\campus-companion-object-store"
        : "/tmp/campus-companion-object-store"),
    publicApiBaseUrl: parsed.PUBLIC_API_BASE_URL,
    queuePrefix: parsed.QUEUE_PREFIX,
    logLevel: parsed.LOG_LEVEL,
  };
}

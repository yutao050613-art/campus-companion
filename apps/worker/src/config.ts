import { z } from "zod";

const WorkerEnvironmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "staging", "production"]).default("development"),
  REDIS_URL: z
    .string()
    .url()
    .refine((value) => value.startsWith("redis://") || value.startsWith("rediss://"), {
      message: "REDIS_URL must use redis:// or rediss://",
    }),
  QUEUE_PREFIX: z
    .string()
    .regex(/^[a-z0-9_-]{1,40}$/)
    .default("campus"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

export interface WorkerConfig {
  readonly nodeEnv: "development" | "test" | "staging" | "production";
  readonly redisUrl: string;
  readonly queuePrefix: string;
  readonly logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
}

export function loadWorkerConfig(environment: NodeJS.ProcessEnv): WorkerConfig {
  const parsed = WorkerEnvironmentSchema.parse(environment);
  return {
    nodeEnv: parsed.NODE_ENV,
    redisUrl: parsed.REDIS_URL,
    queuePrefix: parsed.QUEUE_PREFIX,
    logLevel: parsed.LOG_LEVEL,
  };
}

import { z } from "zod";

const EnvironmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "staging", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3_000),
  APP_VERSION: z.string().min(1).max(100).default("0.1.0"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

export interface AppConfig {
  readonly nodeEnv: "development" | "test" | "staging" | "production";
  readonly port: number;
  readonly version: string;
  readonly logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
}

export const APP_CONFIG = Symbol("APP_CONFIG");

export function loadConfig(environment: NodeJS.ProcessEnv): AppConfig {
  const parsed = EnvironmentSchema.parse(environment);
  return {
    nodeEnv: parsed.NODE_ENV,
    port: parsed.PORT,
    version: parsed.APP_VERSION,
    logLevel: parsed.LOG_LEVEL,
  };
}

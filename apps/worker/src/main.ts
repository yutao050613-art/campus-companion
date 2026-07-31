import { createLogger } from "@campus/observability";
import { Worker } from "bullmq";
import { loadWorkerConfig } from "./config";
import { toRedisConnection } from "./redis-connection";
import { processSystemJob } from "./system-processor";

async function main(): Promise<void> {
  const config = loadWorkerConfig(process.env);
  const logger = createLogger({ service: "campus-worker", level: config.logLevel });
  const worker = new Worker(
    "system",
    async (job) => {
      const result = processSystemJob(job);
      logger.info({ jobId: job.id, jobName: job.name }, "foundation job completed");
      return result;
    },
    {
      connection: toRedisConnection(config.redisUrl),
      prefix: config.queuePrefix,
      concurrency: 1,
    },
  );

  worker.on("failed", (job, error) => {
    logger.error({ err: error, jobId: job?.id, jobName: job?.name }, "worker job failed");
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "worker shutting down");
    await worker.close();
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  logger.info({ queuePrefix: config.queuePrefix, environment: config.nodeEnv }, "worker ready");
}

void main().catch((error: unknown) => {
  const logger = createLogger({ service: "campus-worker-bootstrap" });
  logger.fatal({ err: error }, "worker failed to start");
  process.exitCode = 1;
});

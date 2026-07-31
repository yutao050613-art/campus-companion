import { createPrismaClient } from "@campus/database";
import { createLogger } from "@campus/observability";
import { LocalVerificationObjectStore } from "@campus/verification";
import { Worker } from "bullmq";
import { loadWorkerConfig } from "./config";
import { PrismaFormationDeadlineRepository, runFormationDeadlineSweep } from "./formation-timeout";
import { toRedisConnection } from "./redis-connection";
import { processSystemJob } from "./system-processor";
import {
  PrismaVerificationAssetDeletionRepository,
  runVerificationAssetDeletionSweep,
} from "./verification-asset-deletion";

async function main(): Promise<void> {
  const config = loadWorkerConfig(process.env);
  if (config.databaseUrl === undefined) throw new Error("DATABASE_URL is required");
  if (Buffer.byteLength(config.localObjectUploadSecret, "utf8") < 32) {
    throw new Error("LOCAL_OBJECT_UPLOAD_SECRET is required");
  }
  const logger = createLogger({ service: "campus-worker", level: config.logLevel });
  const prisma = createPrismaClient();
  const deletionRepository = new PrismaVerificationAssetDeletionRepository(prisma);
  const formationRepository = new PrismaFormationDeadlineRepository(prisma);
  const objectStore = new LocalVerificationObjectStore({
    rootDirectory: config.localObjectStoreRoot,
    uploadHmacSecret: config.localObjectUploadSecret,
    publicBaseUrl: config.publicApiBaseUrl,
  });
  let sweepRunning = false;
  const runDeletionSweep = async (): Promise<void> => {
    if (sweepRunning) return;
    sweepRunning = true;
    try {
      const result = await runVerificationAssetDeletionSweep(deletionRepository, objectStore);
      if (result.assetsDeleted + result.exactObjectsDeleted + result.failures > 0) {
        logger.info(result, "verification material deletion sweep completed");
      }
    } catch (error) {
      logger.error({ err: error }, "verification material deletion sweep failed");
    } finally {
      sweepRunning = false;
    }
  };
  const deletionTimer = setInterval(() => void runDeletionSweep(), 60_000);
  deletionTimer.unref();
  void runDeletionSweep();
  let formationSweepRunning = false;
  const runFormationSweep = async (): Promise<void> => {
    if (formationSweepRunning) return;
    formationSweepRunning = true;
    try {
      const result = await runFormationDeadlineSweep(formationRepository);
      if (result.roundsInvalidated + result.groupsExpired > 0) {
        logger.info(result, "formation deadline sweep completed");
      }
    } catch (error) {
      logger.error({ err: error }, "formation deadline sweep failed");
    } finally {
      formationSweepRunning = false;
    }
  };
  const formationTimer = setInterval(() => void runFormationSweep(), 15_000);
  formationTimer.unref();
  void runFormationSweep();
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
    clearInterval(deletionTimer);
    clearInterval(formationTimer);
    await worker.close();
    await prisma.$disconnect();
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

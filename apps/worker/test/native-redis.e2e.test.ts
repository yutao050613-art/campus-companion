import { randomUUID } from "node:crypto";
import { Queue, QueueEvents, Worker } from "bullmq";
import { afterAll, describe, expect, it } from "vitest";
import { toRedisConnection } from "../src/redis-connection";
import { processSystemJob } from "../src/system-processor";

const { NATIVE_REDIS_TESTS: nativeRedisTests, REDIS_URL: redisUrl } = process.env;
const runNativeRedis = nativeRedisTests === "true";
const resources: Array<{ close: () => Promise<void> }> = [];

describe.runIf(runNativeRedis)("native Redis queue", () => {
  afterAll(async () => {
    await Promise.all(resources.reverse().map((resource) => resource.close()));
  });

  it("delivers one registered job through BullMQ", async () => {
    if (!redisUrl) {
      throw new Error("REDIS_URL is required when NATIVE_REDIS_TESTS=true");
    }
    const connection = toRedisConnection(redisUrl);
    const prefix = `campus-m1-${randomUUID()}`;
    const queue = new Queue("system", { connection, prefix });
    const events = new QueueEvents("system", { connection, prefix });
    const worker = new Worker("system", async (job) => processSystemJob(job), {
      connection,
      prefix,
      concurrency: 1,
    });
    resources.push(queue, events, worker);

    await Promise.all([events.waitUntilReady(), worker.waitUntilReady()]);
    const job = await queue.add("foundation.noop", {}, { removeOnComplete: true });

    await expect(job.waitUntilFinished(events, 5_000)).resolves.toEqual({ ok: true });
  });
});

import { describe, expect, it } from "vitest";
import { toRedisConnection } from "../src/redis-connection";
import { processSystemJob } from "../src/system-processor";

describe("worker foundation", () => {
  it("parses credentials, database and TLS without retaining the source URL", () => {
    expect(toRedisConnection("rediss://worker:p%40ss@redis.example.invalid:6380/2")).toEqual({
      host: "redis.example.invalid",
      port: 6380,
      username: "worker",
      password: "p@ss",
      db: 2,
      maxRetriesPerRequest: null,
      tls: {},
    });
  });

  it("rejects an invalid Redis database number", () => {
    expect(() => toRedisConnection("redis://localhost/not-a-number")).toThrow();
  });

  it("accepts only the explicitly registered M1 job", () => {
    expect(processSystemJob({ name: "foundation.noop" })).toEqual({ ok: true });
    expect(() => processSystemJob({ name: "unregistered" })).toThrow("Unsupported M1 job");
  });
});

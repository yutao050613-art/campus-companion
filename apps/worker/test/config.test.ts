import { describe, expect, it } from "vitest";
import { loadWorkerConfig } from "../src/config";

describe("worker configuration", () => {
  it("accepts an explicit Redis endpoint", () => {
    expect(loadWorkerConfig({ REDIS_URL: "redis://localhost:6379" })).toMatchObject({
      redisUrl: "redis://localhost:6379",
      queuePrefix: "campus",
    });
  });

  it("rejects non-Redis URLs", () => {
    expect(() => loadWorkerConfig({ REDIS_URL: "https://example.invalid" })).toThrow();
  });

  it("rejects unsafe queue prefixes", () => {
    expect(() =>
      loadWorkerConfig({ REDIS_URL: "redis://localhost", QUEUE_PREFIX: "../escape" }),
    ).toThrow();
  });
});

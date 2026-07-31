import { Writable } from "node:stream";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/bootstrap";

describe("API foundation", () => {
  let app: NestFastifyApplication;

  beforeEach(async () => {
    app = await createApp({
      level: "silent",
      destination: new Writable({ write: (_chunk, _encoding, callback) => callback() }),
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("serves a minimal health response with a server-generated request id", async () => {
    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: "GET",
        url: "/v1/health",
        headers: { "x-request-id": "attacker-controlled" },
      });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-request-id"]).toMatch(/^req_[0-9a-f-]{36}$/);
    expect(response.headers["x-request-id"]).not.toBe("attacker-controlled");
    expect(response.json()).toMatchObject({ status: "ok", service: "campus-api" });
  });

  it("normalizes framework 404 responses without leaking internals", async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: "GET",
      url: "/v1/not-present",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: {
        code: "RESOURCE_NOT_FOUND",
        message: "request failed",
        requestId: response.headers["x-request-id"],
      },
    });
  });
});

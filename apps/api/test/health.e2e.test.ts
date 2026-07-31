import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import type { VerificationObjectStore } from "@campus/verification";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/bootstrap";
import { VERIFICATION_OBJECT_STORE } from "../src/m2/providers";

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

  it("accepts a bounded encrypted upload token longer than the router default", async () => {
    const objectStore = app.get<VerificationObjectStore>(VERIFICATION_OBJECT_STORE);
    const grant = objectStore.issueUpload({
      campusId: randomUUID(),
      verificationId: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const uploadPath = new URL(grant.uploadUrl).pathname;
    const token = uploadPath.split("/").at(-1) ?? "";
    expect(token.length).toBeGreaterThan(100);
    expect(token.length).toBeLessThanOrEqual(512);

    try {
      const response = await app
        .getHttpAdapter()
        .getInstance()
        .inject({
          method: "PUT",
          url: uploadPath,
          headers: { "content-type": "image/png" },
          payload: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        });
      expect(response.statusCode).toBe(204);
      expect(response.headers.etag).toMatch(/^[a-f0-9]{64}$/u);
    } finally {
      await objectStore.delete(grant.objectKey);
    }
  });
});

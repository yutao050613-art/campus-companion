import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalVerificationObjectStore } from "../src";

const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

describe("local verification object store", () => {
  let root = "";
  let store: LocalVerificationObjectStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "campus-verification-"));
    store = new LocalVerificationObjectStore({
      rootDirectory: root,
      uploadHmacSecret: "upload-hmac-secret-that-is-longer-than-thirty-two-bytes",
      publicBaseUrl: "http://127.0.0.1:3000",
      maxBytes: 32,
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("issues a signed upload, verifies object integrity, reads, and deletes it", async () => {
    const campusId = randomUUID();
    const verificationId = randomUUID();
    const expiresAt = new Date("2026-07-31T12:01:00.000Z");
    const grant = store.issueUpload({ campusId, verificationId, expiresAt });
    const token = decodeURIComponent(grant.uploadUrl.split("/").at(-1) ?? "");
    expect(token).not.toContain(campusId);
    expect(Buffer.from(token, "base64url").toString("utf8")).not.toContain(verificationId);
    const content = pngBytes;

    const metadata = await store.putByUploadToken(
      token,
      content,
      "image/png",
      new Date("2026-07-31T12:00:00.000Z"),
    );
    expect(metadata.sizeBytes).toBe(content.length);
    await expect(store.head(grant.objectKey)).resolves.toEqual(metadata);
    await expect(store.read(grant.objectKey)).resolves.toEqual(content);

    await store.delete(grant.objectKey);
    await expect(store.head(grant.objectKey)).resolves.toBeNull();
    await expect(store.read(grant.objectKey)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects expired, forged, repeated, oversized, and unsupported uploads", async () => {
    const expiresAt = new Date("2026-07-31T12:01:00.000Z");
    const grant = store.issueUpload({
      campusId: randomUUID(),
      verificationId: randomUUID(),
      expiresAt,
    });
    const token = decodeURIComponent(grant.uploadUrl.split("/").at(-1) ?? "");
    await expect(
      store.putByUploadToken(token, Buffer.from("x"), "image/png", expiresAt),
    ).rejects.toThrow("UPLOAD_TOKEN_EXPIRED");
    await expect(
      store.putByUploadToken(`${token}x`, Buffer.from("x"), "image/png", new Date(0)),
    ).rejects.toThrow("INVALID_UPLOAD_TOKEN");
    await expect(
      store.putByUploadToken("broken", Buffer.from("x"), "image/png", new Date(0)),
    ).rejects.toThrow("INVALID_UPLOAD_TOKEN");
    await expect(
      store.putByUploadToken(token, Buffer.alloc(33), "image/png", new Date(0)),
    ).rejects.toThrow("INVALID_OBJECT_SIZE");
    await expect(
      store.putByUploadToken(token, Buffer.alloc(0), "image/png", new Date(0)),
    ).rejects.toThrow("INVALID_OBJECT_SIZE");
    await expect(
      store.putByUploadToken(token, Buffer.from("x"), "text/plain", new Date(0)),
    ).rejects.toThrow("UNSUPPORTED_CONTENT_TYPE");

    await expect(
      store.putByUploadToken(token, Buffer.from("not-an-image"), "image/png", new Date(0)),
    ).rejects.toThrow("INVALID_IMAGE_SIGNATURE");

    await store.putByUploadToken(token, jpegBytes, "image/jpeg", new Date(0));
    await expect(
      store.putByUploadToken(token, jpegBytes, "image/jpeg", new Date(0)),
    ).rejects.toMatchObject({ code: "EEXIST" });
  });

  it("detects tampered content and rejects path traversal", async () => {
    const grant = store.issueUpload({
      campusId: randomUUID(),
      verificationId: randomUUID(),
      expiresAt: new Date("2026-07-31T12:01:00.000Z"),
    });
    const token = decodeURIComponent(grant.uploadUrl.split("/").at(-1) ?? "");
    await store.putByUploadToken(token, pngBytes, "image/png", new Date(0));
    await writeFile(join(root, ...grant.objectKey.split("/")), "tampered");
    await expect(store.head(grant.objectKey)).rejects.toThrow("OBJECT_INTEGRITY_MISMATCH");
    await expect(store.head("../../secret")).rejects.toThrow("INVALID_OBJECT_KEY");

    await writeFile(`${join(root, ...grant.objectKey.split("/"))}.metadata.json`, "not-json");
    await expect(store.head(grant.objectKey)).rejects.toThrow();
  });

  it("removes a newly written object when metadata persistence fails", async () => {
    const grant = store.issueUpload({
      campusId: randomUUID(),
      verificationId: randomUUID(),
      expiresAt: new Date("2026-07-31T12:01:00.000Z"),
    });
    const token = decodeURIComponent(grant.uploadUrl.split("/").at(-1) ?? "");
    const objectPath = join(root, ...grant.objectKey.split("/"));
    await mkdir(join(objectPath, ".."), { recursive: true });
    await writeFile(`${objectPath}.metadata.json`, "occupied");

    await expect(
      store.putByUploadToken(token, pngBytes, "image/png", new Date(0)),
    ).rejects.toMatchObject({ code: "EEXIST" });
    await expect(readFile(objectPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects weak or invalid configuration", async () => {
    expect(
      () =>
        new LocalVerificationObjectStore({
          rootDirectory: root,
          uploadHmacSecret: "short",
          publicBaseUrl: "http://127.0.0.1:3000",
        }),
    ).toThrow(/HMAC secret/u);
    expect(
      () =>
        new LocalVerificationObjectStore({
          rootDirectory: root,
          uploadHmacSecret: "upload-hmac-secret-that-is-longer-than-thirty-two-bytes",
          publicBaseUrl: "file:///tmp",
        }),
    ).toThrow(/HTTP/u);
    expect(
      () =>
        new LocalVerificationObjectStore({
          rootDirectory: root,
          uploadHmacSecret: "upload-hmac-secret-that-is-longer-than-thirty-two-bytes",
          publicBaseUrl: "http://127.0.0.1:3000",
          maxBytes: 0,
        }),
    ).toThrow(/object limit/u);
    expect(() =>
      store.issueUpload({ campusId: "bad", verificationId: randomUUID(), expiresAt: new Date() }),
    ).toThrow(/campusId/u);
    expect(() =>
      store.issueUpload({ campusId: randomUUID(), verificationId: "bad", expiresAt: new Date() }),
    ).toThrow(/verificationId/u);
    expect(() =>
      store.issueUpload({
        campusId: randomUUID(),
        verificationId: randomUUID(),
        expiresAt: new Date("invalid"),
      }),
    ).toThrow(/expiry/u);

    const path = join(root, "missing.metadata.json");
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

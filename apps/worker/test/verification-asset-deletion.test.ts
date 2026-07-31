import type { VerificationObjectStore } from "@campus/verification";
import { describe, expect, it, vi } from "vitest";
import {
  runVerificationAssetDeletionSweep,
  type VerificationAssetDeletionRepository,
} from "../src/verification-asset-deletion";

const now = new Date("2026-07-31T12:00:00.000Z");

function repository(overrides: Partial<VerificationAssetDeletionRepository> = {}) {
  const base: VerificationAssetDeletionRepository = {
    listDueAssets: vi.fn().mockResolvedValue([]),
    claimAsset: vi.fn().mockResolvedValue(true),
    markAssetDeleted: vi.fn().mockResolvedValue(true),
    releaseAssetClaim: vi.fn().mockResolvedValue(undefined),
    listExactDeletionEvents: vi.fn().mockResolvedValue([]),
    markEventPublished: vi.fn().mockResolvedValue(undefined),
    markEventFailed: vi.fn().mockResolvedValue(undefined),
  };
  return { ...base, ...overrides };
}

function objectStore(deleteImplementation?: (objectKey: string) => Promise<void>) {
  const store: VerificationObjectStore = {
    issueUpload: vi.fn(),
    putByUploadToken: vi.fn(),
    head: vi.fn(),
    read: vi.fn(),
    delete: vi.fn(deleteImplementation ?? (async () => undefined)),
  };
  return store;
}

describe("verification asset deletion sweep", () => {
  it("deletes a due asset before marking the same database object as deleted", async () => {
    const calls: string[] = [];
    const repo = repository({
      listDueAssets: vi.fn().mockResolvedValue([{ id: "asset-1", objectKey: "safe-key" }]),
      markAssetDeleted: vi.fn(async (_id, _key, _now) => {
        calls.push("mark");
        return true;
      }),
    });
    const store = objectStore(async () => {
      calls.push("delete");
    });

    await expect(runVerificationAssetDeletionSweep(repo, store, now)).resolves.toEqual({
      assetsDeleted: 1,
      exactObjectsDeleted: 0,
      failures: 0,
    });
    expect(calls).toEqual(["delete", "mark"]);
    expect(repo.markAssetDeleted).toHaveBeenCalledWith("asset-1", "safe-key", now);
    expect(repo.claimAsset).toHaveBeenCalledWith("asset-1", "safe-key", now);
  });

  it("does not report an asset deleted when the object key changed concurrently", async () => {
    const repo = repository({
      listDueAssets: vi.fn().mockResolvedValue([{ id: "asset-1", objectKey: "old-key" }]),
      markAssetDeleted: vi.fn().mockResolvedValue(false),
    });
    await expect(runVerificationAssetDeletionSweep(repo, objectStore(), now)).resolves.toEqual({
      assetsDeleted: 0,
      exactObjectsDeleted: 0,
      failures: 0,
    });
  });

  it("deletes the exact previous object from a resubmission event", async () => {
    const repo = repository({
      listExactDeletionEvents: vi
        .fn()
        .mockResolvedValue([{ id: "event-1", objectKey: "previous-key" }]),
    });
    const store = objectStore();
    await expect(runVerificationAssetDeletionSweep(repo, store, now)).resolves.toEqual({
      assetsDeleted: 0,
      exactObjectsDeleted: 1,
      failures: 0,
    });
    expect(store.delete).toHaveBeenCalledWith("previous-key");
    expect(repo.markEventPublished).toHaveBeenCalledWith("event-1", now);
  });

  it("retries a failed exact-object deletion without marking it published", async () => {
    const repo = repository({
      listExactDeletionEvents: vi
        .fn()
        .mockResolvedValue([{ id: "event-1", objectKey: "previous-key" }]),
    });
    const store = objectStore(async () => {
      throw new Error("OBJECT_STORE_UNAVAILABLE");
    });
    await expect(runVerificationAssetDeletionSweep(repo, store, now)).resolves.toEqual({
      assetsDeleted: 0,
      exactObjectsDeleted: 0,
      failures: 1,
    });
    expect(repo.markEventPublished).not.toHaveBeenCalled();
    expect(repo.markEventFailed).toHaveBeenCalledWith(
      "event-1",
      new Date("2026-07-31T12:01:00.000Z"),
      "OBJECT_STORE_UNAVAILABLE",
    );
  });

  it("counts a due-asset storage failure and leaves its database row unchanged", async () => {
    const repo = repository({
      listDueAssets: vi.fn().mockResolvedValue([{ id: "asset-1", objectKey: "safe-key" }]),
    });
    const store = objectStore(async () => {
      throw new Error("network details must not escape");
    });
    await expect(runVerificationAssetDeletionSweep(repo, store, now)).resolves.toEqual({
      assetsDeleted: 0,
      exactObjectsDeleted: 0,
      failures: 1,
    });
    expect(repo.markAssetDeleted).not.toHaveBeenCalled();
    expect(repo.releaseAssetClaim).toHaveBeenCalledWith("asset-1", "safe-key", now);
  });

  it("does not delete when another worker or a submission wins the atomic claim", async () => {
    const repo = repository({
      listDueAssets: vi.fn().mockResolvedValue([{ id: "asset-1", objectKey: "safe-key" }]),
      claimAsset: vi.fn().mockResolvedValue(false),
    });
    const store = objectStore();
    await expect(runVerificationAssetDeletionSweep(repo, store, now)).resolves.toEqual({
      assetsDeleted: 0,
      exactObjectsDeleted: 0,
      failures: 0,
    });
    expect(store.delete).not.toHaveBeenCalled();
  });
});

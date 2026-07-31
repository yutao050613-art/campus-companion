import type { PrismaClient } from "@campus/database";
import { OutboxStatus } from "@campus/database";
import type { VerificationObjectStore } from "@campus/verification";

const DELETE_OBJECT_EVENT = "VERIFICATION_ASSET_DELETE_OBJECT";
const SWEEP_LIMIT = 50;
const STALE_CLAIM_MS = 5 * 60 * 1_000;

interface DueAsset {
  readonly id: string;
  readonly objectKey: string;
}

interface ExactDeletionEvent {
  readonly id: string;
  readonly objectKey: string;
}

export interface VerificationAssetDeletionRepository {
  listDueAssets(now: Date): Promise<readonly DueAsset[]>;
  claimAsset(assetId: string, objectKey: string, now: Date): Promise<boolean>;
  markAssetDeleted(assetId: string, objectKey: string, claimedAt: Date): Promise<boolean>;
  releaseAssetClaim(assetId: string, objectKey: string, claimedAt: Date): Promise<void>;
  listExactDeletionEvents(now: Date): Promise<readonly ExactDeletionEvent[]>;
  markEventPublished(eventId: string, now: Date): Promise<void>;
  markEventFailed(eventId: string, retryAt: Date, errorCode: string): Promise<void>;
}

export interface AssetDeletionSweepResult {
  readonly assetsDeleted: number;
  readonly exactObjectsDeleted: number;
  readonly failures: number;
}

export class PrismaVerificationAssetDeletionRepository
  implements VerificationAssetDeletionRepository
{
  public constructor(private readonly prisma: PrismaClient) {}

  public listDueAssets(now: Date): Promise<readonly DueAsset[]> {
    return this.prisma.verificationAsset.findMany({
      where: {
        deletedAt: null,
        deleteAfter: { lte: now },
        OR: [
          { deletionClaimedAt: null },
          { deletionClaimedAt: { lte: new Date(now.getTime() - STALE_CLAIM_MS) } },
        ],
      },
      select: { id: true, objectKey: true },
      orderBy: [{ deleteAfter: "asc" }, { id: "asc" }],
      take: SWEEP_LIMIT,
    });
  }

  public async claimAsset(assetId: string, objectKey: string, now: Date): Promise<boolean> {
    const result = await this.prisma.verificationAsset.updateMany({
      where: {
        id: assetId,
        objectKey,
        deletedAt: null,
        deleteAfter: { lte: now },
        OR: [
          { deletionClaimedAt: null },
          { deletionClaimedAt: { lte: new Date(now.getTime() - STALE_CLAIM_MS) } },
        ],
      },
      data: { deletionClaimedAt: now },
    });
    return result.count === 1;
  }

  public async markAssetDeleted(
    assetId: string,
    objectKey: string,
    claimedAt: Date,
  ): Promise<boolean> {
    const result = await this.prisma.verificationAsset.updateMany({
      where: { id: assetId, objectKey, deletedAt: null, deletionClaimedAt: claimedAt },
      data: { deletedAt: claimedAt, deletionClaimedAt: null },
    });
    return result.count === 1;
  }

  public async releaseAssetClaim(
    assetId: string,
    objectKey: string,
    claimedAt: Date,
  ): Promise<void> {
    await this.prisma.verificationAsset.updateMany({
      where: { id: assetId, objectKey, deletedAt: null, deletionClaimedAt: claimedAt },
      data: { deletionClaimedAt: null },
    });
  }

  public async listExactDeletionEvents(now: Date): Promise<readonly ExactDeletionEvent[]> {
    const events = await this.prisma.outboxEvent.findMany({
      where: {
        eventType: DELETE_OBJECT_EVENT,
        status: { in: [OutboxStatus.PENDING, OutboxStatus.FAILED] },
        availableAt: { lte: now },
      },
      select: { id: true, payload: true },
      orderBy: [{ availableAt: "asc" }, { id: "asc" }],
      take: SWEEP_LIMIT,
    });
    return events.map((event) => ({ id: event.id, objectKey: parseObjectKey(event.payload) }));
  }

  public async markEventPublished(eventId: string, now: Date): Promise<void> {
    await this.prisma.outboxEvent.updateMany({
      where: {
        id: eventId,
        status: { in: [OutboxStatus.PENDING, OutboxStatus.FAILED] },
      },
      data: {
        status: OutboxStatus.PUBLISHED,
        publishedAt: now,
        attempts: { increment: 1 },
        lastErrorCode: null,
      },
    });
  }

  public async markEventFailed(eventId: string, retryAt: Date, errorCode: string): Promise<void> {
    await this.prisma.outboxEvent.updateMany({
      where: {
        id: eventId,
        status: { in: [OutboxStatus.PENDING, OutboxStatus.FAILED] },
      },
      data: {
        status: OutboxStatus.FAILED,
        availableAt: retryAt,
        attempts: { increment: 1 },
        lastErrorCode: errorCode,
      },
    });
  }
}

export async function runVerificationAssetDeletionSweep(
  repository: VerificationAssetDeletionRepository,
  objectStore: VerificationObjectStore,
  now = new Date(),
): Promise<AssetDeletionSweepResult> {
  let assetsDeleted = 0;
  let exactObjectsDeleted = 0;
  let failures = 0;

  for (const event of await repository.listExactDeletionEvents(now)) {
    try {
      await objectStore.delete(event.objectKey);
      await repository.markEventPublished(event.id, now);
      exactObjectsDeleted += 1;
    } catch (error) {
      failures += 1;
      await repository.markEventFailed(
        event.id,
        new Date(now.getTime() + 60_000),
        safeDeletionErrorCode(error),
      );
    }
  }

  for (const asset of await repository.listDueAssets(now)) {
    if (!(await repository.claimAsset(asset.id, asset.objectKey, now))) continue;
    try {
      await objectStore.delete(asset.objectKey);
      if (await repository.markAssetDeleted(asset.id, asset.objectKey, now)) assetsDeleted += 1;
    } catch {
      failures += 1;
      await repository.releaseAssetClaim(asset.id, asset.objectKey, now);
    }
  }
  return { assetsDeleted, exactObjectsDeleted, failures };
}

function parseObjectKey(payload: unknown): string {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload) ||
    Object.keys(payload).length !== 1 ||
    typeof (payload as Record<string, unknown>)["objectKey"] !== "string"
  ) {
    throw new Error("INVALID_VERIFICATION_ASSET_DELETE_EVENT");
  }
  return (payload as { readonly objectKey: string }).objectKey;
}

function safeDeletionErrorCode(error: unknown): string {
  if (error instanceof Error && /^[A-Z0-9_]{1,100}$/.test(error.message)) return error.message;
  return "VERIFICATION_ASSET_DELETE_FAILED";
}

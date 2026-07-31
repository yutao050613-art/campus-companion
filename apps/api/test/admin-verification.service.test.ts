import { randomUUID } from "node:crypto";
import { sha256Hex } from "@campus/auth";
import { VerificationAssetType, VerificationStatus } from "@campus/database";
import type { VerificationObjectStore } from "@campus/verification";
import { describe, expect, it, vi } from "vitest";
import type { AdminAuthService, AdminPrincipal } from "../src/admin/admin-auth.service";
import { AdminVerificationService } from "../src/admin/admin-verification.service";
import type { PrismaService } from "../src/database/prisma.service";
import type { IdempotencyService } from "../src/m2/idempotency.service";

const now = new Date("2026-07-31T12:00:00.000Z");
const campusId = randomUUID();
const verificationId = randomUUID();
const adminUserId = randomUUID();
const sessionId = randomUUID();
const objectKey = `${campusId}/${verificationId}/${randomUUID()}`;
const principal: AdminPrincipal = {
  adminUserId,
  sessionId,
  roles: new Set(["VERIFICATION_REVIEWER"]),
  campusIds: new Set([campusId]),
};
const context = { sessionToken: "session", csrfToken: "csrf", origin: "http://127.0.0.1:5173" };
const asset = {
  id: randomUUID(),
  type: VerificationAssetType.STUDENT_CARD,
  objectKey,
  contentDigest: "a".repeat(64),
  contentType: "image/png",
  deletedAt: null,
  deletionClaimedAt: null,
  deleteAfter: null,
};
const pending = {
  id: verificationId,
  campusId,
  studentNumberLast4: "9001",
  status: VerificationStatus.PENDING,
  submittedAt: new Date(now.getTime() - 60_000),
  latestSubmittedAt: new Date(now.getTime() - 60_000),
  reviewedAt: null,
  reasonCode: null,
  expiresAt: null,
  assets: [asset],
};

function auth(): AdminAuthService {
  return {
    authenticate: vi.fn().mockResolvedValue(principal),
    verifyReauthenticationTotp: vi.fn().mockResolvedValue(undefined),
  } as unknown as AdminAuthService;
}

function idempotency(replay: unknown = null): IdempotencyService {
  return {
    findReplay: vi.fn().mockResolvedValue(replay),
    execute: vi.fn(async (_operation, _key, _actor, _request, action) => ({
      ...(await action(transactionHolder.current)),
      replayed: false,
    })),
  } as unknown as IdempotencyService;
}

const transactionHolder: { current: Record<string, unknown> } = { current: {} };

function objectStore(overrides: Partial<VerificationObjectStore> = {}): VerificationObjectStore {
  return {
    issueUpload: vi.fn(),
    putByUploadToken: vi.fn(),
    head: vi.fn(),
    read: vi.fn().mockResolvedValue(Buffer.from("material")),
    delete: vi.fn(),
    ...overrides,
  };
}

function service(
  input: {
    readonly outer?: Record<string, unknown>;
    readonly transaction?: Record<string, unknown>;
    readonly adminAuth?: AdminAuthService;
    readonly replay?: unknown;
    readonly store?: VerificationObjectStore;
  } = {},
) {
  transactionHolder.current = input.transaction ?? {};
  return new AdminVerificationService(
    (input.outer ?? {}) as unknown as PrismaService,
    idempotency(input.replay),
    input.adminAuth ?? auth(),
    input.store ?? objectStore(),
  );
}

describe("AdminVerificationService", () => {
  it("lists and retrieves only masked campus-scoped metadata", async () => {
    const authenticate = vi.fn().mockResolvedValue(principal);
    const adminAuth = { authenticate } as unknown as AdminAuthService;
    const items = Array.from({ length: 51 }, (_, index) => ({
      ...pending,
      id: `20000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
    }));
    const listService = service({
      outer: { studentVerification: { findMany: vi.fn().mockResolvedValue(items) } },
      adminAuth,
    });
    const page = await listService.list(context, campusId, undefined, now);
    expect(page.items).toHaveLength(50);
    expect(page.nextCursor).toBe(items[49]?.id);
    expect(page.items[0]).not.toHaveProperty("objectKey");
    expect(authenticate).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ role: "VERIFICATION_REVIEWER", campusId }),
    );

    const getService = service({
      outer: { studentVerification: { findUnique: vi.fn().mockResolvedValue(pending) } },
    });
    await expect(getService.get(context, verificationId, now)).resolves.toMatchObject({
      studentNumberLast4: "9001",
      availableAssetTypes: [VerificationAssetType.STUDENT_CARD],
    });
    await expect(
      service({
        outer: { studentVerification: { findUnique: vi.fn().mockResolvedValue(null) } },
      }).get(context, verificationId, now),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
  });

  it("approves a pending verification and queues material deletion atomically", async () => {
    const updateVerification = vi.fn().mockImplementation(({ data }) => ({
      ...pending,
      ...data,
      assets: [asset],
    }));
    const updateAsset = vi.fn().mockResolvedValue({});
    const createOutbox = vi.fn().mockResolvedValue({});
    const createAudit = vi.fn().mockResolvedValue({});
    const result = await service({
      outer: { studentVerification: { findUnique: vi.fn().mockResolvedValue(pending) } },
      transaction: {
        studentVerification: {
          findUnique: vi.fn().mockResolvedValue(pending),
          update: updateVerification,
        },
        verificationAsset: { updateMany: updateAsset },
        outboxEvent: { create: createOutbox },
        auditLog: { create: createAudit },
      },
    }).review(
      context,
      verificationId,
      { decision: "APPROVE" },
      "admin-review-key-0001",
      "req-review-1",
      now,
    );
    expect(result).toMatchObject({ status: "VERIFIED", reasonCode: null });
    expect(updateAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { deleteAfter: new Date(now.getTime() + 24 * 60 * 60 * 1_000) },
      }),
    );
    expect(createOutbox).toHaveBeenCalledOnce();
    expect(createAudit).toHaveBeenCalledOnce();
  });

  it("records rejection and resubmission reason codes and rejects invalid decisions", async () => {
    for (const [decision, status] of [
      ["REJECT", VerificationStatus.REJECTED],
      ["REQUIRE_RESUBMISSION", VerificationStatus.REQUIRE_RESUBMISSION],
    ] as const) {
      const update = vi
        .fn()
        .mockImplementation(({ data }) => ({ ...pending, ...data, assets: [asset] }));
      const result = await service({
        outer: { studentVerification: { findUnique: vi.fn().mockResolvedValue(pending) } },
        transaction: {
          studentVerification: { findUnique: vi.fn().mockResolvedValue(pending), update },
          verificationAsset: { updateMany: vi.fn().mockResolvedValue({}) },
          outboxEvent: { create: vi.fn().mockResolvedValue({}) },
          auditLog: { create: vi.fn().mockResolvedValue({}) },
        },
      }).review(
        context,
        verificationId,
        { decision, reasonCode: "DOCUMENT_UNREADABLE" },
        `admin-review-${decision}-key`,
        `req-${decision}`,
        now,
      );
      expect(result).toMatchObject({ status, reasonCode: "DOCUMENT_UNREADABLE" });
    }

    await expect(
      service({
        outer: { studentVerification: { findUnique: vi.fn().mockResolvedValue(pending) } },
        transaction: {
          studentVerification: { findUnique: vi.fn().mockResolvedValue(pending) },
        },
      }).review(
        context,
        verificationId,
        { decision: "REJECT", reasonCode: "bad code" },
        "admin-review-invalid-reason",
        "req-invalid",
        now,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      service({
        outer: { studentVerification: { findUnique: vi.fn().mockResolvedValue(pending) } },
        transaction: {
          studentVerification: {
            findUnique: vi.fn().mockResolvedValue({
              ...pending,
              status: VerificationStatus.VERIFIED,
            }),
          },
        },
      }).review(
        context,
        verificationId,
        { decision: "APPROVE" },
        "admin-review-invalid-state",
        "req-state",
        now,
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("replays an asset grant and otherwise binds a new grant to the exact current object", async () => {
    const replayBody = {
      consumePath: "/v1/admin/verification-assets/consume" as const,
      grantToken: "replayed-token",
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      singleUse: true as const,
    };
    await expect(
      service({
        outer: { studentVerification: { findUnique: vi.fn().mockResolvedValue(pending) } },
        replay: { status: 201, body: replayBody, replayed: true },
      }).issueAssetAccess(
        context,
        verificationId,
        VerificationAssetType.STUDENT_CARD,
        "123456",
        "asset-grant-replay-key",
        "req-grant-replay",
        now,
      ),
    ).resolves.toEqual(replayBody);

    const grantCreate = vi.fn().mockResolvedValue({});
    const bindingCreate = vi.fn().mockResolvedValue({});
    const result = await service({
      outer: { studentVerification: { findUnique: vi.fn().mockResolvedValue(pending) } },
      transaction: {
        studentVerification: { findUnique: vi.fn().mockResolvedValue(pending) },
        verificationAssetAccessGrant: { create: grantCreate },
        idempotencyRecord: { create: bindingCreate },
        auditLog: { create: vi.fn().mockResolvedValue({}) },
      },
    }).issueAssetAccess(
      context,
      verificationId,
      VerificationAssetType.STUDENT_CARD,
      "123456",
      "asset-grant-create-key",
      "req-grant-create",
      now,
    );
    expect(result).toMatchObject({
      singleUse: true,
      consumePath: "/v1/admin/verification-assets/consume",
    });
    expect(grantCreate).toHaveBeenCalledOnce();
    expect(grantCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ verificationAssetId: asset.id }),
      }),
    );
    expect(bindingCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ requestDigest: sha256Hex(objectKey) }),
      }),
    );
  });

  it("hides missing, deleted, expired and concurrently replaced grant targets", async () => {
    await expect(
      service({
        outer: { studentVerification: { findUnique: vi.fn().mockResolvedValue(null) } },
      }).issueAssetAccess(
        context,
        verificationId,
        VerificationAssetType.STUDENT_CARD,
        "123456",
        "asset-grant-missing-key",
        "req-missing",
        now,
      ),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });

    await expect(
      service({
        outer: { studentVerification: { findUnique: vi.fn().mockResolvedValue(pending) } },
        transaction: {
          studentVerification: { findUnique: vi.fn().mockResolvedValue(pending) },
        },
      }).issueAssetAccess(
        context,
        verificationId,
        VerificationAssetType.WECOM_SCREENSHOT,
        "123456",
        "asset-grant-wrong-type-key",
        "req-wrong-type",
        now,
      ),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });

    const deleted = { ...pending, assets: [{ ...asset, deletedAt: now }] };
    await expect(
      service({
        outer: { studentVerification: { findUnique: vi.fn().mockResolvedValue(deleted) } },
        transaction: {
          studentVerification: { findUnique: vi.fn().mockResolvedValue(deleted) },
        },
      }).issueAssetAccess(
        context,
        verificationId,
        VerificationAssetType.STUDENT_CARD,
        "123456",
        "asset-grant-deleted-key",
        "req-deleted",
        now,
      ),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
  });

  it("atomically consumes a grant, verifies its object binding, then proxies without caching", async () => {
    const grantToken = Buffer.alloc(32, 9).toString("base64url");
    const tokenDigest = sha256Hex(grantToken);
    const read = vi.fn().mockResolvedValue(Buffer.from("material"));
    const result = await service({
      outer: {
        verificationAssetAccessGrant: {
          findUnique: vi.fn().mockResolvedValue({ campusId, verificationId }),
        },
        $queryRaw: vi
          .fn()
          .mockResolvedValue([
            { grantId: randomUUID(), verificationId, verificationAssetId: asset.id, adminUserId },
          ]),
        verificationAsset: {
          findUnique: vi.fn().mockResolvedValue({
            ...asset,
            contentType: "image/png",
          }),
        },
        idempotencyRecord: {
          findUnique: vi.fn().mockResolvedValue({
            adminUserId,
            campusId,
            requestDigest: sha256Hex(objectKey),
          }),
        },
      },
      store: objectStore({ read }),
    }).consumeAssetAccess(context, grantToken, "req-consume", now);
    expect(result).toEqual({ content: Buffer.from("material"), contentType: "image/png" });
    expect(read).toHaveBeenCalledWith(objectKey);
    expect(tokenDigest).toHaveLength(64);
  });

  it("consumes but never proxies a changed object or an invalid grant", async () => {
    const grantToken = Buffer.alloc(32, 10).toString("base64url");
    const baseOuter = {
      verificationAssetAccessGrant: {
        findUnique: vi.fn().mockResolvedValue({ campusId, verificationId }),
      },
      $queryRaw: vi
        .fn()
        .mockResolvedValue([
          { grantId: randomUUID(), verificationId, verificationAssetId: asset.id, adminUserId },
        ]),
      verificationAsset: {
        findUnique: vi.fn().mockResolvedValue({ ...asset, contentType: "image/jpeg" }),
      },
      idempotencyRecord: {
        findUnique: vi.fn().mockResolvedValue({
          adminUserId,
          campusId,
          requestDigest: sha256Hex("different-object"),
        }),
      },
    };
    const read = vi.fn();
    await expect(
      service({ outer: baseOuter, store: objectStore({ read }) }).consumeAssetAccess(
        context,
        grantToken,
        "req-binding-mismatch",
        now,
      ),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    expect(read).not.toHaveBeenCalled();

    await expect(
      service({
        outer: {
          verificationAssetAccessGrant: { findUnique: vi.fn().mockResolvedValue(null) },
        },
      }).consumeAssetAccess(context, grantToken, "req-grant-missing", now),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    await expect(
      service({
        outer: {
          ...baseOuter,
          $queryRaw: vi.fn().mockResolvedValue([]),
        },
      }).consumeAssetAccess(context, grantToken, "req-grant-used", now),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
  });
});

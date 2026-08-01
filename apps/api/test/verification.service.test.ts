import { randomUUID } from "node:crypto";
import { normalizeAndDigestStudentNumber } from "@campus/auth";
import { GenderDeclaration, VerificationAssetType, VerificationStatus } from "@campus/database";
import type { VerificationObjectStore } from "@campus/verification";
import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedUser } from "../src/auth/auth.service";
import type { AppConfig } from "../src/config";
import type { PrismaService } from "../src/database/prisma.service";
import type { IdempotencyService } from "../src/m2/idempotency.service";
import {
  type VerificationResponse,
  VerificationService,
} from "../src/verification/verification.service";

const now = new Date("2026-07-31T12:00:00.000Z");
const principal: AuthenticatedUser = {
  userId: randomUUID(),
  sessionId: randomUUID(),
  campusId: randomUUID(),
};
const verificationId = randomUUID();
const objectKey = `${principal.campusId}/${verificationId}/${randomUUID()}`;
const uploadExpiresAt = new Date(now.getTime() + 60_000);
const studentCardAsset = {
  id: randomUUID(),
  type: VerificationAssetType.STUDENT_CARD,
  objectKey,
  uploadExpiresAt,
  deleteAfter: uploadExpiresAt,
  deletedAt: null,
  deletionClaimedAt: null,
};
const baseVerification = {
  id: verificationId,
  userId: principal.userId,
  campusId: principal.campusId,
  studentNumberLast4: "9001",
  status: VerificationStatus.AWAITING_UPLOAD,
  submittedAt: null,
  latestSubmittedAt: null,
  reviewedAt: null,
  expiresAt: null,
  reasonCode: null,
  assets: [studentCardAsset],
};

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    nodeEnv: "test",
    port: 3000,
    version: "test",
    logLevel: "silent",
    wechatAuthProvider: "mock",
    paymentProvider: "mock",
    wechatMockDefaultCampusId: principal.campusId,
    wechatMockSigningSecret: "mock-secret-that-is-longer-than-thirty-two-bytes",
    accessTokenSecret: "access-secret-that-is-longer-than-thirty-two-bytes",
    studentNumberHmacSecret: "student-secret-that-is-longer-than-thirty-two-bytes",
    dataEncryptionKeyBase64: Buffer.alloc(32).toString("base64"),
    dataEncryptionKeyVersion: "test",
    localObjectUploadSecret: "upload-secret-that-is-longer-than-thirty-two-bytes",
    localObjectStoreRoot: "D:\\test",
    publicApiBaseUrl: "http://127.0.0.1:3000",
    adminTrustedOrigins: new Set(),
    ...overrides,
  };
}

function store(overrides: Partial<VerificationObjectStore> = {}): VerificationObjectStore {
  return {
    issueUpload: vi.fn().mockReturnValue({
      objectKey,
      uploadUrl: "http://127.0.0.1:3000/v1/mock/upload-token",
      uploadExpiresAt,
    }),
    putByUploadToken: vi.fn(),
    head: vi.fn().mockResolvedValue({
      contentType: "image/png",
      sizeBytes: 8,
      contentDigest: "a".repeat(64),
    }),
    read: vi.fn(),
    delete: vi.fn(),
    ...overrides,
  };
}

function idempotency(replay: unknown = null): IdempotencyService {
  return {
    findReplay: vi.fn().mockResolvedValue(replay),
    execute: vi.fn(async (_operation, _key, _actor, _request, action, actionNow) => ({
      ...(await action(actionNow === undefined ? {} : transactionHolder.current)),
      replayed: false,
    })),
  } as unknown as IdempotencyService;
}

const transactionHolder: { current: Record<string, unknown> } = { current: {} };

function prisma(outer: Record<string, unknown> = {}): PrismaService {
  return {
    ...outer,
    $transaction: async (action: (transaction: unknown) => unknown) => action(outer),
  } as unknown as PrismaService;
}

function service(
  input: {
    readonly outer?: Record<string, unknown>;
    readonly transaction?: Record<string, unknown>;
    readonly objectStore?: VerificationObjectStore;
    readonly replay?: unknown;
    readonly appConfig?: AppConfig;
  } = {},
): VerificationService {
  transactionHolder.current = input.transaction ?? {};
  return new VerificationService(
    prisma(input.outer),
    idempotency(input.replay),
    input.appConfig ?? config(),
    input.objectStore ?? store(),
  );
}

describe("VerificationService", () => {
  it("creates a draft with HMAC identity, consent and a private upload grant", async () => {
    const updateUser = vi.fn().mockResolvedValue({});
    const createVerification = vi.fn().mockResolvedValue(baseVerification);
    const result = await service({
      transaction: {
        policyVersion: { findFirst: vi.fn().mockResolvedValue({ id: randomUUID() }) },
        studentVerification: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: createVerification,
        },
        user: { update: updateUser },
      },
    }).create(
      principal,
      {
        campusId: principal.campusId,
        studentNumber: "m2student9001",
        genderDeclaration: GenderDeclaration.UNDISCLOSED,
        sensitiveInfoConsentVersion: "sensitive-v1",
        evidenceTypes: [VerificationAssetType.STUDENT_CARD],
      },
      "create-verification-key-0001",
      now,
    );
    expect(result.verification).toMatchObject({ id: verificationId, status: "AWAITING_UPLOAD" });
    expect(result.uploads[0]?.uploadUrl).not.toContain(objectKey);
    expect(updateUser).toHaveBeenCalledOnce();
    expect(createVerification).toHaveBeenCalledOnce();
  });

  it("creates and submits both independently typed evidence assets", async () => {
    const wecomObjectKey = `${principal.campusId}/${verificationId}/${randomUUID()}`;
    const wecomAsset = {
      ...studentCardAsset,
      id: randomUUID(),
      type: VerificationAssetType.WECOM_SCREENSHOT,
      objectKey: wecomObjectKey,
    };
    const dualVerification = { ...baseVerification, assets: [studentCardAsset, wecomAsset] };
    const issueUpload = vi
      .fn()
      .mockReturnValueOnce({
        objectKey,
        uploadUrl: "http://127.0.0.1/upload/student-card",
        uploadExpiresAt,
      })
      .mockReturnValueOnce({
        objectKey: wecomObjectKey,
        uploadUrl: "http://127.0.0.1/upload/wecom",
        uploadExpiresAt,
      });
    const objectStore = store({
      issueUpload,
      head: vi.fn().mockResolvedValue({
        contentType: "image/png",
        sizeBytes: 8,
        contentDigest: "a".repeat(64),
      }),
    });
    const created = await service({
      objectStore,
      transaction: {
        policyVersion: { findFirst: vi.fn().mockResolvedValue({ id: randomUUID() }) },
        studentVerification: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue(dualVerification),
        },
        user: { update: vi.fn().mockResolvedValue({}) },
      },
    }).create(
      principal,
      {
        campusId: principal.campusId,
        studentNumber: "M2STUDENT9001",
        genderDeclaration: GenderDeclaration.UNDISCLOSED,
        sensitiveInfoConsentVersion: "sensitive-v1",
        evidenceTypes: [VerificationAssetType.WECOM_SCREENSHOT, VerificationAssetType.STUDENT_CARD],
      },
      "create-dual-evidence-key",
      now,
    );
    expect(created.uploads.map((upload) => upload.type)).toEqual([
      VerificationAssetType.STUDENT_CARD,
      VerificationAssetType.WECOM_SCREENSHOT,
    ]);
    expect(created).not.toHaveProperty("objectKey");
    expect(created.uploads[0]).not.toHaveProperty("objectKey");

    const updateAsset = vi.fn().mockResolvedValue({ count: 1 });
    const pendingDual = {
      ...dualVerification,
      status: VerificationStatus.PENDING,
      submittedAt: now,
      latestSubmittedAt: now,
    };
    const submitted = await service({
      objectStore,
      outer: { studentVerification: { findFirst: vi.fn().mockResolvedValue(dualVerification) } },
      transaction: {
        studentVerification: {
          findFirst: vi.fn().mockResolvedValue(dualVerification),
          update: vi.fn().mockResolvedValue(pendingDual),
        },
        verificationAsset: { updateMany: updateAsset },
      },
    }).submit(
      principal,
      verificationId,
      [
        { type: VerificationAssetType.WECOM_SCREENSHOT, uploadEtag: "a".repeat(64) },
        { type: VerificationAssetType.STUDENT_CARD, uploadEtag: "a".repeat(64) },
      ],
      "submit-dual-evidence-key",
      now,
    );
    expect(submitted.evidenceTypes).toEqual([
      VerificationAssetType.STUDENT_CARD,
      VerificationAssetType.WECOM_SCREENSHOT,
    ]);
    expect(updateAsset).toHaveBeenCalledTimes(2);
    for (const call of updateAsset.mock.calls) {
      expect(call[0]).toMatchObject({ data: { deleteAfter: null } });
    }
  });

  it("rejects cross-campus, weak hashing, inactive consent and active applications", async () => {
    const input = {
      campusId: principal.campusId,
      studentNumber: "M2STUDENT9001",
      genderDeclaration: GenderDeclaration.FEMALE,
      sensitiveInfoConsentVersion: "sensitive-v1",
      evidenceTypes: [VerificationAssetType.STUDENT_CARD],
    };
    await expect(
      service().create(
        principal,
        { ...input, campusId: randomUUID() },
        "create-key-cross-campus",
        now,
      ),
    ).rejects.toMatchObject({ code: "RESOURCE_FORBIDDEN" });
    await expect(
      service({ appConfig: config({ studentNumberHmacSecret: "short" }) }).create(
        principal,
        input,
        "create-key-weak-secret",
        now,
      ),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    await expect(
      service({
        transaction: { policyVersion: { findFirst: vi.fn().mockResolvedValue(null) } },
      }).create(principal, input, "create-key-policy-invalid", now),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      service({
        transaction: {
          policyVersion: { findFirst: vi.fn().mockResolvedValue({ id: randomUUID() }) },
          studentVerification: {
            findFirst: vi.fn().mockResolvedValue({ status: VerificationStatus.PENDING }),
          },
        },
      }).create(principal, input, "create-key-active-existing", now),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("reuses a rejected credential for the same identity and retires its previous object", async () => {
    const identity = normalizeAndDigestStudentNumber(
      "M2STUDENT9001",
      config().studentNumberHmacSecret,
    );
    const previousKey = `${principal.campusId}/${verificationId}/${randomUUID()}`;
    const current = {
      ...baseVerification,
      status: VerificationStatus.REJECTED,
      studentNumberDigest: identity.digest,
      assets: [{ ...studentCardAsset, objectKey: previousKey }],
    };
    const update = vi.fn().mockResolvedValue(baseVerification);
    const upsert = vi.fn().mockResolvedValue({});
    const outbox = vi.fn().mockResolvedValue({});
    const result = await service({
      transaction: {
        policyVersion: { findFirst: vi.fn().mockResolvedValue({ id: randomUUID() }) },
        studentVerification: { findFirst: vi.fn().mockResolvedValue(current), update },
        user: { update: vi.fn().mockResolvedValue({}) },
        verificationAsset: { upsert },
        outboxEvent: { create: outbox },
      },
    }).create(
      principal,
      {
        campusId: principal.campusId,
        studentNumber: "M2STUDENT9001",
        genderDeclaration: GenderDeclaration.UNDISCLOSED,
        sensitiveInfoConsentVersion: "sensitive-v1",
        evidenceTypes: [VerificationAssetType.STUDENT_CARD],
      },
      "create-reverification-key-0001",
      now,
    );
    expect(result.verification.id).toBe(verificationId);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: VerificationStatus.AWAITING_UPLOAD,
          submittedAt: null,
          reviewedAt: null,
        }),
      }),
    );
    expect(upsert).toHaveBeenCalledOnce();
    expect(outbox).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ payload: { objectKey: previousKey } }),
      }),
    );

    await expect(
      service({
        transaction: {
          policyVersion: { findFirst: vi.fn().mockResolvedValue({ id: randomUUID() }) },
          studentVerification: {
            findFirst: vi
              .fn()
              .mockResolvedValue({ ...current, studentNumberDigest: "0".repeat(64) }),
          },
        },
      }).create(
        principal,
        {
          campusId: principal.campusId,
          studentNumber: "M2STUDENT9001",
          genderDeclaration: GenderDeclaration.UNDISCLOSED,
          sensitiveInfoConsentVersion: "sensitive-v1",
          evidenceTypes: [VerificationAssetType.STUDENT_CARD],
        },
        "create-reverification-different-identity",
        now,
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("returns current status and atomically marks an expired credential", async () => {
    const valid = service({
      outer: {
        studentVerification: { findFirst: vi.fn().mockResolvedValue(baseVerification) },
      },
    });
    await expect(valid.current(principal, now)).resolves.toMatchObject({
      status: "AWAITING_UPLOAD",
    });

    const update = vi.fn().mockResolvedValue({
      ...baseVerification,
      status: VerificationStatus.VERIFICATION_EXPIRED,
      reasonCode: "CREDENTIAL_EXPIRED",
      expiresAt: now,
    });
    const expired = service({
      outer: {
        studentVerification: {
          findFirst: vi.fn().mockResolvedValue({
            ...baseVerification,
            status: VerificationStatus.VERIFIED,
            expiresAt: now,
          }),
          update,
        },
      },
    });
    await expect(expired.current(principal, now)).resolves.toMatchObject({
      status: "VERIFICATION_EXPIRED",
    });
    expect(update).toHaveBeenCalledOnce();
    await expect(
      service({
        outer: { studentVerification: { findFirst: vi.fn().mockResolvedValue(null) } },
      }).current(principal, now),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
  });

  it("replays a successful submission before checking an expired or deleted object", async () => {
    const body: VerificationResponse = {
      id: verificationId,
      campusId: principal.campusId,
      studentNumberLast4: "9001",
      status: VerificationStatus.PENDING,
      submittedAt: now.toISOString(),
      latestSubmittedAt: now.toISOString(),
      reviewedAt: null,
      expiresAt: null,
      reasonCode: null,
      evidenceTypes: [VerificationAssetType.STUDENT_CARD],
    };
    await expect(
      service({ replay: { status: 202, body, replayed: true } }).submit(
        principal,
        verificationId,
        [{ type: VerificationAssetType.STUDENT_CARD, uploadEtag: "a".repeat(64) }],
        "submit-replay-key-0001",
        now,
      ),
    ).resolves.toEqual(body);
  });

  it("expires upload credentials and rejects missing or mismatched objects", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const updateAsset = vi.fn().mockResolvedValue({});
    const expiredAsset = {
      ...studentCardAsset,
      uploadExpiresAt: now,
    };
    await expect(
      service({
        outer: {
          studentVerification: {
            findFirst: vi.fn().mockResolvedValue({ ...baseVerification, assets: [expiredAsset] }),
            updateMany,
          },
          verificationAsset: { updateMany: updateAsset },
        },
      }).submit(
        principal,
        verificationId,
        [{ type: VerificationAssetType.STUDENT_CARD, uploadEtag: "a".repeat(64) }],
        "submit-expired-key-0001",
        now,
      ),
    ).rejects.toMatchObject({ code: "VERIFICATION_UPLOAD_EXPIRED" });
    expect(updateMany).toHaveBeenCalledOnce();
    expect(updateAsset).toHaveBeenCalledOnce();

    await expect(
      service({
        outer: { studentVerification: { findFirst: vi.fn().mockResolvedValue(null) } },
      }).submit(
        principal,
        verificationId,
        [{ type: VerificationAssetType.STUDENT_CARD, uploadEtag: "a".repeat(64) }],
        "submit-missing-key-0001",
        now,
      ),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });

    await expect(
      service({
        outer: {
          studentVerification: {
            findFirst: vi.fn().mockResolvedValue({
              ...baseVerification,
              assets: [studentCardAsset],
            }),
          },
        },
        objectStore: store({ head: vi.fn().mockResolvedValue(null) }),
      }).submit(
        principal,
        verificationId,
        [{ type: VerificationAssetType.STUDENT_CARD, uploadEtag: "a".repeat(64) }],
        "submit-invalid-key-0001",
        now,
      ),
    ).rejects.toMatchObject({ code: "VERIFICATION_ASSET_INVALID" });
  });

  it("submits initial and replacement material while preserving audit times", async () => {
    for (const [initialStatus, expectedStatus] of [
      [VerificationStatus.AWAITING_UPLOAD, VerificationStatus.PENDING],
      [VerificationStatus.RESUBMISSION_AWAITING_UPLOAD, VerificationStatus.RESUBMISSION_PENDING],
    ] as const) {
      const updated = {
        ...baseVerification,
        status: expectedStatus,
        submittedAt: now,
        latestSubmittedAt: now,
      };
      const update = vi.fn().mockResolvedValue(updated);
      const assetUpdate = vi.fn().mockResolvedValue({ count: 1 });
      const candidate = {
        ...baseVerification,
        status: initialStatus,
        assets: [studentCardAsset],
      };
      const result = await service({
        outer: { studentVerification: { findFirst: vi.fn().mockResolvedValue(candidate) } },
        transaction: {
          studentVerification: { findFirst: vi.fn().mockResolvedValue(candidate), update },
          verificationAsset: { updateMany: assetUpdate },
        },
      }).submit(
        principal,
        verificationId,
        [{ type: VerificationAssetType.STUDENT_CARD, uploadEtag: "a".repeat(64) }],
        `submit-happy-key-${initialStatus}`,
        now,
      );
      expect(result.status).toBe(expectedStatus);
      expect(assetUpdate).toHaveBeenCalledOnce();
    }
  });

  it("creates a replacement upload and queues exact deletion of the previous object", async () => {
    const previousKey = `${principal.campusId}/${verificationId}/${randomUUID()}`;
    const candidate = {
      ...baseVerification,
      status: VerificationStatus.REQUIRE_RESUBMISSION,
      submittedAt: new Date(now.getTime() - 60_000),
      latestSubmittedAt: new Date(now.getTime() - 60_000),
      reviewedAt: new Date(now.getTime() - 30_000),
      reasonCode: "BLURRY_IMAGE",
      assets: [{ ...studentCardAsset, objectKey: previousKey }],
    };
    const outboxCreate = vi.fn().mockResolvedValue({});
    const updated = {
      ...candidate,
      status: VerificationStatus.RESUBMISSION_AWAITING_UPLOAD,
    };
    const result = await service({
      outer: { studentVerification: { findFirst: vi.fn().mockResolvedValue(candidate) } },
      transaction: {
        studentVerification: {
          findFirst: vi.fn().mockResolvedValue(candidate),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          findUniqueOrThrow: vi.fn().mockResolvedValue(updated),
        },
        verificationAsset: {
          update: vi.fn().mockResolvedValue({}),
          upsert: vi.fn().mockResolvedValue({}),
        },
        outboxEvent: { create: outboxCreate },
      },
    }).createResubmissionUpload(
      principal,
      verificationId,
      [VerificationAssetType.STUDENT_CARD],
      "resubmission-upload-key-0001",
      now,
    );
    expect(result.verification).toMatchObject({
      status: "RESUBMISSION_AWAITING_UPLOAD",
      submittedAt: candidate.submittedAt.toISOString(),
      reviewedAt: candidate.reviewedAt.toISOString(),
      reasonCode: "BLURRY_IMAGE",
    });
    expect(outboxCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ payload: { objectKey: previousKey } }),
      }),
    );
  });

  it("replays replacement grants and rejects missing or invalid resubmission states", async () => {
    const replayBody = {
      verification: {
        id: verificationId,
        campusId: principal.campusId,
        studentNumberLast4: "9001",
        status: VerificationStatus.RESUBMISSION_AWAITING_UPLOAD,
        submittedAt: now.toISOString(),
        latestSubmittedAt: now.toISOString(),
        reviewedAt: now.toISOString(),
        expiresAt: null,
        reasonCode: "BLURRY_IMAGE",
        evidenceTypes: [VerificationAssetType.STUDENT_CARD],
      },
      uploads: [
        {
          type: VerificationAssetType.STUDENT_CARD,
          uploadUrl: "http://127.0.0.1/upload",
          uploadExpiresAt: uploadExpiresAt.toISOString(),
        },
      ],
    };
    await expect(
      service({
        replay: { status: 201, body: replayBody, replayed: true },
      }).createResubmissionUpload(
        principal,
        verificationId,
        [VerificationAssetType.STUDENT_CARD],
        "resubmission-replay-key-0001",
        now,
      ),
    ).resolves.toEqual(replayBody);
    await expect(
      service({
        transaction: { studentVerification: { findFirst: vi.fn().mockResolvedValue(null) } },
      }).createResubmissionUpload(
        principal,
        verificationId,
        [VerificationAssetType.STUDENT_CARD],
        "resubmission-missing-key-0001",
        now,
      ),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    await expect(
      service({
        transaction: {
          studentVerification: {
            findFirst: vi.fn().mockResolvedValue({
              ...baseVerification,
              status: VerificationStatus.PENDING,
              assets: [studentCardAsset],
            }),
            updateMany: vi.fn().mockResolvedValue({ count: 0 }),
          },
        },
      }).createResubmissionUpload(
        principal,
        verificationId,
        [VerificationAssetType.STUDENT_CARD],
        "resubmission-invalid-state-key",
        now,
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });
});

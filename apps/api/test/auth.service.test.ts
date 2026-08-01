import { randomUUID } from "node:crypto";
import {
  issueMockWechatCode,
  issueRefreshToken,
  sha256Hex,
  signUserAccessToken,
} from "@campus/auth";
import { AccountStatus, CatalogStatus } from "@campus/database";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService, type UserProfileResponse } from "../src/auth/auth.service";
import type { AppConfig } from "../src/config";
import type { PrismaService } from "../src/database/prisma.service";

const campusId = randomUUID();
const userId = randomUUID();
const sessionId = randomUUID();
const now = new Date("2026-07-31T12:00:00.000Z");
const accessSecret = "unit-access-secret-that-is-longer-than-thirty-two-bytes";
const mockSecret = "unit-mock-secret-that-is-longer-than-thirty-two-bytes";
const profile: UserProfileResponse = {
  id: userId,
  campusId,
  accountStatus: "ACTIVE",
  verificationStatus: "NOT_SUBMITTED",
  genderDeclaration: "UNDISCLOSED",
  hasWechatContact: false,
};

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    nodeEnv: "test",
    port: 3000,
    version: "test",
    logLevel: "silent",
    wechatAuthProvider: "mock",
    paymentProvider: "mock",
    wechatMockDefaultCampusId: campusId,
    wechatMockSigningSecret: mockSecret,
    accessTokenSecret: accessSecret,
    studentNumberHmacSecret: "student-secret-that-is-longer-than-thirty-two-bytes",
    dataEncryptionKeyBase64: Buffer.alloc(32).toString("base64"),
    dataEncryptionKeyVersion: "test",
    localObjectUploadSecret: "upload-secret-that-is-longer-than-thirty-two-bytes",
    localObjectStoreRoot: "D:\\test",
    publicApiBaseUrl: "http://127.0.0.1:3000",
    adminTrustedOrigins: new Set(["http://127.0.0.1:5173"]),
    ...overrides,
  };
}

function transactionPrisma(
  transaction: Record<string, unknown>,
  outer: Record<string, unknown> = {},
) {
  return {
    $transaction: vi.fn(async (action: (value: unknown) => Promise<unknown>) =>
      action(transaction),
    ),
    ...outer,
  } as unknown as PrismaService;
}

describe("AuthService", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("creates one user session from a valid signed mock code", async () => {
    const account = {
      id: userId,
      campusId,
      status: AccountStatus.ACTIVE,
      deletedAt: null,
    };
    const transaction = {
      campus: { findUnique: vi.fn().mockResolvedValue({ status: CatalogStatus.ACTIVE }) },
      user: { upsert: vi.fn().mockResolvedValue(account) },
      idempotencyRecord: { create: vi.fn().mockResolvedValue({}) },
      userSession: { create: vi.fn().mockResolvedValue({}) },
    };
    const service = new AuthService(transactionPrisma(transaction), config());
    vi.spyOn(service, "getUserProfile").mockResolvedValue(profile);
    const code = issueMockWechatCode("student_001", mockSecret, new Date(now.getTime() + 60_000));

    const result = await service.loginWithWechatCode(code, now);

    expect(result.user).toEqual(profile);
    expect(result.expiresInSeconds).toBe(900);
    expect(result.accessToken).not.toBe("");
    expect(result.refreshToken).not.toBe("");
    expect(transaction.idempotencyRecord.create).toHaveBeenCalledOnce();
    expect(transaction.userSession.create).toHaveBeenCalledOnce();
  });

  it("rejects disabled providers, weak secrets, bad codes, campuses and accounts", async () => {
    const empty = transactionPrisma({});
    await expect(
      new AuthService(empty, config({ accessTokenSecret: "short" })).loginWithWechatCode(
        "code",
        now,
      ),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR", statusCode: 503 });
    await expect(
      new AuthService(empty, config({ wechatAuthProvider: "wechat" })).loginWithWechatCode(
        "code",
        now,
      ),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR", statusCode: 503 });
    await expect(
      new AuthService(empty, config()).loginWithWechatCode("forged", now),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });

    const code = issueMockWechatCode("student_002", mockSecret, new Date(now.getTime() + 60_000));
    const campusRejected = new AuthService(
      transactionPrisma({ campus: { findUnique: vi.fn().mockResolvedValue(null) } }),
      config(),
    );
    await expect(campusRejected.loginWithWechatCode(code, now)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });

    const accountRejected = new AuthService(
      transactionPrisma({
        campus: { findUnique: vi.fn().mockResolvedValue({ status: CatalogStatus.ACTIVE }) },
        user: {
          upsert: vi.fn().mockResolvedValue({
            id: userId,
            campusId: randomUUID(),
            status: AccountStatus.ACTIVE,
          }),
        },
      }),
      config(),
    );
    await expect(accountRejected.loginWithWechatCode(code, now)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  it("rotates a valid refresh token", async () => {
    const refreshToken = issueRefreshToken(sessionId);
    const session = {
      id: sessionId,
      userId,
      campusId,
      refreshTokenHash: sha256Hex(refreshToken),
      revokedAt: null,
      expiresAt: new Date(now.getTime() + 60_000),
      user: { id: userId, campusId, status: AccountStatus.ACTIVE, deletedAt: null },
    };
    const transaction = {
      userSession: {
        findUnique: vi.fn().mockResolvedValue(session),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const service = new AuthService(transactionPrisma(transaction), config());
    vi.spyOn(service, "getUserProfile").mockResolvedValue(profile);

    const result = await service.refresh(refreshToken, now);
    expect(result.refreshToken).not.toBe(refreshToken);
    expect(result.user).toEqual(profile);
  });

  it("revokes refresh token families on replay or a lost rotation race", async () => {
    const refreshToken = issueRefreshToken(sessionId);
    const base = {
      id: sessionId,
      userId,
      campusId,
      revokedAt: null,
      expiresAt: new Date(now.getTime() + 60_000),
      user: { id: userId, campusId, status: AccountStatus.ACTIVE, deletedAt: null },
    };
    const replayUpdate = vi.fn().mockResolvedValue({ count: 1 });
    const replayService = new AuthService(
      transactionPrisma({
        userSession: {
          findUnique: vi.fn().mockResolvedValue({ ...base, refreshTokenHash: "0".repeat(64) }),
          updateMany: replayUpdate,
        },
      }),
      config(),
    );
    await expect(replayService.refresh(refreshToken, now)).rejects.toMatchObject({
      code: "SESSION_EXPIRED",
    });
    expect(replayUpdate).toHaveBeenCalledOnce();

    const raceUpdate = vi
      .fn()
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    const raceService = new AuthService(
      transactionPrisma({
        userSession: {
          findUnique: vi.fn().mockResolvedValue({
            ...base,
            refreshTokenHash: sha256Hex(refreshToken),
          }),
          updateMany: raceUpdate,
        },
      }),
      config(),
    );
    await expect(raceService.refresh(refreshToken, now)).rejects.toMatchObject({
      code: "SESSION_EXPIRED",
    });
    expect(raceUpdate).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed, missing, expired and disabled refresh sessions", async () => {
    await expect(
      new AuthService(transactionPrisma({}), config()).refresh("broken", now),
    ).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
    const token = issueRefreshToken(sessionId);
    const missing = new AuthService(
      transactionPrisma({ userSession: { findUnique: vi.fn().mockResolvedValue(null) } }),
      config(),
    );
    await expect(missing.refresh(token, now)).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
    const expired = new AuthService(
      transactionPrisma({
        userSession: {
          findUnique: vi.fn().mockResolvedValue({
            id: sessionId,
            refreshTokenHash: sha256Hex(token),
            revokedAt: null,
            expiresAt: now,
            user: { status: AccountStatus.ACTIVE, deletedAt: null },
          }),
        },
      }),
      config(),
    );
    await expect(expired.refresh(token, now)).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
  });

  it("authenticates, logs out and rejects forged or revoked access tokens", async () => {
    const token = signUserAccessToken({ userId, sessionId, campusId }, accessSecret, now);
    const validSession = {
      id: sessionId,
      userId,
      campusId,
      revokedAt: null,
      expiresAt: new Date(now.getTime() + 60_000),
      user: { status: AccountStatus.ACTIVE, deletedAt: null },
    };
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const service = new AuthService(
      transactionPrisma(
        {},
        {
          userSession: { findUnique: vi.fn().mockResolvedValue(validSession), updateMany },
        },
      ),
      config(),
    );
    await expect(service.authenticate(token, now)).resolves.toEqual({
      userId,
      sessionId,
      campusId,
    });
    await expect(service.logout(token, now)).resolves.toBeUndefined();
    expect(updateMany).toHaveBeenCalledOnce();
    await expect(service.authenticate(`${token}x`, now)).rejects.toMatchObject({
      code: "SESSION_EXPIRED",
    });
    const revoked = new AuthService(
      transactionPrisma(
        {},
        {
          userSession: {
            findUnique: vi.fn().mockResolvedValue({ ...validSession, revokedAt: now }),
          },
        },
      ),
      config(),
    );
    await expect(revoked.authenticate(token, now)).rejects.toMatchObject({
      code: "SESSION_EXPIRED",
    });
  });

  it("maps profile verification states and rejects deleted users", async () => {
    const base = {
      id: userId,
      campusId,
      status: AccountStatus.ACTIVE,
      genderDeclaration: "UNDISCLOSED",
      contact: null,
    };
    const service = (user: unknown) =>
      new AuthService(
        transactionPrisma({}, { user: { findUnique: vi.fn().mockResolvedValue(user) } }),
        config(),
      );
    await expect(
      service({ ...base, verifications: [] }).getUserProfile(userId, now),
    ).resolves.toMatchObject({
      verificationStatus: "NOT_SUBMITTED",
      hasWechatContact: false,
    });
    await expect(
      service({
        ...base,
        contact: { id: randomUUID() },
        verifications: [{ status: "VERIFIED", expiresAt: now }],
      }).getUserProfile(userId, now),
    ).resolves.toMatchObject({
      verificationStatus: "VERIFICATION_EXPIRED",
      hasWechatContact: true,
    });
    await expect(service(null).getUserProfile(userId, now)).rejects.toMatchObject({
      code: "SESSION_EXPIRED",
    });
  });
});

import { randomBytes, randomUUID } from "node:crypto";
import {
  AesGcmProtector,
  generateTotpCode,
  hashAdminPassword,
  parseRefreshToken,
  sha256Hex,
} from "@campus/auth";
import { AdminStatus } from "@campus/database";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { AdminAuthService, type AdminPrincipal } from "../src/admin/admin-auth.service";
import type { AppConfig } from "../src/config";
import type { PrismaService } from "../src/database/prisma.service";

const now = new Date("2026-07-31T12:00:00.000Z");
const adminId = randomUUID();
const campusId = randomUUID();
const totpSecret = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const protector = new AesGcmProtector(randomBytes(32), "m2-admin-test");
const encryptedTotp = protector.encrypt(totpSecret);
const origin = "http://127.0.0.1:5173";
let passwordHash = "";

beforeAll(async () => {
  passwordHash = await hashAdminPassword("correct administrator password");
});

function config(): AppConfig {
  return {
    nodeEnv: "test",
    port: 3000,
    version: "test",
    logLevel: "silent",
    wechatAuthProvider: "mock",
    paymentProvider: "mock",
    wechatMockSigningSecret: "mock-secret-that-is-longer-than-thirty-two-bytes",
    accessTokenSecret: "access-secret-that-is-longer-than-thirty-two-bytes",
    studentNumberHmacSecret: "student-secret-that-is-longer-than-thirty-two-bytes",
    dataEncryptionKeyBase64: Buffer.alloc(32).toString("base64"),
    dataEncryptionKeyVersion: "m2-admin-test",
    localObjectUploadSecret: "upload-secret-that-is-longer-than-thirty-two-bytes",
    localObjectStoreRoot: "D:\\test",
    publicApiBaseUrl: "http://127.0.0.1:3000",
    adminTrustedOrigins: new Set([origin]),
  };
}

function admin() {
  return {
    id: adminId,
    username: "reviewer",
    passwordHash,
    totpSecretCiphertext: encryptedTotp.ciphertext,
    keyVersion: encryptedTotp.keyVersion,
    status: AdminStatus.ACTIVE,
    roles: [{ role: { code: "VERIFICATION_REVIEWER" } }],
    campusScopes: [{ campusId }],
  };
}

function prisma(outer: Record<string, unknown>, transaction: Record<string, unknown> = {}) {
  return {
    ...outer,
    $transaction: vi.fn(async (action: (value: unknown) => Promise<unknown>) =>
      action(transaction),
    ),
  } as unknown as PrismaService;
}

function service(outer: Record<string, unknown>, transaction: Record<string, unknown> = {}) {
  return new AdminAuthService(prisma(outer, transaction), config(), protector);
}

describe("AdminAuthService", () => {
  it("creates a password plus TOTP session with CSRF evidence and audit", async () => {
    const tx = {
      adminUser: {
        findUnique: vi.fn().mockResolvedValue({ status: AdminStatus.ACTIVE }),
        update: vi.fn().mockResolvedValue({}),
      },
      idempotencyRecord: { create: vi.fn().mockResolvedValue({}) },
      adminSession: { create: vi.fn().mockResolvedValue({}) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    const auth = service({ adminUser: { findUnique: vi.fn().mockResolvedValue(admin()) } }, tx);
    const result = await auth.login(
      "reviewer",
      "correct administrator password",
      generateTotpCode(totpSecret, now.getTime()),
      "req-admin-login",
      now,
    );
    expect(parseRefreshToken(result.sessionToken)).not.toBeNull();
    expect(result.csrfToken).not.toBe("");
    expect(tx.idempotencyRecord.create).toHaveBeenCalledTimes(2);
    expect(tx.auditLog.create).toHaveBeenCalledOnce();
  });

  it("returns one generic authentication error for unknown, wrong, disabled or undecryptable admins", async () => {
    const unknown = service({ adminUser: { findUnique: vi.fn().mockResolvedValue(null) } });
    await expect(
      unknown.login("missing", "some administrator password", "123456", "req-1", now),
    ).rejects.toMatchObject({ code: "AUTH_REQUIRED", statusCode: 401 });

    const wrong = service({ adminUser: { findUnique: vi.fn().mockResolvedValue(admin()) } });
    await expect(
      wrong.login("reviewer", "wrong administrator password", "123456", "req-2", now),
    ).rejects.toMatchObject({ code: "AUTH_REQUIRED" });

    const disabled = service({
      adminUser: {
        findUnique: vi.fn().mockResolvedValue({ ...admin(), status: AdminStatus.DISABLED }),
      },
    });
    await expect(
      disabled.login(
        "reviewer",
        "correct administrator password",
        generateTotpCode(totpSecret, now.getTime()),
        "req-3",
        now,
      ),
    ).rejects.toMatchObject({ code: "AUTH_REQUIRED" });

    const wrongKey = service({
      adminUser: {
        findUnique: vi.fn().mockResolvedValue({ ...admin(), keyVersion: "retired-key" }),
      },
    });
    await expect(
      wrongKey.login(
        "reviewer",
        "correct administrator password",
        generateTotpCode(totpSecret, now.getTime()),
        "req-4",
        now,
      ),
    ).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });

  it("authenticates current CSRF evidence and enforces role and campus scope", async () => {
    const sessionId = randomUUID();
    const sessionToken = `${sessionId}.${Buffer.alloc(32, 1).toString("base64url")}`;
    const csrfToken = Buffer.alloc(32, 2).toString("base64url");
    const session = {
      id: sessionId,
      adminUserId: adminId,
      sessionTokenHash: sha256Hex(sessionToken),
      csrfTokenHash: sha256Hex(csrfToken),
      revokedAt: null,
      expiresAt: new Date(now.getTime() + 60_000),
      adminUser: admin(),
    };
    const auth = service({
      adminSession: { findUnique: vi.fn().mockResolvedValue(session) },
      idempotencyRecord: {
        findUnique: vi.fn().mockResolvedValue({
          adminUserId: adminId,
          requestDigest: sha256Hex(csrfToken),
          expiresAt: new Date(now.getTime() + 60_000),
        }),
      },
    });
    const context = { sessionToken, csrfToken, origin, fetchSite: "same-origin" };
    await expect(
      auth.authenticate(
        context,
        {
          requireCsrf: true,
          role: "VERIFICATION_REVIEWER",
          campusId,
        },
        now,
      ),
    ).resolves.toMatchObject({ adminUserId: adminId, sessionId });
    await expect(
      auth.authenticate(context, { requireCsrf: true, role: "REFUND_REVIEWER" }, now),
    ).rejects.toMatchObject({ code: "ADMIN_ROLE_REQUIRED" });
    await expect(
      auth.authenticate(context, { requireCsrf: true, campusId: randomUUID() }, now),
    ).rejects.toMatchObject({ code: "ADMIN_CAMPUS_FORBIDDEN" });
  });

  it("accepts only unexpired CSRF grace evidence and trusted browser sources", async () => {
    const sessionId = randomUUID();
    const sessionToken = `${sessionId}.${Buffer.alloc(32, 3).toString("base64url")}`;
    const oldCsrf = Buffer.alloc(32, 4).toString("base64url");
    const session = {
      id: sessionId,
      adminUserId: adminId,
      sessionTokenHash: sha256Hex(sessionToken),
      csrfTokenHash: "0".repeat(64),
      revokedAt: null,
      expiresAt: new Date(now.getTime() + 60_000),
      adminUser: admin(),
    };
    const evidence = {
      adminUserId: adminId,
      requestDigest: sha256Hex(oldCsrf),
      expiresAt: new Date(now.getTime() + 30_000),
    };
    const auth = service({
      adminSession: { findUnique: vi.fn().mockResolvedValue(session) },
      idempotencyRecord: { findUnique: vi.fn().mockResolvedValue(evidence) },
    });
    await expect(
      auth.authenticate({ sessionToken, csrfToken: oldCsrf, origin }, { requireCsrf: true }, now),
    ).resolves.toMatchObject({ adminUserId: adminId });
    await expect(
      auth.authenticate(
        { sessionToken, csrfToken: oldCsrf, origin: "https://attacker.invalid" },
        { requireCsrf: true },
        now,
      ),
    ).rejects.toMatchObject({ code: "RESOURCE_FORBIDDEN" });
    await expect(
      auth.authenticate(
        { sessionToken, csrfToken: oldCsrf, origin, fetchSite: "cross-site" },
        { requireCsrf: true },
        now,
      ),
    ).rejects.toMatchObject({ code: "RESOURCE_FORBIDDEN" });
    evidence.expiresAt = now;
    await expect(
      auth.authenticate({ sessionToken, csrfToken: oldCsrf, origin }, { requireCsrf: true }, now),
    ).rejects.toMatchObject({ code: "ADMIN_CSRF_INVALID" });
  });

  it("rejects malformed, expired, revoked and disabled sessions", async () => {
    const missing = service({ adminSession: { findUnique: vi.fn().mockResolvedValue(null) } });
    await expect(
      missing.authenticate({ sessionToken: "broken", origin }, { requireCsrf: false }, now),
    ).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
    const sessionId = randomUUID();
    const token = `${sessionId}.${Buffer.alloc(32, 5).toString("base64url")}`;
    const invalid = (overrides: Record<string, unknown>) =>
      service({
        adminSession: {
          findUnique: vi.fn().mockResolvedValue({
            id: sessionId,
            adminUserId: adminId,
            sessionTokenHash: sha256Hex(token),
            csrfTokenHash: "0".repeat(64),
            revokedAt: null,
            expiresAt: new Date(now.getTime() + 60_000),
            adminUser: admin(),
            ...overrides,
          }),
        },
      });
    await expect(
      invalid({ revokedAt: now }).authenticate(
        { sessionToken: token, origin },
        { requireCsrf: false },
        now,
      ),
    ).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
    await expect(
      invalid({ expiresAt: now }).authenticate(
        { sessionToken: token, origin },
        { requireCsrf: false },
        now,
      ),
    ).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
    await expect(
      invalid({ adminUser: { ...admin(), status: AdminStatus.DISABLED } }).authenticate(
        { sessionToken: token, origin },
        { requireCsrf: false },
        now,
      ),
    ).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
  });

  it("rotates CSRF with a 30-second previous-token evidence window", async () => {
    const sessionId = randomUUID();
    const oldDigest = "a".repeat(64);
    const update = vi.fn().mockResolvedValue({});
    const upsert = vi.fn().mockResolvedValue({});
    const create = vi.fn().mockResolvedValue({});
    const auth = service(
      {
        adminSession: {
          findUnique: vi.fn().mockResolvedValue({
            id: sessionId,
            adminUserId: adminId,
            sessionTokenHash: "unused",
            csrfTokenHash: oldDigest,
            revokedAt: null,
            expiresAt: new Date(now.getTime() + 60_000),
            adminUser: admin(),
          }),
        },
      },
      {
        adminSession: {
          findUnique: vi.fn().mockResolvedValue({
            id: sessionId,
            adminUserId: adminId,
            csrfTokenHash: oldDigest,
            revokedAt: null,
            expiresAt: new Date(now.getTime() + 60_000),
          }),
          update,
        },
        idempotencyRecord: { upsert, create },
      },
    );
    vi.spyOn(auth, "authenticate").mockResolvedValue({
      adminUserId: adminId,
      sessionId,
      roles: new Set(),
      campusIds: new Set(),
    });
    const result = await auth.rotateCsrf({ sessionToken: "ignored", origin }, now);
    expect(result.csrfToken).not.toBe("");
    expect(upsert).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ expiresAt: new Date(now.getTime() + 30_000) }),
      }),
    );
    expect(update).toHaveBeenCalledOnce();
  });

  it("logs out active sessions and treats a repeated valid-cookie logout as complete", async () => {
    const sessionId = randomUUID();
    const sessionToken = `${sessionId}.${Buffer.alloc(32, 6).toString("base64url")}`;
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const active = service({
      adminSession: {
        findUnique: vi.fn().mockResolvedValue({
          id: sessionId,
          sessionTokenHash: sha256Hex(sessionToken),
          revokedAt: null,
        }),
        updateMany,
      },
    });
    vi.spyOn(active, "authenticate").mockResolvedValue({
      adminUserId: adminId,
      sessionId,
      roles: new Set(),
      campusIds: new Set(),
    });
    await expect(
      active.logout({ sessionToken, csrfToken: "csrf", origin }, now),
    ).resolves.toBeUndefined();
    expect(updateMany).toHaveBeenCalledOnce();

    const repeated = service({
      adminSession: {
        findUnique: vi.fn().mockResolvedValue({
          id: sessionId,
          sessionTokenHash: sha256Hex(sessionToken),
          revokedAt: now,
        }),
      },
    });
    await expect(repeated.logout({ sessionToken, origin }, now)).resolves.toBeUndefined();
  });

  it("reauthenticates sensitive actions once per TOTP counter", async () => {
    const principal: AdminPrincipal = {
      adminUserId: adminId,
      sessionId: randomUUID(),
      roles: new Set(["VERIFICATION_REVIEWER"]),
      campusIds: new Set([campusId]),
    };
    const create = vi.fn().mockResolvedValue({});
    const update = vi.fn().mockResolvedValue({});
    const transaction = {
      adminUser: { findUnique: vi.fn().mockResolvedValue(admin()) },
      idempotencyRecord: { create },
      adminSession: { update },
    } as never;
    const auth = service({});
    await expect(
      auth.verifyReauthenticationTotp(
        principal,
        generateTotpCode(totpSecret, now.getTime()),
        "asset-access",
        transaction,
        now,
      ),
    ).resolves.toBeUndefined();
    expect(create).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledOnce();
    await expect(
      auth.verifyReauthenticationTotp(principal, "000000", "asset-access", transaction, now),
    ).rejects.toMatchObject({ code: "ADMIN_REAUTH_REQUIRED" });
  });
});

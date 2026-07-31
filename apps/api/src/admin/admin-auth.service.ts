import { randomUUID } from "node:crypto";
import {
  type AesGcmProtector,
  hashAdminPassword,
  issueRefreshToken,
  parseRefreshToken,
  randomOpaqueToken,
  sha256Hex,
  verifyAdminPassword,
  verifyTotpCode,
} from "@campus/auth";
import { AdminStatus, Prisma } from "@campus/database";
import { Inject, Injectable } from "@nestjs/common";
import { ApplicationError } from "../common/application-error";
import { APP_CONFIG, type AppConfig } from "../config";
import { PrismaService } from "../database/prisma.service";
import { DATA_PROTECTOR } from "../m2/providers";

const ADMIN_SESSION_LIFETIME_MS = 30 * 60 * 1_000;
const CSRF_LIFETIME_MS = 15 * 60 * 1_000;
const CSRF_GRACE_LIFETIME_MS = 30 * 1_000;
const TOTP_EVIDENCE_LIFETIME_MS = 24 * 60 * 60 * 1_000;

export interface AdminSessionResponse {
  readonly sessionToken: string;
  readonly csrfToken: string;
  readonly csrfExpiresAt: string;
  readonly sessionExpiresAt: string;
}

export interface AdminPrincipal {
  readonly adminUserId: string;
  readonly sessionId: string;
  readonly roles: ReadonlySet<string>;
  readonly campusIds: ReadonlySet<string>;
}

interface RequestSecurityContext {
  readonly sessionToken: string;
  readonly csrfToken?: string;
  readonly origin: string;
  readonly fetchSite?: string;
}

@Injectable()
export class AdminAuthService {
  public constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DATA_PROTECTOR) private readonly protector: AesGcmProtector,
  ) {}

  public async login(
    username: string,
    password: string,
    totpCode: string,
    requestId: string,
    now = new Date(),
  ): Promise<AdminSessionResponse> {
    const admin = await this.prisma.adminUser.findUnique({
      where: { username },
      include: { roles: { include: { role: true } }, campusScopes: true },
    });
    if (admin === null) {
      await hashAdminPassword(password);
      throw invalidAdminCredentials();
    }
    const passwordValid = await verifyAdminPassword(password, admin.passwordHash);
    let totpSecret = "";
    try {
      if (admin.keyVersion !== this.protector.keyVersion) throw new Error("key version mismatch");
      totpSecret = this.protector.decrypt(admin.totpSecretCiphertext);
    } catch {
      throw invalidAdminCredentials();
    }
    const totp = verifyTotpCode(totpSecret, totpCode, now.getTime());
    if (!passwordValid || totp === null || admin.status !== AdminStatus.ACTIVE) {
      throw invalidAdminCredentials();
    }

    const sessionId = randomUUID();
    const sessionToken = issueRefreshToken(sessionId);
    const csrfToken = randomOpaqueToken(32);
    const sessionExpiresAt = new Date(now.getTime() + ADMIN_SESSION_LIFETIME_MS);
    const csrfExpiresAt = new Date(now.getTime() + CSRF_LIFETIME_MS);
    const totpUseKey = totpUseDigest(admin.id, totp.counter);
    try {
      await this.prisma.$transaction(async (transaction) => {
        const current = await transaction.adminUser.findUnique({ where: { id: admin.id } });
        if (current?.status !== AdminStatus.ACTIVE) throw invalidAdminCredentials();
        await transaction.idempotencyRecord.create({
          data: {
            scope: "admin-totp-use",
            key: totpUseKey,
            adminUserId: admin.id,
            requestDigest: sha256Hex(`login:${totp.counter}`),
            expiresAt: new Date(now.getTime() + TOTP_EVIDENCE_LIFETIME_MS),
          },
        });
        await transaction.adminSession.create({
          data: {
            id: sessionId,
            adminUserId: admin.id,
            sessionTokenHash: sha256Hex(sessionToken),
            csrfTokenHash: sha256Hex(csrfToken),
            expiresAt: sessionExpiresAt,
            lastReauthenticatedAt: now,
          },
        });
        await transaction.idempotencyRecord.create({
          data: {
            scope: "admin-csrf-current",
            key: sessionId,
            adminUserId: admin.id,
            requestDigest: sha256Hex(csrfToken),
            expiresAt: csrfExpiresAt,
          },
        });
        await transaction.adminUser.update({ where: { id: admin.id }, data: { lastLoginAt: now } });
        await transaction.auditLog.create({
          data: {
            actorAdminId: admin.id,
            action: "ADMIN_LOGIN",
            targetType: "AdminSession",
            targetId: sessionId,
            requestId,
            afterDigest: sha256Hex(sessionId),
          },
        });
      });
    } catch (error) {
      if (isUniqueConstraint(error)) throw invalidAdminCredentials();
      throw error;
    }
    return {
      sessionToken,
      csrfToken,
      csrfExpiresAt: csrfExpiresAt.toISOString(),
      sessionExpiresAt: sessionExpiresAt.toISOString(),
    };
  }

  public async authenticate(
    context: RequestSecurityContext,
    options: { readonly requireCsrf: boolean; readonly role?: string; readonly campusId?: string },
    now = new Date(),
  ): Promise<AdminPrincipal> {
    if (!this.config.adminTrustedOrigins.has(normalizeOrigin(context.origin)))
      throw adminForbidden();
    if (
      context.fetchSite !== undefined &&
      !["same-origin", "same-site"].includes(context.fetchSite)
    ) {
      throw adminForbidden();
    }
    const parsed = parseRefreshToken(context.sessionToken);
    if (parsed === null) throw invalidAdminSession();
    const session = await this.prisma.adminSession.findUnique({
      where: { id: parsed.sessionId },
      include: {
        adminUser: { include: { roles: { include: { role: true } }, campusScopes: true } },
      },
    });
    if (
      session === null ||
      session.sessionTokenHash !== parsed.digest ||
      session.revokedAt !== null ||
      session.expiresAt <= now ||
      session.adminUser.status !== AdminStatus.ACTIVE
    ) {
      throw invalidAdminSession();
    }
    if (options.requireCsrf) {
      if (context.csrfToken === undefined) throw invalidAdminCsrf();
      const suppliedDigest = sha256Hex(context.csrfToken);
      if (suppliedDigest === session.csrfTokenHash) {
        const currentEvidence = await this.prisma.idempotencyRecord.findUnique({
          where: { scope_key: { scope: "admin-csrf-current", key: session.id } },
        });
        if (
          currentEvidence?.adminUserId !== session.adminUserId ||
          currentEvidence.requestDigest !== suppliedDigest ||
          currentEvidence.expiresAt <= now
        ) {
          throw invalidAdminCsrf();
        }
      } else {
        const graceEvidence = await this.prisma.idempotencyRecord.findUnique({
          where: {
            scope_key: {
              scope: "admin-csrf-grace",
              key: csrfGraceKey(session.id, suppliedDigest),
            },
          },
        });
        if (
          graceEvidence?.adminUserId !== session.adminUserId ||
          graceEvidence.requestDigest !== suppliedDigest ||
          graceEvidence.expiresAt <= now
        ) {
          throw invalidAdminCsrf();
        }
      }
    }
    const roles = new Set(session.adminUser.roles.map(({ role }) => role.code));
    const campusIds = new Set(session.adminUser.campusScopes.map(({ campusId }) => campusId));
    if (options.role !== undefined && !roles.has(options.role)) {
      throw new ApplicationError("ADMIN_ROLE_REQUIRED", "administrator request is forbidden", 403);
    }
    if (options.campusId !== undefined && !campusIds.has(options.campusId)) {
      throw new ApplicationError(
        "ADMIN_CAMPUS_FORBIDDEN",
        "administrator request is forbidden",
        403,
      );
    }
    return { adminUserId: session.adminUserId, sessionId: session.id, roles, campusIds };
  }

  public async rotateCsrf(
    context: RequestSecurityContext,
    now = new Date(),
  ): Promise<{ csrfToken: string; csrfExpiresAt: string }> {
    const principal = await this.authenticate(context, { requireCsrf: false }, now);
    const csrfToken = randomOpaqueToken(32);
    const csrfExpiresAt = new Date(now.getTime() + CSRF_LIFETIME_MS);
    const nextDigest = sha256Hex(csrfToken);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await this.prisma.$transaction(
          async (transaction) => {
            const session = await transaction.adminSession.findUnique({
              where: { id: principal.sessionId },
            });
            if (session === null || session.revokedAt !== null || session.expiresAt <= now) {
              throw invalidAdminSession();
            }
            await transaction.idempotencyRecord.upsert({
              where: { scope_key: { scope: "admin-csrf-current", key: session.id } },
              create: {
                scope: "admin-csrf-current",
                key: session.id,
                adminUserId: principal.adminUserId,
                requestDigest: nextDigest,
                expiresAt: csrfExpiresAt,
              },
              update: { requestDigest: nextDigest, expiresAt: csrfExpiresAt },
            });
            await transaction.idempotencyRecord.create({
              data: {
                scope: "admin-csrf-grace",
                key: csrfGraceKey(session.id, session.csrfTokenHash),
                adminUserId: principal.adminUserId,
                requestDigest: session.csrfTokenHash,
                expiresAt: new Date(now.getTime() + CSRF_GRACE_LIFETIME_MS),
              },
            });
            await transaction.adminSession.update({
              where: { id: session.id },
              data: { csrfTokenHash: nextDigest, rotatedAt: now },
            });
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
        break;
      } catch (error) {
        if (attempt === 3 || !isRetryableTransactionConflict(error)) throw error;
      }
    }
    return { csrfToken, csrfExpiresAt: csrfExpiresAt.toISOString() };
  }

  public async logout(context: RequestSecurityContext, now = new Date()): Promise<void> {
    assertAdminRequestSource(this.config, context);
    const parsed = parseRefreshToken(context.sessionToken);
    if (parsed === null) throw invalidAdminSession();
    const existing = await this.prisma.adminSession.findUnique({ where: { id: parsed.sessionId } });
    if (existing === null || existing.sessionTokenHash !== parsed.digest)
      throw invalidAdminSession();
    if (existing.revokedAt !== null) return;
    const principal = await this.authenticate(context, { requireCsrf: true }, now);
    await this.prisma.adminSession.updateMany({
      where: { id: principal.sessionId, revokedAt: null },
      data: { revokedAt: now },
    });
  }

  public async verifyReauthenticationTotp(
    principal: AdminPrincipal,
    code: string,
    purpose: string,
    transaction: Prisma.TransactionClient,
    now = new Date(),
  ): Promise<void> {
    const admin = await transaction.adminUser.findUnique({ where: { id: principal.adminUserId } });
    if (admin?.status !== AdminStatus.ACTIVE) throw adminReauthRequired();
    let secret = "";
    try {
      if (admin.keyVersion !== this.protector.keyVersion) throw new Error("key version mismatch");
      secret = this.protector.decrypt(admin.totpSecretCiphertext);
    } catch {
      throw adminReauthRequired();
    }
    const verified = verifyTotpCode(secret, code, now.getTime());
    if (verified === null) throw adminReauthRequired();
    await transaction.idempotencyRecord.create({
      data: {
        scope: "admin-totp-use",
        key: totpUseDigest(admin.id, verified.counter),
        adminUserId: admin.id,
        requestDigest: sha256Hex(`${purpose}:${verified.counter}`),
        expiresAt: new Date(now.getTime() + TOTP_EVIDENCE_LIFETIME_MS),
      },
    });
    await transaction.adminSession.update({
      where: { id: principal.sessionId },
      data: { lastReauthenticatedAt: now },
    });
  }
}

function totpUseDigest(adminUserId: string, counter: number): string {
  return sha256Hex(`${adminUserId}:${counter}`);
}

function normalizeOrigin(origin: string): string {
  try {
    return new URL(origin).origin;
  } catch {
    return "invalid-origin";
  }
}

function assertAdminRequestSource(config: AppConfig, context: RequestSecurityContext): void {
  if (!config.adminTrustedOrigins.has(normalizeOrigin(context.origin))) throw adminForbidden();
  if (
    context.fetchSite !== undefined &&
    !["same-origin", "same-site"].includes(context.fetchSite)
  ) {
    throw adminForbidden();
  }
}

function csrfGraceKey(sessionId: string, csrfDigest: string): string {
  return sha256Hex(`${sessionId}:${csrfDigest}`);
}

function invalidAdminCredentials(): ApplicationError {
  return new ApplicationError("AUTH_REQUIRED", "administrator credentials are invalid", 401);
}

function invalidAdminSession(): ApplicationError {
  return new ApplicationError("SESSION_EXPIRED", "administrator session is invalid", 401);
}

function adminForbidden(): ApplicationError {
  return new ApplicationError("RESOURCE_FORBIDDEN", "administrator request is forbidden", 403);
}

function adminReauthRequired(): ApplicationError {
  return new ApplicationError(
    "ADMIN_REAUTH_REQUIRED",
    "administrator reauthentication failed",
    403,
  );
}

function invalidAdminCsrf(): ApplicationError {
  return new ApplicationError("ADMIN_CSRF_INVALID", "administrator request is forbidden", 403);
}

function isUniqueConstraint(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function isRetryableTransactionConflict(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === "P2002" || error.code === "P2034")
  );
}

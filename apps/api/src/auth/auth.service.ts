import { randomUUID } from "node:crypto";
import {
  issueRefreshToken,
  parseRefreshToken,
  sha256Hex,
  signUserAccessToken,
  verifyMockWechatCode,
  verifyUserAccessToken,
} from "@campus/auth";
import { AccountStatus, CatalogStatus, Prisma } from "@campus/database";
import { Inject, Injectable } from "@nestjs/common";
import { ApplicationError } from "../common/application-error";
import { APP_CONFIG, type AppConfig } from "../config";
import { PrismaService } from "../database/prisma.service";

const ACCESS_TOKEN_LIFETIME_SECONDS = 900;
const REFRESH_TOKEN_LIFETIME_MS = 30 * 24 * 60 * 60 * 1_000;
const LOGIN_CODE_EVIDENCE_LIFETIME_MS = 24 * 60 * 60 * 1_000;

export interface UserProfileResponse {
  readonly id: string;
  readonly campusId: string;
  readonly accountStatus: "ACTIVE" | "RESTRICTED" | "DELETION_PENDING";
  readonly verificationStatus:
    | "NOT_SUBMITTED"
    | "AWAITING_UPLOAD"
    | "UPLOAD_EXPIRED"
    | "PENDING"
    | "VERIFIED"
    | "REJECTED"
    | "REQUIRE_RESUBMISSION"
    | "RESUBMISSION_AWAITING_UPLOAD"
    | "RESUBMISSION_PENDING"
    | "VERIFICATION_EXPIRED";
  readonly genderDeclaration: "MALE" | "FEMALE" | "UNDISCLOSED";
  readonly hasWechatContact: boolean;
}

export interface UserSessionResponse {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresInSeconds: number;
  readonly user: UserProfileResponse;
}

export interface AuthenticatedUser {
  readonly userId: string;
  readonly sessionId: string;
  readonly campusId: string;
}

@Injectable()
export class AuthService {
  public constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  public async loginWithWechatCode(code: string, now = new Date()): Promise<UserSessionResponse> {
    const accessTokenSecret = this.requireSecret(
      this.config.accessTokenSecret,
      "AUTH_ACCESS_TOKEN_SECRET",
    );
    if (this.config.wechatAuthProvider !== "mock") {
      throw new ApplicationError("INTERNAL_ERROR", "WeChat provider is not configured", 503);
    }
    const mockSecret = this.requireSecret(
      this.config.wechatMockSigningSecret,
      "WECHAT_MOCK_SIGNING_SECRET",
    );
    const campusId = this.config.wechatMockDefaultCampusId;
    const subject = verifyMockWechatCode(code, mockSecret, now);
    if (campusId === undefined || subject === null) throw invalidLoginCode();

    const sessionId = randomUUID();
    const refreshToken = issueRefreshToken(sessionId);
    const refreshTokenHash = sha256Hex(refreshToken);
    const codeDigest = sha256Hex(code);
    try {
      const user = await this.prisma.$transaction(async (transaction) => {
        const campus = await transaction.campus.findUnique({ where: { id: campusId } });
        if (campus?.status !== CatalogStatus.ACTIVE) throw invalidLoginCode();
        const wechatSubject = `mock:${subject}`;
        const account = await transaction.user.upsert({
          where: { wechatSubject },
          create: {
            campusId,
            wechatSubject,
            displayName: `同学-${sha256Hex(subject).slice(0, 6)}`,
          },
          update: {},
        });
        if (account.campusId !== campusId || account.status !== AccountStatus.ACTIVE) {
          throw invalidLoginCode();
        }
        await transaction.idempotencyRecord.create({
          data: {
            campusId,
            scope: "wechat-login-code",
            key: codeDigest,
            userId: account.id,
            requestDigest: codeDigest,
            expiresAt: new Date(now.getTime() + LOGIN_CODE_EVIDENCE_LIFETIME_MS),
          },
        });
        await transaction.userSession.create({
          data: {
            id: sessionId,
            campusId,
            userId: account.id,
            refreshTokenHash,
            expiresAt: new Date(now.getTime() + REFRESH_TOKEN_LIFETIME_MS),
            lastSeenAt: now,
          },
        });
        return account;
      });
      return {
        accessToken: signUserAccessToken(
          { userId: user.id, sessionId, campusId },
          accessTokenSecret,
          now,
          ACCESS_TOKEN_LIFETIME_SECONDS,
        ),
        refreshToken,
        expiresInSeconds: ACCESS_TOKEN_LIFETIME_SECONDS,
        user: await this.getUserProfile(user.id, now),
      };
    } catch (error) {
      if (isUniqueConstraint(error)) throw invalidLoginCode();
      throw error;
    }
  }

  public async refresh(refreshToken: string, now = new Date()): Promise<UserSessionResponse> {
    const parsed = parseRefreshToken(refreshToken);
    if (parsed === null) throw invalidSession();
    const accessTokenSecret = this.requireSecret(
      this.config.accessTokenSecret,
      "AUTH_ACCESS_TOKEN_SECRET",
    );
    const nextRefreshToken = issueRefreshToken(parsed.sessionId);
    const nextDigest = sha256Hex(nextRefreshToken);
    const result = await this.prisma.$transaction(async (transaction) => {
      const session = await transaction.userSession.findUnique({
        where: { id: parsed.sessionId },
        include: { user: true },
      });
      if (session === null) return { kind: "invalid" } as const;
      if (session.refreshTokenHash !== parsed.digest) {
        await transaction.userSession.updateMany({
          where: { id: session.id, revokedAt: null },
          data: { revokedAt: now },
        });
        return { kind: "replay" } as const;
      }
      if (
        session.revokedAt !== null ||
        session.expiresAt <= now ||
        session.user.status !== AccountStatus.ACTIVE ||
        session.user.deletedAt !== null
      ) {
        return { kind: "invalid" } as const;
      }
      const rotated = await transaction.userSession.updateMany({
        where: {
          id: session.id,
          refreshTokenHash: parsed.digest,
          revokedAt: null,
          expiresAt: { gt: now },
        },
        data: { refreshTokenHash: nextDigest, lastSeenAt: now },
      });
      if (rotated.count !== 1) {
        await transaction.userSession.updateMany({
          where: { id: session.id, revokedAt: null },
          data: { revokedAt: now },
        });
        return { kind: "replay" } as const;
      }
      return { kind: "ok", session, user: session.user } as const;
    });
    if (result.kind !== "ok") throw invalidSession();
    return {
      accessToken: signUserAccessToken(
        {
          userId: result.user.id,
          sessionId: result.session.id,
          campusId: result.user.campusId,
        },
        accessTokenSecret,
        now,
        ACCESS_TOKEN_LIFETIME_SECONDS,
      ),
      refreshToken: nextRefreshToken,
      expiresInSeconds: ACCESS_TOKEN_LIFETIME_SECONDS,
      user: await this.getUserProfile(result.user.id, now),
    };
  }

  public async authenticate(accessToken: string, now = new Date()): Promise<AuthenticatedUser> {
    const secret = this.requireSecret(this.config.accessTokenSecret, "AUTH_ACCESS_TOKEN_SECRET");
    const principal = verifyUserAccessToken(accessToken, secret, now);
    if (principal === null) throw invalidSession();
    const session = await this.prisma.userSession.findUnique({
      where: { id: principal.sessionId },
      include: { user: true },
    });
    if (
      session === null ||
      session.userId !== principal.userId ||
      session.campusId !== principal.campusId ||
      session.revokedAt !== null ||
      session.expiresAt <= now ||
      session.user.status !== AccountStatus.ACTIVE ||
      session.user.deletedAt !== null
    ) {
      throw invalidSession();
    }
    return principal;
  }

  public async logout(accessToken: string, now = new Date()): Promise<void> {
    const secret = this.requireSecret(this.config.accessTokenSecret, "AUTH_ACCESS_TOKEN_SECRET");
    const principal = verifyUserAccessToken(accessToken, secret, now);
    if (principal === null) throw invalidSession();
    await this.prisma.userSession.updateMany({
      where: { id: principal.sessionId, userId: principal.userId, campusId: principal.campusId },
      data: { revokedAt: now },
    });
  }

  public async getUserProfile(userId: string, now = new Date()): Promise<UserProfileResponse> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        contact: { select: { id: true } },
        verifications: { orderBy: { createdAt: "desc" }, take: 1 },
      },
    });
    if (user === null || user.status === AccountStatus.DELETED) throw invalidSession();
    const verification = user.verifications[0];
    const verificationStatus =
      verification === undefined
        ? "NOT_SUBMITTED"
        : verification.status === "VERIFIED" &&
            (verification.expiresAt === null || verification.expiresAt <= now)
          ? "VERIFICATION_EXPIRED"
          : verification.status;
    return {
      id: user.id,
      campusId: user.campusId,
      accountStatus: user.status,
      verificationStatus,
      genderDeclaration: user.genderDeclaration,
      hasWechatContact: user.contact !== null,
    };
  }

  private requireSecret(value: string, name: string): string {
    if (Buffer.byteLength(value, "utf8") < 32) {
      throw new ApplicationError("INTERNAL_ERROR", `${name} is not configured`, 503);
    }
    return value;
  }
}

function invalidLoginCode(): ApplicationError {
  return new ApplicationError("VALIDATION_ERROR", "login code is invalid or expired", 400);
}

function invalidSession(): ApplicationError {
  return new ApplicationError("SESSION_EXPIRED", "session is invalid or expired", 401);
}

function isUniqueConstraint(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

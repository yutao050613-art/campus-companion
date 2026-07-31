import { randomUUID } from "node:crypto";
import { randomOpaqueToken, sha256Hex } from "@campus/auth";
import { Prisma, VerificationAssetType, VerificationStatus } from "@campus/database";
import type { VerificationObjectStore } from "@campus/verification";
import { Inject, Injectable } from "@nestjs/common";
import { ApplicationError } from "../common/application-error";
import { PrismaService } from "../database/prisma.service";
import { IdempotencyService } from "../m2/idempotency.service";
import { VERIFICATION_OBJECT_STORE } from "../m2/providers";
import { AdminAuthService } from "./admin-auth.service";

const REVIEW_MATERIAL_RETENTION_MS = 24 * 60 * 60 * 1_000;
const VERIFIED_CREDENTIAL_LIFETIME_MS = 365 * 24 * 60 * 60 * 1_000;
const ASSET_GRANT_LIFETIME_MS = 60 * 1_000;

export interface AdminVerificationResponse {
  readonly id: string;
  readonly campusId: string;
  readonly studentNumberLast4: string;
  readonly status: VerificationStatus;
  readonly submittedAt: string | null;
  readonly latestSubmittedAt: string | null;
  readonly reviewedAt: string | null;
  readonly availableAssetTypes: readonly VerificationAssetType[];
  readonly reasonCode: string | null;
}

export interface AdminSecurityContext {
  readonly sessionToken: string;
  readonly csrfToken?: string;
  readonly origin: string;
  readonly fetchSite?: string;
}

@Injectable()
export class AdminVerificationService {
  public constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
    @Inject(AdminAuthService) private readonly adminAuth: AdminAuthService,
    @Inject(VERIFICATION_OBJECT_STORE) private readonly objectStore: VerificationObjectStore,
  ) {}

  public async list(
    context: AdminSecurityContext,
    campusId: string,
    cursor?: string,
    now = new Date(),
  ): Promise<{ items: readonly AdminVerificationResponse[]; nextCursor: string | null }> {
    await this.adminAuth.authenticate(context, {
      requireCsrf: true,
      role: "VERIFICATION_REVIEWER",
      campusId,
    });
    if (cursor !== undefined) {
      const cursorRecord = await this.prisma.studentVerification.findFirst({
        where: { id: cursor, campusId },
        select: { id: true },
      });
      if (cursorRecord === null) throw hiddenNotFound();
    }
    const items = await this.prisma.studentVerification.findMany({
      where: { campusId },
      include: { assets: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 51,
      ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
    });
    return {
      items: items.slice(0, 50).map((item) => toAdminVerification(item, now)),
      nextCursor: items.length > 50 ? (items[49]?.id ?? null) : null,
    };
  }

  public async get(
    context: AdminSecurityContext,
    verificationId: string,
    now = new Date(),
  ): Promise<AdminVerificationResponse> {
    const verification = await this.prisma.studentVerification.findUnique({
      where: { id: verificationId },
      include: { assets: true },
    });
    if (verification === null) throw hiddenNotFound();
    await this.adminAuth.authenticate(context, {
      requireCsrf: true,
      role: "VERIFICATION_REVIEWER",
      campusId: verification.campusId,
    });
    return toAdminVerification(verification, now);
  }

  public async review(
    context: AdminSecurityContext,
    verificationId: string,
    input: {
      readonly decision: "APPROVE" | "REJECT" | "REQUIRE_RESUBMISSION";
      readonly reasonCode?: string | undefined;
      readonly note?: string | undefined;
    },
    idempotencyKey: string,
    requestId: string,
    now = new Date(),
  ): Promise<AdminVerificationResponse> {
    const verification = await this.prisma.studentVerification.findUnique({
      where: { id: verificationId },
    });
    if (verification === null) throw hiddenNotFound();
    const principal = await this.adminAuth.authenticate(context, {
      requireCsrf: true,
      role: "VERIFICATION_REVIEWER",
      campusId: verification.campusId,
    });
    const result = await this.idempotency.execute(
      "reviewVerification",
      idempotencyKey,
      { adminUserId: principal.adminUserId, campusId: verification.campusId },
      { verificationId, ...input },
      async (transaction) => {
        const current = await transaction.studentVerification.findUnique({
          where: { id: verificationId },
          include: { assets: true },
        });
        if (
          current === null ||
          current.campusId !== verification.campusId ||
          (current.status !== VerificationStatus.PENDING &&
            current.status !== VerificationStatus.RESUBMISSION_PENDING)
        ) {
          throw new ApplicationError("IDEMPOTENCY_CONFLICT", "verification is not reviewable", 409);
        }
        if (current.assets.length === 0) throw hiddenNotFound();
        const transition = reviewTransition(input, now);
        const updated = await transaction.studentVerification.update({
          where: { id: current.id },
          data: transition,
          include: { assets: true },
        });
        const deleteAfter = new Date(now.getTime() + REVIEW_MATERIAL_RETENTION_MS);
        await transaction.verificationAsset.updateMany({
          where: { verificationId: current.id, deletedAt: null, deletionClaimedAt: null },
          data: { deleteAfter },
        });
        await transaction.outboxEvent.create({
          data: {
            campusId: current.campusId,
            aggregateType: "StudentVerification",
            aggregateId: current.id,
            eventType: "VERIFICATION_ASSET_DELETE_DUE",
            payload: { verificationId: current.id },
            availableAt: deleteAfter,
          },
        });
        await transaction.auditLog.create({
          data: {
            actorAdminId: principal.adminUserId,
            campusId: current.campusId,
            action: "VERIFICATION_REVIEWED",
            targetType: "StudentVerification",
            targetId: current.id,
            requestId,
            beforeDigest: sha256Hex(`${current.status}:${current.reasonCode ?? ""}`),
            afterDigest: sha256Hex(
              `${transition.status}:${transition.reasonCode ?? ""}:${input.note ?? ""}`,
            ),
            ...(transition.reasonCode === null ? {} : { reasonCode: transition.reasonCode }),
          },
        });
        return { status: 200, body: toAdminVerification(updated, now) };
      },
      now,
    );
    return result.body;
  }

  public async issueAssetAccess(
    context: AdminSecurityContext,
    verificationId: string,
    assetType: VerificationAssetType,
    reauthTotpCode: string,
    idempotencyKey: string,
    requestId: string,
    now = new Date(),
  ): Promise<{
    readonly consumePath: "/v1/admin/verification-assets/consume";
    readonly grantToken: string;
    readonly expiresAt: string;
    readonly singleUse: true;
  }> {
    const verification = await this.prisma.studentVerification.findUnique({
      where: { id: verificationId },
      include: { assets: true },
    });
    if (verification === null) throw hiddenNotFound();
    const principal = await this.adminAuth.authenticate(context, {
      requireCsrf: true,
      role: "VERIFICATION_REVIEWER",
      campusId: verification.campusId,
    });
    const actor = { adminUserId: principal.adminUserId, campusId: verification.campusId } as const;
    const request = { verificationId, assetType, reauthTotpCode } as const;
    const replay = await this.idempotency.findReplay<{
      readonly consumePath: "/v1/admin/verification-assets/consume";
      readonly grantToken: string;
      readonly expiresAt: string;
      readonly singleUse: true;
    }>("issueVerificationAssetAccess", idempotencyKey, actor, request, now);
    if (replay !== null) return replay.body;
    const grantToken = randomOpaqueToken(32);
    const expiresAt = new Date(now.getTime() + ASSET_GRANT_LIFETIME_MS);
    try {
      const result = await this.idempotency.execute(
        "issueVerificationAssetAccess",
        idempotencyKey,
        actor,
        request,
        async (transaction) => {
          const current = await transaction.studentVerification.findUnique({
            where: { id: verificationId },
            include: { assets: true },
          });
          const asset = current?.assets.find((candidate) => candidate.type === assetType);
          if (
            current === null ||
            asset === undefined ||
            current.campusId !== verification.campusId ||
            asset.deletedAt !== null ||
            asset.deletionClaimedAt !== null ||
            (asset.deleteAfter !== null && asset.deleteAfter <= now) ||
            asset.contentDigest === null ||
            asset.contentType === null
          ) {
            throw hiddenNotFound();
          }
          await this.adminAuth.verifyReauthenticationTotp(
            principal,
            reauthTotpCode,
            "verification-asset-access",
            transaction,
            now,
          );
          await transaction.verificationAssetAccessGrant.create({
            data: {
              campusId: verification.campusId,
              verificationId,
              verificationAssetId: asset.id,
              adminUserId: principal.adminUserId,
              adminSessionId: principal.sessionId,
              tokenDigest: sha256Hex(grantToken),
              requestId,
              expiresAt,
            },
          });
          await transaction.idempotencyRecord.create({
            data: {
              scope: "verification-asset-grant-binding",
              key: sha256Hex(grantToken),
              campusId: current.campusId,
              adminUserId: principal.adminUserId,
              requestDigest: sha256Hex(asset.objectKey),
              expiresAt,
            },
          });
          await transaction.auditLog.create({
            data: {
              actorAdminId: principal.adminUserId,
              campusId: verification.campusId,
              action: "VERIFICATION_ASSET_GRANT_ISSUED",
              targetType: "StudentVerification",
              targetId: verificationId,
              requestId,
              afterDigest: sha256Hex(grantToken),
              reasonCode: "TOTP_REAUTHENTICATED",
            },
          });
          return {
            status: 201,
            body: {
              consumePath: "/v1/admin/verification-assets/consume" as const,
              grantToken,
              expiresAt: expiresAt.toISOString(),
              singleUse: true as const,
            },
          };
        },
        now,
      );
      return result.body;
    } catch (error) {
      if (isUniqueConstraint(error)) {
        throw new ApplicationError(
          "ADMIN_REAUTH_REQUIRED",
          "administrator reauthentication failed",
          403,
        );
      }
      throw error;
    }
  }

  public async consumeAssetAccess(
    context: AdminSecurityContext,
    grantToken: string,
    requestId: string,
    now = new Date(),
  ): Promise<{ readonly content: Buffer; readonly contentType: string }> {
    const tokenDigest = sha256Hex(grantToken);
    const grant = await this.prisma.verificationAssetAccessGrant.findUnique({
      where: { tokenDigest },
    });
    if (grant === null) throw hiddenNotFound();
    const principal = await this.adminAuth.authenticate(context, {
      requireCsrf: true,
      role: "VERIFICATION_REVIEWER",
      campusId: grant.campusId,
    });
    const auditId = randomUUID();
    const consumed = await this.prisma.$queryRaw<
      readonly {
        grantId: string;
        verificationId: string;
        verificationAssetId: string;
        adminUserId: string;
      }[]
    >(Prisma.sql`
      SELECT * FROM "consume_verification_asset_access_grant"(
        ${tokenDigest}::CHAR(64),
        ${principal.sessionId}::UUID,
        ${grant.campusId}::UUID,
        ${auditId}::UUID,
        ${requestId}::VARCHAR(100)
      )
    `);
    const result = consumed[0];
    if (result === undefined || result.adminUserId !== principal.adminUserId)
      throw hiddenNotFound();
    const asset = await this.prisma.verificationAsset.findUnique({
      where: { id: result.verificationAssetId },
    });
    const binding = await this.prisma.idempotencyRecord.findUnique({
      where: {
        scope_key: { scope: "verification-asset-grant-binding", key: tokenDigest },
      },
    });
    if (
      asset === null ||
      binding === null ||
      binding.adminUserId !== principal.adminUserId ||
      binding.campusId !== grant.campusId ||
      binding.requestDigest !== sha256Hex(asset.objectKey) ||
      asset.deletedAt !== null ||
      asset.deletionClaimedAt !== null ||
      (asset.deleteAfter !== null && asset.deleteAfter <= now) ||
      (asset.contentType !== "image/jpeg" && asset.contentType !== "image/png")
    ) {
      throw hiddenNotFound();
    }
    return {
      content: await this.objectStore.read(asset.objectKey),
      contentType: asset.contentType,
    };
  }
}

function toAdminVerification(
  verification: {
    readonly id: string;
    readonly campusId: string;
    readonly studentNumberLast4: string;
    readonly status: VerificationStatus;
    readonly submittedAt: Date | null;
    readonly latestSubmittedAt: Date | null;
    readonly reviewedAt: Date | null;
    readonly reasonCode: string | null;
    readonly assets: readonly {
      readonly type: VerificationAssetType;
      readonly contentDigest: string | null;
      readonly contentType: string | null;
      readonly deletedAt: Date | null;
      readonly deletionClaimedAt: Date | null;
      readonly deleteAfter: Date | null;
    }[];
  },
  now: Date,
): AdminVerificationResponse {
  return {
    id: verification.id,
    campusId: verification.campusId,
    studentNumberLast4: verification.studentNumberLast4,
    status: verification.status,
    submittedAt: verification.submittedAt?.toISOString() ?? null,
    latestSubmittedAt: verification.latestSubmittedAt?.toISOString() ?? null,
    reviewedAt: verification.reviewedAt?.toISOString() ?? null,
    availableAssetTypes: [
      VerificationAssetType.STUDENT_CARD,
      VerificationAssetType.WECOM_SCREENSHOT,
    ].filter((type) =>
      verification.assets.some(
        (asset) =>
          asset.type === type &&
          asset.contentDigest !== null &&
          asset.contentType !== null &&
          asset.deletedAt === null &&
          asset.deletionClaimedAt === null &&
          (asset.deleteAfter === null || asset.deleteAfter > now),
      ),
    ),
    reasonCode: verification.reasonCode,
  };
}

function reviewTransition(
  input: {
    readonly decision: "APPROVE" | "REJECT" | "REQUIRE_RESUBMISSION";
    readonly reasonCode?: string | undefined;
  },
  now: Date,
): {
  readonly status: VerificationStatus;
  readonly reviewedAt: Date;
  readonly expiresAt: Date | null;
  readonly reasonCode: string | null;
} {
  if (input.decision === "APPROVE") {
    return {
      status: VerificationStatus.VERIFIED,
      reviewedAt: now,
      expiresAt: new Date(now.getTime() + VERIFIED_CREDENTIAL_LIFETIME_MS),
      reasonCode: null,
    };
  }
  if (input.reasonCode === undefined || !/^[A-Z0-9_]{1,100}$/.test(input.reasonCode)) {
    throw new ApplicationError("VALIDATION_ERROR", "reasonCode is required", 400, {
      field: "reasonCode",
      constraint: "required-for-decision",
    });
  }
  return {
    status:
      input.decision === "REJECT"
        ? VerificationStatus.REJECTED
        : VerificationStatus.REQUIRE_RESUBMISSION,
    reviewedAt: now,
    expiresAt: null,
    reasonCode: input.reasonCode,
  };
}

function hiddenNotFound(): ApplicationError {
  return new ApplicationError("RESOURCE_NOT_FOUND", "resource was not found", 404);
}

function isUniqueConstraint(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

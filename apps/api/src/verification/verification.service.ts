import { randomUUID } from "node:crypto";
import { normalizeAndDigestStudentNumber } from "@campus/auth";
import {
  type GenderDeclaration,
  PolicyType,
  Prisma,
  VerificationAssetType,
  VerificationStatus,
} from "@campus/database";
import type {
  VerificationObjectMetadata,
  VerificationObjectStore,
  VerificationUploadGrant,
} from "@campus/verification";
import { Inject, Injectable } from "@nestjs/common";
import type { AuthenticatedUser } from "../auth/auth.service";
import { ApplicationError } from "../common/application-error";
import { APP_CONFIG, type AppConfig } from "../config";
import { PrismaService } from "../database/prisma.service";
import { IdempotencyService } from "../m2/idempotency.service";
import { VERIFICATION_OBJECT_STORE } from "../m2/providers";

const UPLOAD_LIFETIME_MS = 15 * 60 * 1_000;
const EVIDENCE_TYPE_ORDER = [
  VerificationAssetType.STUDENT_CARD,
  VerificationAssetType.WECOM_SCREENSHOT,
] as const;

export interface VerificationResponse {
  readonly id: string;
  readonly campusId: string;
  readonly studentNumberLast4: string;
  readonly status: VerificationStatus;
  readonly evidenceTypes: readonly VerificationAssetType[];
  readonly submittedAt: string | null;
  readonly latestSubmittedAt: string | null;
  readonly reviewedAt: string | null;
  readonly expiresAt: string | null;
  readonly reasonCode: string | null;
}

export interface VerificationUploadResponse {
  readonly verification: VerificationResponse;
  readonly uploads: readonly {
    readonly type: VerificationAssetType;
    readonly uploadUrl: string;
    readonly uploadExpiresAt: string;
  }[];
}

interface CreateVerificationInput {
  readonly campusId: string;
  readonly studentNumber: string;
  readonly genderDeclaration: GenderDeclaration;
  readonly sensitiveInfoConsentVersion: string;
  readonly evidenceTypes: readonly VerificationAssetType[];
}

interface SubmittedUpload {
  readonly type: VerificationAssetType;
  readonly uploadEtag: string;
}

@Injectable()
export class VerificationService {
  public constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(VERIFICATION_OBJECT_STORE) private readonly objectStore: VerificationObjectStore,
  ) {}

  public async create(
    principal: AuthenticatedUser,
    input: CreateVerificationInput,
    idempotencyKey: string,
    now = new Date(),
  ): Promise<VerificationUploadResponse> {
    if (principal.campusId !== input.campusId) throw forbidden();
    if (Buffer.byteLength(this.config.studentNumberHmacSecret, "utf8") < 32) {
      throw new ApplicationError("INTERNAL_ERROR", "student identity hashing is unavailable", 503);
    }
    const evidenceTypes = normalizeEvidenceTypes(input.evidenceTypes);
    const identity = normalizeAndDigestStudentNumber(
      input.studentNumber,
      this.config.studentNumberHmacSecret,
    );
    try {
      const result = await this.idempotency.execute(
        "createVerification",
        idempotencyKey,
        { userId: principal.userId, campusId: principal.campusId },
        { ...input, evidenceTypes },
        async (transaction) => {
          const policy = await activePolicy(transaction, input.sensitiveInfoConsentVersion, now);
          const current = await transaction.studentVerification.findFirst({
            where: { userId: principal.userId },
            include: { assets: true },
            orderBy: { createdAt: "desc" },
          });
          if (current !== null && !canCreateAfter(current.status)) {
            throw new ApplicationError("IDEMPOTENCY_CONFLICT", "verification already exists", 409);
          }
          if (current !== null && current.studentNumberDigest !== identity.digest) {
            throw new ApplicationError(
              "IDEMPOTENCY_CONFLICT",
              "student verification identity cannot be changed",
              409,
            );
          }

          const verificationId = current?.id ?? randomUUID();
          const uploads = issueUploads(
            this.objectStore,
            principal.campusId,
            verificationId,
            evidenceTypes,
            now,
          );
          await transaction.user.update({
            where: { id: principal.userId },
            data: { genderDeclaration: input.genderDeclaration },
          });

          let verification: Prisma.StudentVerificationGetPayload<{ include: { assets: true } }>;
          if (current === null) {
            verification = await transaction.studentVerification.create({
              data: {
                id: verificationId,
                userId: principal.userId,
                campusId: principal.campusId,
                studentNumberDigest: identity.digest,
                studentNumberLast4: identity.last4,
                consentPolicyId: policy.id,
                assets: {
                  create: assetCreateRows(principal.campusId, uploads),
                },
              },
              include: { assets: true },
            });
          } else {
            await retireAndReplaceAssets(transaction, current, uploads, now);
            verification = await transaction.studentVerification.update({
              where: { id: current.id },
              data: {
                status: VerificationStatus.AWAITING_UPLOAD,
                consentPolicyId: policy.id,
                submittedAt: null,
                latestSubmittedAt: null,
                reviewedAt: null,
                expiresAt: null,
                reasonCode: null,
              },
              include: { assets: true },
            });
          }
          return {
            status: 201,
            body: uploadResponse(verification, uploads),
          };
        },
        now,
      );
      return result.body;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ApplicationError(
          "IDEMPOTENCY_CONFLICT",
          "student verification cannot be created",
          409,
        );
      }
      throw error;
    }
  }

  public async current(
    principal: AuthenticatedUser,
    now = new Date(),
  ): Promise<VerificationResponse> {
    const verification = await this.prisma.studentVerification.findFirst({
      where: { userId: principal.userId, campusId: principal.campusId },
      include: { assets: { where: { deletedAt: null, deletionClaimedAt: null } } },
      orderBy: { createdAt: "desc" },
    });
    if (verification === null) throw notFound();
    if (
      verification.status === VerificationStatus.VERIFIED &&
      (verification.expiresAt === null || verification.expiresAt <= now)
    ) {
      const expired = await this.prisma.studentVerification.update({
        where: { id: verification.id },
        data: { status: VerificationStatus.VERIFICATION_EXPIRED, reasonCode: "CREDENTIAL_EXPIRED" },
        include: { assets: { where: { deletedAt: null, deletionClaimedAt: null } } },
      });
      return toVerificationResponse(expired);
    }
    return toVerificationResponse(verification);
  }

  public async submit(
    principal: AuthenticatedUser,
    verificationId: string,
    submittedUploads: readonly SubmittedUpload[],
    idempotencyKey: string,
    now = new Date(),
  ): Promise<VerificationResponse> {
    const uploads = normalizeSubmittedUploads(submittedUploads);
    const actor = { userId: principal.userId, campusId: principal.campusId } as const;
    const request = { verificationId, uploads } as const;
    const replay = await this.idempotency.findReplay<VerificationResponse>(
      "submitVerification",
      idempotencyKey,
      actor,
      request,
      now,
    );
    if (replay !== null) return replay.body;

    const candidate = await this.prisma.studentVerification.findFirst({
      where: { id: verificationId, userId: principal.userId, campusId: principal.campusId },
      include: { assets: { where: { deletedAt: null, deletionClaimedAt: null } } },
    });
    if (candidate === null || candidate.assets.length === 0) throw notFound();
    assertUploadsMatchAssets(uploads, candidate.assets);
    if (candidate.assets.some((asset) => asset.uploadExpiresAt <= now)) {
      await this.prisma.$transaction(async (transaction) => {
        await transaction.studentVerification.updateMany({
          where: {
            id: candidate.id,
            status: {
              in: [
                VerificationStatus.AWAITING_UPLOAD,
                VerificationStatus.RESUBMISSION_AWAITING_UPLOAD,
              ],
            },
          },
          data: {
            status: VerificationStatus.UPLOAD_EXPIRED,
            reasonCode: "UPLOAD_CREDENTIAL_EXPIRED",
          },
        });
        await transaction.verificationAsset.updateMany({
          where: { verificationId: candidate.id, deletedAt: null, deletionClaimedAt: null },
          data: { deleteAfter: now },
        });
      });
      throw new ApplicationError("VERIFICATION_UPLOAD_EXPIRED", "upload credential expired", 409);
    }

    const metadataByType = new Map<VerificationAssetType, VerificationObjectMetadata>();
    for (const asset of candidate.assets) {
      const submitted = uploads.find((item) => item.type === asset.type);
      if (submitted === undefined) throw invalidAsset();
      const metadata = await this.objectStore.head(asset.objectKey);
      if (metadata === null || metadata.contentDigest !== submitted.uploadEtag)
        throw invalidAsset();
      metadataByType.set(asset.type, metadata);
    }

    const result = await this.idempotency.execute(
      "submitVerification",
      idempotencyKey,
      actor,
      request,
      async (transaction) => {
        const current = await transaction.studentVerification.findFirst({
          where: { id: verificationId, userId: principal.userId, campusId: principal.campusId },
          include: { assets: { where: { deletedAt: null, deletionClaimedAt: null } } },
        });
        if (current === null || current.assets.length === 0) throw notFound();
        assertUploadsMatchAssets(uploads, current.assets);
        const nextStatus = submissionStatus(current.status);
        for (const asset of current.assets) {
          const metadata = metadataByType.get(asset.type);
          if (metadata === undefined) throw invalidAsset();
          const updated = await transaction.verificationAsset.updateMany({
            where: {
              id: asset.id,
              objectKey: asset.objectKey,
              deletedAt: null,
              deletionClaimedAt: null,
            },
            data: {
              contentDigest: metadata.contentDigest,
              contentType: metadata.contentType,
              sizeBytes: metadata.sizeBytes,
              deleteAfter: null,
            },
          });
          if (updated.count !== 1)
            throw new ApplicationError("IDEMPOTENCY_CONFLICT", "asset changed", 409);
        }
        const updated = await transaction.studentVerification.update({
          where: { id: current.id },
          data: {
            status: nextStatus,
            submittedAt: current.submittedAt ?? now,
            latestSubmittedAt: now,
            ...(nextStatus === VerificationStatus.RESUBMISSION_PENDING
              ? {}
              : { reviewedAt: null, reasonCode: null }),
          },
          include: { assets: { where: { deletedAt: null, deletionClaimedAt: null } } },
        });
        return { status: 202, body: toVerificationResponse(updated) };
      },
      now,
    );
    return result.body;
  }

  public async createResubmissionUpload(
    principal: AuthenticatedUser,
    verificationId: string,
    evidenceTypesInput: readonly VerificationAssetType[],
    idempotencyKey: string,
    now = new Date(),
  ): Promise<VerificationUploadResponse> {
    const evidenceTypes = normalizeEvidenceTypes(evidenceTypesInput);
    const actor = { userId: principal.userId, campusId: principal.campusId } as const;
    const request = { verificationId, evidenceTypes } as const;
    const replay = await this.idempotency.findReplay<VerificationUploadResponse>(
      "createResubmissionUpload",
      idempotencyKey,
      actor,
      request,
      now,
    );
    if (replay !== null) return replay.body;
    const uploads = issueUploads(
      this.objectStore,
      principal.campusId,
      verificationId,
      evidenceTypes,
      now,
    );
    const result = await this.idempotency.execute(
      "createResubmissionUpload",
      idempotencyKey,
      actor,
      request,
      async (transaction) => {
        const current = await transaction.studentVerification.findFirst({
          where: { id: verificationId, userId: principal.userId, campusId: principal.campusId },
          include: { assets: true },
        });
        if (current === null) throw notFound();
        const claimed = await transaction.studentVerification.updateMany({
          where: { id: current.id, status: VerificationStatus.REQUIRE_RESUBMISSION },
          data: { status: VerificationStatus.RESUBMISSION_AWAITING_UPLOAD },
        });
        if (claimed.count !== 1) {
          throw new ApplicationError(
            "IDEMPOTENCY_CONFLICT",
            "verification cannot be resubmitted",
            409,
          );
        }
        await retireAndReplaceAssets(transaction, current, uploads, now);
        const updated = await transaction.studentVerification.findUniqueOrThrow({
          where: { id: current.id },
          include: { assets: true },
        });
        return { status: 201, body: uploadResponse(updated, uploads) };
      },
      now,
    );
    return result.body;
  }
}

async function activePolicy(
  transaction: Prisma.TransactionClient,
  version: string,
  now: Date,
): Promise<{ readonly id: string }> {
  const policy = await transaction.policyVersion.findFirst({
    where: {
      type: PolicyType.SENSITIVE_INFO,
      version,
      effectiveAt: { lte: now },
      OR: [{ retiredAt: null }, { retiredAt: { gt: now } }],
    },
  });
  if (policy === null) {
    throw new ApplicationError("VALIDATION_ERROR", "consent policy is invalid", 400, {
      field: "sensitiveInfoConsentVersion",
      constraint: "active-policy-version",
    });
  }
  return policy;
}

function issueUploads(
  objectStore: VerificationObjectStore,
  campusId: string,
  verificationId: string,
  evidenceTypes: readonly VerificationAssetType[],
  now: Date,
): readonly { readonly type: VerificationAssetType; readonly grant: VerificationUploadGrant }[] {
  const expiresAt = new Date(now.getTime() + UPLOAD_LIFETIME_MS);
  return evidenceTypes.map((type) => ({
    type,
    grant: objectStore.issueUpload({ campusId, verificationId, expiresAt }),
  }));
}

function assetCreateRows(
  campusId: string,
  uploads: readonly {
    readonly type: VerificationAssetType;
    readonly grant: VerificationUploadGrant;
  }[],
): Prisma.VerificationAssetCreateWithoutVerificationInput[] {
  return uploads.map(({ type, grant }) => ({
    campusId,
    type,
    objectKey: grant.objectKey,
    uploadExpiresAt: grant.uploadExpiresAt,
    deleteAfter: grant.uploadExpiresAt,
  }));
}

async function retireAndReplaceAssets(
  transaction: Prisma.TransactionClient,
  current: {
    readonly id: string;
    readonly campusId: string;
    readonly assets: readonly {
      readonly id: string;
      readonly type: VerificationAssetType;
      readonly objectKey: string;
      readonly deletedAt: Date | null;
    }[];
  },
  uploads: readonly {
    readonly type: VerificationAssetType;
    readonly grant: VerificationUploadGrant;
  }[],
  now: Date,
): Promise<void> {
  const replacementTypes = new Set(uploads.map((item) => item.type));
  for (const oldAsset of current.assets) {
    if (oldAsset.deletedAt === null) {
      await transaction.outboxEvent.create({
        data: {
          campusId: current.campusId,
          aggregateType: "StudentVerification",
          aggregateId: current.id,
          eventType: "VERIFICATION_ASSET_DELETE_OBJECT",
          payload: { objectKey: oldAsset.objectKey },
          availableAt: now,
        },
      });
    }
    if (!replacementTypes.has(oldAsset.type)) {
      await transaction.verificationAsset.update({
        where: { id: oldAsset.id },
        data: { deleteAfter: now, deletionClaimedAt: null, deletedAt: now },
      });
    }
  }
  for (const { type, grant } of uploads) {
    await transaction.verificationAsset.upsert({
      where: { verificationId_type: { verificationId: current.id, type } },
      create: {
        campusId: current.campusId,
        verificationId: current.id,
        type,
        objectKey: grant.objectKey,
        uploadExpiresAt: grant.uploadExpiresAt,
        deleteAfter: grant.uploadExpiresAt,
      },
      update: {
        objectKey: grant.objectKey,
        uploadExpiresAt: grant.uploadExpiresAt,
        deleteAfter: grant.uploadExpiresAt,
        deletedAt: null,
        deletionClaimedAt: null,
        contentDigest: null,
        contentType: null,
        sizeBytes: null,
      },
    });
  }
}

function uploadResponse(
  verification: Parameters<typeof toVerificationResponse>[0],
  uploads: readonly {
    readonly type: VerificationAssetType;
    readonly grant: VerificationUploadGrant;
  }[],
): VerificationUploadResponse {
  return {
    verification: toVerificationResponse(verification),
    uploads: uploads.map(({ type, grant }) => ({
      type,
      uploadUrl: grant.uploadUrl,
      uploadExpiresAt: grant.uploadExpiresAt.toISOString(),
    })),
  };
}

function toVerificationResponse(verification: {
  readonly id: string;
  readonly campusId: string;
  readonly studentNumberLast4: string;
  readonly status: VerificationStatus;
  readonly submittedAt: Date | null;
  readonly latestSubmittedAt: Date | null;
  readonly reviewedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly reasonCode: string | null;
  readonly assets: readonly {
    readonly type: VerificationAssetType;
    readonly deletedAt: Date | null;
    readonly deletionClaimedAt: Date | null;
  }[];
}): VerificationResponse {
  return {
    id: verification.id,
    campusId: verification.campusId,
    studentNumberLast4: verification.studentNumberLast4,
    status: verification.status,
    evidenceTypes: sortEvidenceTypes(
      verification.assets
        .filter((asset) => asset.deletedAt === null && asset.deletionClaimedAt === null)
        .map((asset) => asset.type),
    ),
    submittedAt: verification.submittedAt?.toISOString() ?? null,
    latestSubmittedAt: verification.latestSubmittedAt?.toISOString() ?? null,
    reviewedAt: verification.reviewedAt?.toISOString() ?? null,
    expiresAt: verification.expiresAt?.toISOString() ?? null,
    reasonCode: verification.reasonCode,
  };
}

function normalizeEvidenceTypes(
  types: readonly VerificationAssetType[],
): readonly VerificationAssetType[] {
  const unique = new Set(types);
  if (unique.size < 1 || unique.size > EVIDENCE_TYPE_ORDER.length || unique.size !== types.length) {
    throw new ApplicationError(
      "VALIDATION_ERROR",
      "one or two unique evidence types are required",
      400,
      {
        field: "evidenceTypes",
        constraint: "one-or-two-unique-types",
      },
    );
  }
  for (const type of unique) {
    if (!EVIDENCE_TYPE_ORDER.includes(type)) throw invalidAsset();
  }
  return sortEvidenceTypes([...unique]);
}

function normalizeSubmittedUploads(
  uploads: readonly SubmittedUpload[],
): readonly SubmittedUpload[] {
  const types = normalizeEvidenceTypes(uploads.map((upload) => upload.type));
  const byType = new Map(uploads.map((upload) => [upload.type, upload.uploadEtag.toLowerCase()]));
  return types.map((type) => ({ type, uploadEtag: byType.get(type) ?? "" }));
}

function sortEvidenceTypes(
  types: readonly VerificationAssetType[],
): readonly VerificationAssetType[] {
  return EVIDENCE_TYPE_ORDER.filter((type) => types.includes(type));
}

function assertUploadsMatchAssets(
  uploads: readonly SubmittedUpload[],
  assets: readonly { readonly type: VerificationAssetType }[],
): void {
  if (
    uploads.length !== assets.length ||
    uploads.some((upload) => !assets.some((asset) => asset.type === upload.type))
  ) {
    throw invalidAsset();
  }
}

function canCreateAfter(status: VerificationStatus): boolean {
  return (
    status === VerificationStatus.REJECTED || status === VerificationStatus.VERIFICATION_EXPIRED
  );
}

function submissionStatus(status: VerificationStatus): VerificationStatus {
  if (status === VerificationStatus.AWAITING_UPLOAD) return VerificationStatus.PENDING;
  if (status === VerificationStatus.RESUBMISSION_AWAITING_UPLOAD) {
    return VerificationStatus.RESUBMISSION_PENDING;
  }
  throw new ApplicationError("IDEMPOTENCY_CONFLICT", "verification is not awaiting upload", 409);
}

function invalidAsset(): ApplicationError {
  return new ApplicationError("VERIFICATION_ASSET_INVALID", "verification asset is invalid", 409);
}

function forbidden(): ApplicationError {
  return new ApplicationError("RESOURCE_FORBIDDEN", "resource is not available", 403);
}

function notFound(): ApplicationError {
  return new ApplicationError("RESOURCE_NOT_FOUND", "resource was not found", 404);
}

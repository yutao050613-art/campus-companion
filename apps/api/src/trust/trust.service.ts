import { sha256Hex } from "@campus/auth";
import {
  AccountStatus,
  type Prisma,
  type ReportCategory,
  VerificationStatus,
} from "@campus/database";
import { Inject, Injectable } from "@nestjs/common";
import type { AuthenticatedUser } from "../auth/auth.service";
import { ApplicationError } from "../common/application-error";
import { IdempotencyService } from "../m2/idempotency.service";

const MAX_REPORTS_PER_HOUR = 5;
const REPORT_WINDOW_MS = 60 * 60 * 1_000;
type Transaction = Prisma.TransactionClient;

export interface CreateReportInput {
  readonly groupId: string;
  readonly subjectUserId?: string | null | undefined;
  readonly category: ReportCategory;
  readonly description: string;
}

export interface ReportResponse {
  readonly id: string;
  readonly status: "OPEN" | "REVIEWING" | "RESOLVED" | "REJECTED";
  readonly createdAt: string;
}

@Injectable()
export class TrustService {
  public constructor(
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
  ) {}

  public async createReport(
    principal: AuthenticatedUser,
    input: CreateReportInput,
    idempotencyKey: string,
    now = new Date(),
  ): Promise<ReportResponse> {
    const description = normalizeDescription(input.description);
    const result = await this.idempotency.execute(
      "createReport",
      idempotencyKey,
      principal,
      { ...input, description },
      async (transaction) => {
        await requireEligibleReporter(transaction, principal, now);
        const recentCount = await transaction.report.count({
          where: {
            campusId: principal.campusId,
            reporterId: principal.userId,
            createdAt: { gte: new Date(now.getTime() - REPORT_WINDOW_MS) },
          },
        });
        if (recentCount >= MAX_REPORTS_PER_HOUR) {
          throw new ApplicationError("RATE_LIMITED", "report submission rate is limited", 429, {
            retryAfterSeconds: Math.ceil(REPORT_WINDOW_MS / 1_000),
          });
        }
        const group = await transaction.companionGroup.findFirst({
          where: { id: input.groupId, campusId: principal.campusId },
          include: { members: { select: { userId: true } } },
        });
        if (group === null || !group.members.some((member) => member.userId === principal.userId)) {
          throw new ApplicationError("RESOURCE_NOT_FOUND", "group is unavailable", 404);
        }
        if (input.subjectUserId === principal.userId) {
          throw new ApplicationError("VALIDATION_ERROR", "cannot report yourself", 400, {
            field: "subjectUserId",
            constraint: "not_self",
          });
        }
        if (
          input.subjectUserId !== undefined &&
          input.subjectUserId !== null &&
          !group.members.some((member) => member.userId === input.subjectUserId)
        ) {
          throw new ApplicationError("RESOURCE_NOT_FOUND", "report subject is unavailable", 404);
        }
        const report = await transaction.report.create({
          data: {
            campusId: principal.campusId,
            reporterId: principal.userId,
            groupId: group.id,
            ...(input.subjectUserId === undefined || input.subjectUserId === null
              ? {}
              : { subjectUserId: input.subjectUserId }),
            category: input.category,
            description,
          },
        });
        await transaction.outboxEvent.create({
          data: {
            campusId: principal.campusId,
            aggregateType: "Report",
            aggregateId: report.id,
            eventType: "ReportCreated",
            payload: {
              category: report.category,
              evidenceDigest: sha256Hex(`${report.id}:${reporterSubject(principal)}`),
            },
          },
        });
        return { status: 201, body: reportResponse(report) };
      },
      now,
      { serializableAttempts: 5 },
    );
    return result.body;
  }

  public async blockUser(
    principal: AuthenticatedUser,
    blockedUserId: string,
    idempotencyKey: string,
    now = new Date(),
  ): Promise<void> {
    await this.idempotency.execute(
      "blockUser",
      idempotencyKey,
      principal,
      { blockedUserId },
      async (transaction) => {
        await requireEligibleReporter(transaction, principal, now);
        if (blockedUserId === principal.userId) {
          throw new ApplicationError("VALIDATION_ERROR", "cannot block yourself", 400, {
            field: "userId",
            constraint: "not_self",
          });
        }
        const target = await transaction.user.findFirst({
          where: { id: blockedUserId, campusId: principal.campusId, deletedAt: null },
          select: { id: true },
        });
        if (target === null)
          throw new ApplicationError("RESOURCE_NOT_FOUND", "user is unavailable", 404);
        await transaction.blockRelation.upsert({
          where: { blockerId_blockedId: { blockerId: principal.userId, blockedId: target.id } },
          create: {
            campusId: principal.campusId,
            blockerId: principal.userId,
            blockedId: target.id,
          },
          update: {},
        });
        await transaction.outboxEvent.create({
          data: {
            campusId: principal.campusId,
            aggregateType: "BlockRelation",
            aggregateId: principal.userId,
            eventType: "UserBlocked",
            payload: { blockedUserDigest: sha256Hex(target.id) },
          },
        });
        return { status: 204, body: {} };
      },
      now,
      { serializableAttempts: 5 },
    );
  }

  public async unblockUser(
    principal: AuthenticatedUser,
    blockedUserId: string,
    idempotencyKey: string,
    now = new Date(),
  ): Promise<void> {
    await this.idempotency.execute(
      "unblockUser",
      idempotencyKey,
      principal,
      { blockedUserId },
      async (transaction) => {
        await requireEligibleReporter(transaction, principal, now);
        const deleted = await transaction.blockRelation.deleteMany({
          where: {
            campusId: principal.campusId,
            blockerId: principal.userId,
            blockedId: blockedUserId,
          },
        });
        if (deleted.count !== 1)
          throw new ApplicationError("RESOURCE_NOT_FOUND", "block is unavailable", 404);
        await transaction.outboxEvent.create({
          data: {
            campusId: principal.campusId,
            aggregateType: "BlockRelation",
            aggregateId: principal.userId,
            eventType: "UserUnblocked",
            payload: { blockedUserDigest: sha256Hex(blockedUserId) },
          },
        });
        return { status: 204, body: {} };
      },
      now,
      { serializableAttempts: 5 },
    );
  }
}

function reportResponse(report: {
  readonly id: string;
  readonly status: "OPEN" | "REVIEWING" | "RESOLVED" | "REJECTED";
  readonly createdAt: Date;
}): ReportResponse {
  return { id: report.id, status: report.status, createdAt: report.createdAt.toISOString() };
}

async function requireEligibleReporter(
  transaction: Transaction,
  principal: AuthenticatedUser,
  now: Date,
): Promise<void> {
  const user = await transaction.user.findFirst({
    where: {
      id: principal.userId,
      campusId: principal.campusId,
      status: AccountStatus.ACTIVE,
      deletedAt: null,
      verifications: {
        some: { status: VerificationStatus.VERIFIED, expiresAt: { gt: now } },
      },
    },
    select: { id: true },
  });
  if (user === null) {
    throw new ApplicationError("STUDENT_NOT_VERIFIED", "active student verification required", 403);
  }
}

function normalizeDescription(value: string): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 1_000) {
    throw new ApplicationError("VALIDATION_ERROR", "report description is invalid", 400, {
      field: "description",
      constraint: "length",
    });
  }
  return normalized;
}

function reporterSubject(principal: AuthenticatedUser): string {
  return `${principal.campusId}:${principal.userId}`;
}

import { sha256Hex } from "@campus/auth";
import { AccountStatus, GroupState, ReportStatus, RiskDecision } from "@campus/database";
import { Inject, Injectable } from "@nestjs/common";
import { ApplicationError } from "../common/application-error";
import { PrismaService } from "../database/prisma.service";
import { IdempotencyService } from "../m2/idempotency.service";
import { AdminAuthService } from "./admin-auth.service";
import type { AdminSecurityContext } from "./admin-verification.service";

export interface AdminReportResponse {
  readonly id: string;
  readonly campusId: string;
  readonly groupId: string;
  readonly subjectUserId: string | null;
  readonly category: string;
  readonly description: string;
  readonly status: string;
  readonly createdAt: string;
}

export interface AdminReportDecisionInput {
  readonly decision: "REVIEW" | "RESOLVE" | "REJECT" | "RESTRICT_SUBJECT";
  readonly reasonCode: string;
}

@Injectable()
export class AdminTrustService {
  public constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
    @Inject(AdminAuthService) private readonly adminAuth: AdminAuthService,
  ) {}

  public async listReports(
    context: AdminSecurityContext,
    campusId: string,
    cursor?: string,
  ): Promise<{
    readonly items: readonly AdminReportResponse[];
    readonly nextCursor: string | null;
  }> {
    await this.adminAuth.authenticate(context, {
      requireCsrf: true,
      role: "SAFETY_REVIEWER",
      campusId,
    });
    if (cursor !== undefined) {
      const existing = await this.prisma.report.findFirst({
        where: { id: cursor, campusId },
        select: { id: true },
      });
      if (existing === null) throw hiddenNotFound();
    }
    const reports = await this.prisma.report.findMany({
      where: { campusId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 51,
      ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
    });
    return {
      items: reports.slice(0, 50).map(reportResponse),
      nextCursor: reports.length > 50 ? (reports[49]?.id ?? null) : null,
    };
  }

  public async decideReport(
    context: AdminSecurityContext,
    reportId: string,
    input: AdminReportDecisionInput,
    idempotencyKey: string,
    requestId: string,
    now = new Date(),
  ): Promise<AdminReportResponse> {
    const report = await this.prisma.report.findUnique({ where: { id: reportId } });
    if (report === null) throw hiddenNotFound();
    const principal = await this.adminAuth.authenticate(context, {
      requireCsrf: true,
      role: "SAFETY_REVIEWER",
      campusId: report.campusId,
    });
    const result = await this.idempotency.execute(
      "decideReport",
      idempotencyKey,
      { adminUserId: principal.adminUserId, campusId: report.campusId },
      { reportId, ...input },
      async (transaction) => {
        const current = await transaction.report.findUnique({
          where: { id: reportId },
          include: { group: true },
        });
        if (current === null || current.campusId !== report.campusId) throw hiddenNotFound();
        if (current.status !== ReportStatus.OPEN && current.status !== ReportStatus.REVIEWING) {
          throw new ApplicationError("IDEMPOTENCY_CONFLICT", "report is not actionable", 409);
        }
        if (input.decision === "RESTRICT_SUBJECT" && current.subjectUserId === null) {
          throw new ApplicationError(
            "VALIDATION_ERROR",
            "a subject is required for restriction",
            400,
            {
              field: "decision",
              constraint: "requires_subject",
            },
          );
        }
        const nextStatus = reportStatusFor(input.decision);
        const updated = await transaction.report.update({
          where: { id: current.id },
          data: { status: nextStatus },
        });
        if (input.decision === "RESTRICT_SUBJECT" && current.subjectUserId !== null) {
          await transaction.user.updateMany({
            where: {
              id: current.subjectUserId,
              campusId: current.campusId,
              status: AccountStatus.ACTIVE,
            },
            data: { status: AccountStatus.RESTRICTED },
          });
          await transaction.riskEvent.create({
            data: {
              campusId: current.campusId,
              userId: current.subjectUserId,
              ruleCode: "ADMIN_REPORT_RESTRICTION",
              ruleVersion: "m5-v1",
              evidenceDigest: sha256Hex(`${current.id}:${input.reasonCode}`),
              decision: RiskDecision.RESTRICT,
            },
          });
          if (current.group !== null && current.groupId !== null) {
            if (
              current.group.state === GroupState.RECRUITING ||
              current.group.state === GroupState.READY
            ) {
              await transaction.companionGroup.updateMany({
                where: {
                  id: current.groupId,
                  state: { in: [GroupState.RECRUITING, GroupState.READY] },
                },
                data: { state: GroupState.RISK_HOLD, version: { increment: 1 } },
              });
            } else if (
              current.group.state === GroupState.CONTACTS_UNLOCKED ||
              current.group.state === GroupState.COMPLETED
            ) {
              await transaction.companionGroup.updateMany({
                where: {
                  id: current.groupId,
                  state: { in: [GroupState.CONTACTS_UNLOCKED, GroupState.COMPLETED] },
                },
                data: { state: GroupState.DISPUTED, version: { increment: 1 } },
              });
            }
          }
        }
        await transaction.auditLog.create({
          data: {
            actorAdminId: principal.adminUserId,
            campusId: current.campusId,
            action: "REPORT_DECISION",
            targetType: "Report",
            targetId: current.id,
            requestId,
            beforeDigest: sha256Hex(`${current.status}:${current.subjectUserId ?? "none"}`),
            afterDigest: sha256Hex(`${nextStatus}:${input.decision}`),
            reasonCode: input.reasonCode,
          },
        });
        await transaction.outboxEvent.create({
          data: {
            campusId: current.campusId,
            aggregateType: "Report",
            aggregateId: current.id,
            eventType: "ReportDecisionApplied",
            payload: { decision: input.decision, reasonCode: input.reasonCode },
          },
        });
        return { status: 200, body: reportResponse(updated) };
      },
      now,
      { serializableAttempts: 5 },
    );
    return result.body;
  }
}

function reportResponse(report: {
  readonly id: string;
  readonly campusId: string;
  readonly groupId: string | null;
  readonly subjectUserId: string | null;
  readonly category: string;
  readonly description: string;
  readonly status: string;
  readonly createdAt: Date;
}): AdminReportResponse {
  if (report.groupId === null) throw new Error("report lacks a required group reference");
  return {
    id: report.id,
    campusId: report.campusId,
    groupId: report.groupId,
    subjectUserId: report.subjectUserId,
    category: report.category,
    description: report.description,
    status: report.status,
    createdAt: report.createdAt.toISOString(),
  };
}

function reportStatusFor(decision: AdminReportDecisionInput["decision"]): ReportStatus {
  if (decision === "REVIEW") return ReportStatus.REVIEWING;
  if (decision === "REJECT") return ReportStatus.REJECTED;
  return ReportStatus.RESOLVED;
}

function hiddenNotFound(): ApplicationError {
  return new ApplicationError("RESOURCE_NOT_FOUND", "resource is unavailable", 404);
}

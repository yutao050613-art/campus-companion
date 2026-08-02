import { randomUUID } from "node:crypto";
import { GroupState, ReportStatus } from "@campus/database";
import { describe, expect, it, vi } from "vitest";
import type { AdminAuthService } from "../src/admin/admin-auth.service";
import { AdminTrustService } from "../src/admin/admin-trust.service";
import type { PrismaService } from "../src/database/prisma.service";
import type { IdempotencyService } from "../src/m2/idempotency.service";

const campusId = randomUUID();
const reportId = randomUUID();
const groupId = randomUUID();
const subjectUserId = randomUUID();
const adminUserId = randomUUID();
const now = new Date("2026-08-02T10:00:00.000Z");
const context = {
  sessionToken: "m5-admin-session",
  csrfToken: "m5-admin-csrf",
  origin: "http://127.0.0.1:5173",
};

function subject(
  options: {
    readonly subjectUserId?: string | null;
    readonly groupState?: GroupState | null;
    readonly outerStatus?: ReportStatus;
    readonly outerCampusId?: string | null;
    readonly currentStatus?: ReportStatus | null;
    readonly currentCampusId?: string;
  } = {},
) {
  const outerReport = {
    id: reportId,
    campusId: options.outerCampusId === undefined ? campusId : options.outerCampusId,
    groupId,
    subjectUserId: options.subjectUserId === undefined ? subjectUserId : options.subjectUserId,
    category: "HARASSMENT",
    description: "private report narrative",
    status: options.outerStatus ?? ReportStatus.OPEN,
    createdAt: now,
  };
  const transaction = {
    report: {
      findUnique: vi.fn().mockResolvedValue(
        options.currentStatus === null
          ? null
          : {
              ...outerReport,
              campusId: options.currentCampusId ?? outerReport.campusId,
              status: options.currentStatus ?? outerReport.status,
              group:
                options.groupState === null
                  ? null
                  : { id: groupId, state: options.groupState ?? GroupState.READY },
            },
      ),
      update: vi.fn().mockImplementation(({ data }) => ({ ...outerReport, status: data.status })),
    },
    user: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    riskEvent: { create: vi.fn().mockResolvedValue({}) },
    companionGroup: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    outboxEvent: { create: vi.fn().mockResolvedValue({}) },
  };
  const prisma = {
    report: {
      findUnique: vi.fn().mockResolvedValue(options.outerCampusId === null ? null : outerReport),
    },
  } as unknown as PrismaService;
  const idempotency = {
    execute: vi.fn(async (_operation, _key, _actor, _request, action) => ({
      ...(await action(transaction as never)),
      replayed: false,
    })),
  } as unknown as IdempotencyService;
  const adminAuth = {
    authenticate: vi.fn().mockResolvedValue({ adminUserId }),
  } as unknown as AdminAuthService;
  return {
    service: new AdminTrustService(prisma, idempotency, adminAuth),
    transaction,
    adminAuth,
  };
}

describe("M5 admin trust controls", () => {
  it("pages reports only inside the reviewer's campus and hides an invalid cursor", async () => {
    const reports = Array.from({ length: 51 }, (_, index) => ({
      id: `${reportId}-${index}`,
      campusId,
      groupId,
      subjectUserId,
      category: "HARASSMENT",
      description: `private narrative ${index}`,
      status: ReportStatus.OPEN,
      createdAt: now,
    }));
    const prisma = {
      report: {
        findFirst: vi.fn().mockResolvedValue({ id: reports[0]?.id }),
        findMany: vi.fn().mockResolvedValue(reports),
      },
    } as unknown as PrismaService;
    const adminAuth = {
      authenticate: vi.fn().mockResolvedValue({ adminUserId }),
    } as unknown as AdminAuthService;
    const service = new AdminTrustService(prisma, {} as IdempotencyService, adminAuth);

    await expect(service.listReports(context, campusId)).resolves.toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ id: reports[0]?.id })]),
      nextCursor: reports[49]?.id,
    });
    await expect(service.listReports(context, campusId, reports[0]?.id)).resolves.toMatchObject({
      nextCursor: reports[49]?.id,
    });
    expect(prisma.report.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: { id: reports[0]?.id }, skip: 1 }),
    );

    (prisma.report.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    await expect(service.listReports(context, campusId, reportId)).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
    });
    expect(adminAuth.authenticate).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ requireCsrf: true, role: "SAFETY_REVIEWER", campusId }),
    );
  });

  it("requires a safety reviewer and records a privacy-minimized restriction decision", async () => {
    const test = subject();
    await expect(
      test.service.decideReport(
        context,
        reportId,
        { decision: "RESTRICT_SUBJECT", reasonCode: "CORROBORATED_HARASSMENT" },
        "m5-admin-report-decision1",
        "m5-request-000001",
        now,
      ),
    ).resolves.toMatchObject({ id: reportId, status: ReportStatus.RESOLVED });
    expect(test.adminAuth.authenticate).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ requireCsrf: true, role: "SAFETY_REVIEWER", campusId }),
    );
    expect(test.transaction.user.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: subjectUserId, campusId }),
      data: { status: "RESTRICTED" },
    });
    expect(test.transaction.companionGroup.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: groupId }),
      data: { state: GroupState.RISK_HOLD, version: { increment: 1 } },
    });
    expect(JSON.stringify(test.transaction.auditLog.create.mock.calls)).not.toContain(
      "private report narrative",
    );
    expect(JSON.stringify(test.transaction.outboxEvent.create.mock.calls)).not.toContain(
      "private report narrative",
    );
  });

  it("never restricts a group-only report with no user subject", async () => {
    const test = subject({ subjectUserId: null });
    await expect(
      test.service.decideReport(
        context,
        reportId,
        { decision: "RESTRICT_SUBJECT", reasonCode: "NO_SUBJECT" },
        "m5-admin-report-nosubj01",
        "m5-request-000002",
        now,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(test.transaction.user.updateMany).not.toHaveBeenCalled();
    expect(test.transaction.riskEvent.create).not.toHaveBeenCalled();
  });

  it("uses the review and reject outcomes without changing a subject account", async () => {
    for (const [decision, expected] of [
      ["REVIEW", ReportStatus.REVIEWING],
      ["REJECT", ReportStatus.REJECTED],
    ] as const) {
      const test = subject();
      await expect(
        test.service.decideReport(
          context,
          reportId,
          { decision, reasonCode: `M5_${decision}` },
          `m5-${decision.toLowerCase()}-decision`,
          `m5-${decision.toLowerCase()}-request`,
          now,
        ),
      ).resolves.toMatchObject({ status: expected });
      expect(test.transaction.user.updateMany).not.toHaveBeenCalled();
      expect(test.transaction.riskEvent.create).not.toHaveBeenCalled();
      expect(test.transaction.companionGroup.updateMany).not.toHaveBeenCalled();
    }
  });

  it("hides unavailable or already-closed reports before a decision can mutate them", async () => {
    const missing = subject({ outerCampusId: null });
    await expect(
      missing.service.decideReport(
        context,
        reportId,
        { decision: "REVIEW", reasonCode: "M5_MISSING" },
        "m5-missing-decision",
        "m5-missing-request",
        now,
      ),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });

    const closed = subject({ currentStatus: ReportStatus.RESOLVED });
    await expect(
      closed.service.decideReport(
        context,
        reportId,
        { decision: "REVIEW", reasonCode: "M5_CLOSED" },
        "m5-closed-decision",
        "m5-closed-request",
        now,
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

    const changedCampus = subject({ currentCampusId: randomUUID() });
    await expect(
      changedCampus.service.decideReport(
        context,
        reportId,
        { decision: "REVIEW", reasonCode: "M5_CAMPUS_CHANGED" },
        "m5-campus-decision",
        "m5-campus-request",
        now,
      ),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
  });

  it("places active groups on risk hold and already-delivered groups into dispute", async () => {
    for (const [label, groupState, expectedState] of [
      ["recruiting", GroupState.RECRUITING, GroupState.RISK_HOLD],
      ["contacts-unlocked", GroupState.CONTACTS_UNLOCKED, GroupState.DISPUTED],
      ["completed", GroupState.COMPLETED, GroupState.DISPUTED],
      ["paying", GroupState.PAYING, null],
      ["without-group", null, null],
    ] as const) {
      const test = subject({ groupState });
      await test.service.decideReport(
        context,
        reportId,
        { decision: "RESTRICT_SUBJECT", reasonCode: `M5_${label}` },
        `m5-${label}-decision`,
        `m5-${label}-request`,
        now,
      );
      if (expectedState === null) {
        expect(test.transaction.companionGroup.updateMany).not.toHaveBeenCalled();
      } else {
        expect(test.transaction.companionGroup.updateMany).toHaveBeenCalledWith({
          where: expect.objectContaining({ id: groupId }),
          data: { state: expectedState, version: { increment: 1 } },
        });
      }
    }
  });
});

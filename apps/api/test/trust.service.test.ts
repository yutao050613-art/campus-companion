import { randomUUID } from "node:crypto";
import { AccountStatus, ReportCategory } from "@campus/database";
import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedUser } from "../src/auth/auth.service";
import type { IdempotencyService } from "../src/m2/idempotency.service";
import { TrustService } from "../src/trust/trust.service";

const campusId = randomUUID();
const reporterId = randomUUID();
const subjectId = randomUUID();
const groupId = randomUUID();
const principal: AuthenticatedUser = { userId: reporterId, campusId, sessionId: randomUUID() };
const now = new Date("2026-08-02T08:00:00.000Z");

function idempotency(transaction: Record<string, unknown>): IdempotencyService {
  return {
    execute: vi.fn(async (_operation, _key, _actor, _request, action) => ({
      ...(await action(transaction as never)),
      replayed: false,
    })),
  } as unknown as IdempotencyService;
}

function subject(transaction: Record<string, unknown>): TrustService {
  return new TrustService(idempotency(transaction));
}

function eligibleUser() {
  return { id: reporterId, status: AccountStatus.ACTIVE };
}

describe("M5 trust controls", () => {
  it("creates a campus-local report without copying the description into an event payload", async () => {
    const report = {
      id: randomUUID(),
      status: "OPEN" as const,
      createdAt: now,
      category: ReportCategory.HARASSMENT,
    };
    const transaction = {
      user: { findFirst: vi.fn().mockResolvedValue(eligibleUser()) },
      report: { count: vi.fn().mockResolvedValue(0), create: vi.fn().mockResolvedValue(report) },
      companionGroup: {
        findFirst: vi.fn().mockResolvedValue({
          id: groupId,
          members: [{ userId: reporterId }, { userId: subjectId }],
        }),
      },
      outboxEvent: { create: vi.fn().mockResolvedValue({}) },
    };

    await expect(
      subject(transaction).createReport(
        principal,
        {
          groupId,
          subjectUserId: subjectId,
          category: ReportCategory.HARASSMENT,
          description: "  unwanted contact after disclosure  ",
        },
        "m5-report-trust-unit-0001",
        now,
      ),
    ).resolves.toMatchObject({ id: report.id, status: "OPEN" });
    expect(transaction.report.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        campusId,
        reporterId,
        subjectUserId: subjectId,
        description: "unwanted contact after disclosure",
      }),
    });
    expect(transaction.outboxEvent.create).toHaveBeenCalledWith({
      data: expect.not.objectContaining({ description: expect.anything() }),
    });
    expect(JSON.stringify(transaction.outboxEvent.create.mock.calls)).not.toContain(
      "unwanted contact after disclosure",
    );
  });

  it("rejects self-report, unavailable group membership, and report bursts before a report is created", async () => {
    const base = {
      user: { findFirst: vi.fn().mockResolvedValue(eligibleUser()) },
      report: { count: vi.fn().mockResolvedValue(0), create: vi.fn() },
      companionGroup: {
        findFirst: vi.fn().mockResolvedValue({ id: groupId, members: [{ userId: reporterId }] }),
      },
      outboxEvent: { create: vi.fn() },
    };
    await expect(
      subject(base).createReport(
        principal,
        {
          groupId,
          subjectUserId: reporterId,
          category: ReportCategory.OTHER,
          description: "self",
        },
        "m5-report-self-unit-0001",
        now,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(base.report.create).not.toHaveBeenCalled();

    base.companionGroup.findFirst.mockResolvedValueOnce({
      id: groupId,
      members: [{ userId: subjectId }],
    });
    await expect(
      subject(base).createReport(
        principal,
        { groupId, category: ReportCategory.OTHER, description: "not a member" },
        "m5-report-group-unit-0001",
        now,
      ),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });

    base.report.count.mockResolvedValueOnce(5);
    await expect(
      subject(base).createReport(
        principal,
        { groupId, category: ReportCategory.OTHER, description: "burst" },
        "m5-report-limit-unit-0001",
        now,
      ),
    ).rejects.toMatchObject({ code: "RATE_LIMITED", statusCode: 429 });
  });

  it("blocks only another same-campus account and makes missing unblocks explicit", async () => {
    const transaction = {
      user: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce(eligibleUser())
          .mockResolvedValueOnce({ id: subjectId }),
      },
      blockRelation: {
        upsert: vi.fn().mockResolvedValue({}),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      outboxEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    await expect(
      subject(transaction).blockUser(principal, subjectId, "m5-block-user-unit-00001", now),
    ).resolves.toBeUndefined();
    expect(transaction.blockRelation.upsert).toHaveBeenCalledWith({
      where: { blockerId_blockedId: { blockerId: reporterId, blockedId: subjectId } },
      create: { campusId, blockerId: reporterId, blockedId: subjectId },
      update: {},
    });

    transaction.user.findFirst.mockResolvedValueOnce(eligibleUser());
    await expect(
      subject(transaction).blockUser(principal, reporterId, "m5-block-self-unit-00001", now),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      subject(transaction).unblockUser(principal, subjectId, "m5-unblock-missing-unit01", now),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
  });
});

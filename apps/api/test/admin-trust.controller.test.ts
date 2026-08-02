import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AdminTrustController } from "../src/admin/admin-trust.controller";
import type { AdminTrustService } from "../src/admin/admin-trust.service";

const campusId = randomUUID();
const reportId = randomUUID();

describe("M5 admin trust controller", () => {
  it("accepts only constrained decision DTOs and forwards no browser-derived authority", async () => {
    const trust = {
      listReports: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      decideReport: vi.fn().mockResolvedValue({
        id: reportId,
        campusId,
        groupId: randomUUID(),
        subjectUserId: null,
        category: "OTHER",
        description: "reviewed privately",
        status: "REVIEWING",
        createdAt: "2026-08-02T10:00:00.000Z",
      }),
    } as unknown as AdminTrustService;
    const controller = new AdminTrustController(trust);
    await expect(
      controller.list("admin-cookie", "csrf", "http://127.0.0.1:5173", "same-origin", campusId),
    ).resolves.toEqual({ items: [], nextCursor: null });
    await expect(
      controller.decide(
        "admin-cookie",
        "csrf",
        "http://127.0.0.1:5173",
        "same-origin",
        "m5-admin-controller-key1",
        reportId,
        { decision: "REVIEW", reasonCode: "NEEDS_REVIEW" },
        { id: "request-00001" } as never,
      ),
    ).resolves.toMatchObject({ id: reportId, status: "REVIEWING" });
    expect(() =>
      controller.decide(
        "admin-cookie",
        "csrf",
        "http://127.0.0.1:5173",
        "same-origin",
        "m5-admin-controller-key2",
        reportId,
        { decision: "RESTRICT_SUBJECT", reasonCode: "lowercase forbidden" },
        { id: "request-00002" } as never,
      ),
    ).toThrow();
  });
});

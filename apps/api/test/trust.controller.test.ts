import { randomUUID } from "node:crypto";
import { ReportCategory } from "@campus/database";
import { describe, expect, it, vi } from "vitest";
import type { AuthService } from "../src/auth/auth.service";
import { TrustController } from "../src/trust/trust.controller";
import type { TrustService } from "../src/trust/trust.service";

const principal = { userId: randomUUID(), campusId: randomUUID(), sessionId: randomUUID() };
const groupId = randomUUID();
const subjectId = randomUUID();

describe("M5 trust controllers", () => {
  it("accepts only constrained report and block DTOs", async () => {
    const auth = { authenticate: vi.fn().mockResolvedValue(principal) } as unknown as AuthService;
    const trust = {
      createReport: vi.fn().mockResolvedValue({
        id: randomUUID(),
        status: "OPEN",
        createdAt: "2026-08-02T08:00:00.000Z",
      }),
      blockUser: vi.fn().mockResolvedValue(undefined),
      unblockUser: vi.fn().mockResolvedValue(undefined),
    } as unknown as TrustService;
    const controller = new TrustController(auth, trust);

    await expect(
      controller.createReport("Bearer m5.trust.token", "m5-report-controller-key", {
        groupId,
        subjectUserId: subjectId,
        category: ReportCategory.PRIVACY,
        description: "contact was misused",
      }),
    ).resolves.toMatchObject({ status: "OPEN" });
    await expect(
      controller.blockUser("Bearer m5.trust.token", "m5-block-controller-key0", subjectId),
    ).resolves.toBeUndefined();
    await expect(
      controller.createReport("Bearer m5.trust.token", "m5-report-extra-key", {
        groupId,
        category: ReportCategory.OTHER,
        description: "extra field is rejected",
        decision: "RESTRICT",
      }),
    ).rejects.toThrow();
  });
});

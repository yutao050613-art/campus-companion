import { randomUUID } from "node:crypto";
import { RefundReason } from "@campus/database";
import { describe, expect, it, vi } from "vitest";
import type { AuthService } from "../src/auth/auth.service";
import type { PaymentsService } from "../src/payments/payments.service";
import { RefundsController } from "../src/payments/refunds.controller";

const principal = { userId: randomUUID(), campusId: randomUUID(), sessionId: randomUUID() };
const orderId = randomUUID();
const refundId = randomUUID();

describe("M5 refund controllers", () => {
  it("accepts only owned order references, policy reasons and idempotency keys", async () => {
    const auth = { authenticate: vi.fn().mockResolvedValue(principal) } as unknown as AuthService;
    const payments = {
      requestRefund: vi.fn().mockResolvedValue({
        id: refundId,
        orderId,
        amountFen: 99,
        reason: RefundReason.OTHER,
        status: "REVIEW_REQUIRED",
      }),
      getRefund: vi.fn().mockResolvedValue({
        id: refundId,
        orderId,
        amountFen: 99,
        reason: RefundReason.OTHER,
        status: "REVIEW_REQUIRED",
      }),
    } as unknown as PaymentsService;
    const controller = new RefundsController(auth, payments);

    await expect(
      controller.requestRefund("Bearer m5.refund.token", "m5-refund-key", {
        orderId,
        reason: RefundReason.OTHER,
      }),
    ).resolves.toMatchObject({ amountFen: 99, status: "REVIEW_REQUIRED" });
    await expect(controller.getRefund("Bearer m5.refund.token", refundId)).resolves.toMatchObject({
      id: refundId,
    });
    await expect(
      controller.requestRefund("Bearer m5.refund.token", "m5-invalid-refund-key", {
        orderId,
        reason: "UNSUPPORTED",
      }),
    ).rejects.toThrow();
    await expect(
      controller.requestRefund("Bearer m5.refund.token", "m5-client-price-key", {
        orderId,
        reason: RefundReason.OTHER,
        amountFen: 1,
      }),
    ).rejects.toThrow();
  });
});

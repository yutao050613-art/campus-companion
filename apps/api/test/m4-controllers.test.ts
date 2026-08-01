import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AuthService } from "../src/auth/auth.service";
import { PaymentsController } from "../src/payments/payments.controller";
import type { PaymentsService } from "../src/payments/payments.service";

const campusId = randomUUID();
const groupId = randomUUID();
const roundId = randomUUID();
const orderId = randomUUID();
const principal = { userId: randomUUID(), sessionId: randomUUID(), campusId };
const token = "m4.access.token";
const order = {
  id: orderId,
  groupId,
  roundId,
  amountFen: 99 as const,
  currency: "CNY" as const,
  status: "CREATED",
  expiresAt: "2026-08-01T08:05:00.000Z",
};

function auth(): AuthService {
  return { authenticate: vi.fn().mockResolvedValue(principal) } as unknown as AuthService;
}

describe("M4 payment controllers", () => {
  it("accepts only server-owned order, mock intent, consent and contact DTOs", async () => {
    const payments = {
      setMyWechatContact: vi.fn().mockResolvedValue({ hasWechatContact: true }),
      createOrder: vi.fn().mockResolvedValue(order),
      getOrder: vi.fn().mockResolvedValue(order),
      createPrepay: vi.fn().mockResolvedValue({
        provider: "MOCK",
        intentId: `mock_intent_${"a".repeat(40)}`,
        amountFen: 99,
        expiresAt: order.expiresAt,
      }),
      completeMockPayment: vi.fn().mockResolvedValue({ ...order, status: "PAID" }),
      revokeContactConsent: vi.fn().mockResolvedValue(undefined),
      getUnlockedContacts: vi.fn().mockResolvedValue([{ label: "成员 1", wechatId: "m4wechat_b" }]),
    } as unknown as PaymentsService;
    const controller = new PaymentsController(auth(), payments);
    await expect(
      controller.setContact(`Bearer ${token}`, "m4-contact-controller-key", {
        wechatId: "m4wechat_a",
      }),
    ).resolves.toEqual({ hasWechatContact: true });
    await expect(
      controller.createOrder(`Bearer ${token}`, "m4-order-controller-key", groupId, { roundId }),
    ).resolves.toEqual(order);
    await expect(controller.getOrder(`Bearer ${token}`, orderId)).resolves.toEqual(order);
    await expect(
      controller.createPrepay(`Bearer ${token}`, "m4-prepay-controller-key", orderId),
    ).resolves.toMatchObject({ amountFen: 99 });
    await expect(
      controller.settleMock(`Bearer ${token}`, "m4-settle-controller-key", orderId, {
        intentId: `mock_intent_${"a".repeat(40)}`,
      }),
    ).resolves.toMatchObject({ status: "PAID" });
    await expect(
      controller.revokeConsent(`Bearer ${token}`, "m4-revoke-controller-key", roundId),
    ).resolves.toBeUndefined();
    await expect(controller.getContacts(`Bearer ${token}`, groupId)).resolves.toEqual([
      { label: "成员 1", wechatId: "m4wechat_b" },
    ]);
    await expect(
      controller.createOrder(`Bearer ${token}`, "m4-invalid-controller-key", groupId, {
        roundId,
        amountFen: 1,
      }),
    ).rejects.toThrow();
    await expect(
      controller.settleMock(`Bearer ${token}`, "m4-invalid-settle-key", orderId, {
        intentId: "not-a-mock-intent",
      }),
    ).rejects.toThrow();
  });
});

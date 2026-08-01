import { describe, expect, it } from "vitest";
import { MockPaymentGateway } from "../src";

const request = {
  orderId: "10000000-0000-4000-8000-000000000001",
  merchantOrderNo: "m4_0123456789abcdef",
  amountFen: 99,
  expiresAt: new Date("2030-01-01T00:00:00.000Z"),
} as const;

describe("MockPaymentGateway", () => {
  it("creates deterministic mock facts only in development and test", () => {
    const gateway = new MockPaymentGateway("test");
    const prepay = gateway.createPrepay(request);
    const first = gateway.settle(prepay.intentId, new Date("2029-01-01T00:00:00.000Z"));
    const second = gateway.settle(prepay.intentId, new Date("2029-01-02T00:00:00.000Z"));
    expect(prepay.amountFen).toBe(99);
    expect(first.providerTransactionId).toBe(second.providerTransactionId);
    expect(gateway.refund(first.providerTransactionId).providerRefundId).toMatch(/^mock_ref_/u);
    expect(new MockPaymentGateway("development").intentFor(request.merchantOrderNo)).toBe(
      prepay.intentId,
    );
  });

  it("rejects every untrusted identifier, malformed order, and non-test environment", () => {
    expect(() => new MockPaymentGateway("production").createPrepay(request)).toThrow(/disabled/u);
    expect(() => new MockPaymentGateway("staging").settle(`mock_intent_${"a".repeat(40)}`)).toThrow(
      /disabled/u,
    );

    const gateway = new MockPaymentGateway("test");
    expect(() => gateway.createPrepay({ ...request, orderId: "not-a-uuid" })).toThrow(/order id/u);
    expect(() => gateway.createPrepay({ ...request, merchantOrderNo: "m4_short" })).toThrow(
      /merchant order/u,
    );
    expect(() => gateway.createPrepay({ ...request, amountFen: 1 })).toThrow(/prepay request/u);
    expect(() => gateway.createPrepay({ ...request, expiresAt: new Date("invalid") })).toThrow(
      /prepay request/u,
    );
    expect(() => gateway.intentFor("m4_short")).toThrow(/merchant order/u);
    expect(() => gateway.settle("not-a-mock-intent")).toThrow(/intent/u);
    expect(() => gateway.refund("not-a-mock-transaction")).toThrow(/transaction id/u);
  });
});

import { createHash } from "node:crypto";

export * from "./wechat-pay-v3";

export type PaymentEnvironment = "development" | "test" | "staging" | "production";

export interface PrepayRequest {
  readonly orderId: string;
  readonly merchantOrderNo: string;
  readonly amountFen: number;
  readonly expiresAt: Date;
}

export interface MockPrepay {
  readonly provider: "MOCK";
  readonly intentId: string;
  readonly expiresAt: string;
  readonly amountFen: 99;
}

export interface MockSettlement {
  readonly providerTransactionId: string;
  readonly occurredAt: Date;
  readonly rawDigest: string;
}

export interface MockRefundSettlement {
  readonly providerRefundId: string;
  readonly completedAt: Date;
  readonly rawDigest: string;
}

export class MockPaymentGateway {
  public constructor(private readonly environment: PaymentEnvironment) {}

  public createPrepay(request: PrepayRequest): MockPrepay {
    this.assertEnabled();
    assertOrder(request);
    return {
      provider: "MOCK",
      intentId: mockIntentId(request.merchantOrderNo),
      expiresAt: request.expiresAt.toISOString(),
      amountFen: 99,
    };
  }

  public settle(intentId: string, now = new Date()): MockSettlement {
    this.assertEnabled();
    assertIntent(intentId);
    return {
      providerTransactionId: `mock_txn_${digest(intentId).slice(0, 40)}`,
      occurredAt: now,
      rawDigest: digest(`settle:${intentId}`),
    };
  }

  public refund(providerTransactionId: string, now = new Date()): MockRefundSettlement {
    this.assertEnabled();
    if (!/^mock_txn_[a-f0-9]{40}$/u.test(providerTransactionId)) {
      throw new Error("Mock provider transaction id is invalid");
    }
    return {
      providerRefundId: `mock_ref_${digest(providerTransactionId).slice(0, 40)}`,
      completedAt: now,
      rawDigest: digest(`refund:${providerTransactionId}`),
    };
  }

  public intentFor(merchantOrderNo: string): string {
    this.assertEnabled();
    if (!/^m4_[A-Za-z0-9_-]{16,60}$/u.test(merchantOrderNo)) {
      throw new Error("Mock merchant order number is invalid");
    }
    return mockIntentId(merchantOrderNo);
  }

  private assertEnabled(): void {
    if (this.environment !== "development" && this.environment !== "test") {
      throw new Error("Mock payment gateway is disabled outside development and test");
    }
  }
}

function assertOrder(request: PrepayRequest): void {
  if (!/^[0-9a-f-]{36}$/u.test(request.orderId)) throw new Error("Mock order id is invalid");
  if (!/^m4_[A-Za-z0-9_-]{16,60}$/u.test(request.merchantOrderNo)) {
    throw new Error("Mock merchant order number is invalid");
  }
  if (request.amountFen !== 99 || !Number.isFinite(request.expiresAt.getTime())) {
    throw new Error("Mock prepay request is invalid");
  }
}

function mockIntentId(merchantOrderNo: string): string {
  return `mock_intent_${digest(merchantOrderNo).slice(0, 40)}`;
}

function assertIntent(intentId: string): void {
  if (!/^mock_intent_[a-f0-9]{40}$/u.test(intentId))
    throw new Error("Mock payment intent is invalid");
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

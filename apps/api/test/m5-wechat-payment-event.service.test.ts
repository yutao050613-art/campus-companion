import { randomUUID } from "node:crypto";
import {
  GroupState,
  MemberStatus,
  OrderStatus,
  PaymentProvider,
  PaymentStatus,
  Prisma,
  ProviderEventStatus,
  RoundState,
} from "@campus/database";
import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config";
import type { PrismaService } from "../src/database/prisma.service";
import {
  PaymentsService,
  type VerifiedWechatPaymentEventInput,
} from "../src/payments/payments.service";

const campusId = randomUUID();
const orderId = randomUUID();
const input: VerifiedWechatPaymentEventInput = {
  eventId: "wechat-event-0001",
  eventType: "TRANSACTION.SUCCESS",
  verifierKeyId: "wechat-key-0001",
  rawDigest: "a".repeat(64),
  merchantOrderNo: "m5-merchant-order-0001",
  providerTransactionId: "wechat-transaction-0001",
  amountFen: 99,
  currency: "CNY",
  occurredAt: new Date("2026-08-02T00:00:00.000Z"),
};

interface ProviderEventWhere {
  readonly provider_eventId?: { readonly provider: PaymentProvider; readonly eventId: string };
  readonly id?: string;
}

interface StoredProviderEvent {
  readonly id: string;
  readonly status: ProviderEventStatus;
  readonly orderId: string | null;
  readonly refundId: string | null;
  readonly campusId: string | null;
  readonly eventId: string;
  readonly [key: string]: unknown;
}

function createSubject(options: { readonly matchingAmount: boolean } = { matchingAmount: true }) {
  const events = new Map<string, StoredProviderEvent>();
  const reconciliations: Record<string, unknown>[] = [];
  const prisma = {
    providerEvent: {
      findUnique: vi.fn(async ({ where }: { where: ProviderEventWhere }) => {
        const selector = where.provider_eventId as
          | { readonly provider: PaymentProvider; readonly eventId: string }
          | undefined;
        if (selector !== undefined) return events.get(selector.eventId) ?? null;
        const id = where.id as string | undefined;
        return [...events.values()].find((event) => event.id === id) ?? null;
      }),
      create: vi.fn(
        async ({
          data,
        }: {
          data: { readonly eventId: string; readonly [key: string]: unknown };
        }) => {
          const event = {
            id: randomUUID(),
            status: ProviderEventStatus.RECEIVED,
            orderId: null,
            refundId: null,
            campusId: null,
            ...data,
          };
          events.set(data.eventId, event);
          return event;
        },
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { readonly id: string; readonly status: ProviderEventStatus };
          data: { readonly status: ProviderEventStatus };
        }) => {
          const current = [...events.values()].find((event) => event.id === where.id);
          if (current === undefined || current.status !== where.status) return { count: 0 };
          events.set(current.eventId, { ...current, status: data.status });
          return { count: 1 };
        },
      ),
    },
    serviceOrder: {
      findUnique: vi.fn(async () => ({
        id: orderId,
        campusId,
        amountFen: options.matchingAmount ? 99 : 98,
        currency: "CNY",
      })),
    },
    reconciliationException: {
      upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => {
        reconciliations.push(create);
        return create;
      }),
    },
    $transaction: vi.fn(async (action: (transaction: unknown) => Promise<unknown>) =>
      action(prisma),
    ),
  };
  const service = new PaymentsService(
    prisma as unknown as PrismaService,
    {} as never,
    {} as never,
    { nodeEnv: "test" } as AppConfig,
  );
  return { service, prisma, events, reconciliations };
}

function createApplyRaceSubject(options: {
  readonly replayStatus: ProviderEventStatus;
  readonly transactionOwner: "SAME_EVENT" | "DIFFERENT_EVENT";
  readonly uniqueTarget?: string | readonly string[];
}) {
  const eventId = randomUUID();
  const transactionId = "wechat-transaction-race-0001";
  const roundId = randomUUID();
  const groupId = randomUUID();
  const memberId = randomUUID();
  const reconciliations: Record<string, unknown>[] = [];
  let reads = 0;
  const event = {
    id: eventId,
    campusId,
    orderId,
    refundId: null,
    status: ProviderEventStatus.RECEIVED,
    eventType: "TRANSACTION.SUCCESS",
    merchantRefundNo: null,
    providerTransactionId: transactionId,
    rawDigest: "c".repeat(64),
    amountFen: 99,
    currency: "CNY",
    occurredAt: new Date(),
    order: {
      id: orderId,
      campusId,
      amountFen: 99,
      currency: "CNY",
      status: OrderStatus.PAYING,
      expiresAt: new Date(Date.now() + 60_000),
      userId: randomUUID(),
      round: {
        id: roundId,
        groupId,
        state: RoundState.PAYING,
        group: { state: GroupState.PAYING },
      },
    },
  };
  const prisma = {
    providerEvent: {
      findUnique: vi.fn(async () => {
        reads += 1;
        return reads > 1 ? { ...event, status: options.replayStatus } : event;
      }),
      update: vi.fn(async () => event),
    },
    paymentTransaction: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => {
        throw new Prisma.PrismaClientKnownRequestError("duplicate provider transaction", {
          code: "P2002",
          clientVersion: "test",
          meta: { target: options.uniqueTarget ?? ["providerTransactionId"] },
        });
      }),
      findUnique: vi.fn(async () => ({
        campusId,
        orderId,
        provider: PaymentProvider.WECHAT_PAY,
        providerEventId: options.transactionOwner === "SAME_EVENT" ? eventId : randomUUID(),
        status: PaymentStatus.SUCCEEDED,
      })),
    },
    groupMember: {
      findFirst: vi.fn(async () => ({ id: memberId, status: MemberStatus.PAYMENT_PENDING })),
    },
    reconciliationException: {
      upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => {
        reconciliations.push(create);
        return create;
      }),
    },
    $transaction: vi.fn(async (action: (transaction: unknown) => Promise<unknown>) =>
      action(prisma),
    ),
  };
  const service = new PaymentsService(
    prisma as unknown as PrismaService,
    {} as never,
    {} as never,
    { nodeEnv: "test" } as AppConfig,
  );
  return { service, prisma, eventId, reconciliations };
}

describe("M5 verified WeChat payment-event ingress", () => {
  it("persists a privacy-minimized external fact before internal application", async () => {
    const subject = createSubject();

    await expect(subject.service.ingestVerifiedWechatPaymentEvent(input)).resolves.toMatchObject({
      status: "RECEIVED",
    });

    expect(subject.prisma.providerEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        provider: PaymentProvider.WECHAT_PAY,
        campusId,
        orderId,
        eventId: input.eventId,
        rawDigest: input.rawDigest,
        amountFen: 99,
        currency: "CNY",
      }),
    });
    const stored = subject.events.get(input.eventId);
    expect(stored).not.toHaveProperty("rawPayload");
    expect(stored).not.toHaveProperty("wechatId");
  });

  it("records an amount mismatch without binding it to the local order", async () => {
    const subject = createSubject({ matchingAmount: false });

    await subject.service.ingestVerifiedWechatPaymentEvent(input);

    expect(subject.prisma.providerEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ campusId, eventId: input.eventId }),
    });
    expect(subject.prisma.providerEvent.create).toHaveBeenCalledWith({
      data: expect.not.objectContaining({ orderId }),
    });
  });

  it("does not overwrite an immutable provider event when the same ID carries another digest", async () => {
    const subject = createSubject();
    await subject.service.ingestVerifiedWechatPaymentEvent(input);

    await expect(
      subject.service.ingestVerifiedWechatPaymentEvent({ ...input, rawDigest: "b".repeat(64) }),
    ).resolves.toMatchObject({ status: "REVIEW_REQUIRED" });

    expect(subject.prisma.providerEvent.create).toHaveBeenCalledTimes(1);
    expect(subject.prisma.providerEvent.updateMany).toHaveBeenCalledWith({
      where: { id: expect.any(String), status: ProviderEventStatus.RECEIVED },
      data: { status: ProviderEventStatus.REVIEW_REQUIRED },
    });
    expect(subject.events.get(input.eventId)).toMatchObject({
      status: ProviderEventStatus.REVIEW_REQUIRED,
    });
    expect(subject.reconciliations).toEqual([
      expect.objectContaining({
        code: "PROVIDER_EVENT_DIGEST_CONFLICT",
        expectedDigest: "a".repeat(64),
        observedDigest: "b".repeat(64),
      }),
    ]);
  });

  it("treats a same-event provider-transaction race as an idempotent terminal replay", async () => {
    const subject = createApplyRaceSubject({
      replayStatus: ProviderEventStatus.APPLIED,
      transactionOwner: "SAME_EVENT",
    });

    await expect(
      subject.service.applyVerifiedWechatPaymentEvent(subject.eventId),
    ).resolves.toMatchObject({ providerEventId: subject.eventId, status: "APPLIED" });

    expect(subject.prisma.paymentTransaction.create).toHaveBeenCalledTimes(1);
    expect(subject.prisma.reconciliationException.upsert).not.toHaveBeenCalled();
  });

  it("holds a different event that claims an already-used provider transaction for review", async () => {
    const subject = createApplyRaceSubject({
      replayStatus: ProviderEventStatus.RECEIVED,
      transactionOwner: "DIFFERENT_EVENT",
    });

    await expect(
      subject.service.applyVerifiedWechatPaymentEvent(subject.eventId),
    ).resolves.toMatchObject({ providerEventId: subject.eventId, status: "REVIEW_REQUIRED" });

    expect(subject.reconciliations).toEqual([
      expect.objectContaining({ code: "DUPLICATE_PROVIDER_TRANSACTION" }),
    ]);
  });

  it("holds an internally inconsistent same-event transaction for review instead of inferring delivery", async () => {
    const subject = createApplyRaceSubject({
      replayStatus: ProviderEventStatus.RECEIVED,
      transactionOwner: "SAME_EVENT",
    });

    await expect(
      subject.service.applyVerifiedWechatPaymentEvent(subject.eventId),
    ).resolves.toMatchObject({ providerEventId: subject.eventId, status: "REVIEW_REQUIRED" });

    expect(subject.reconciliations).toEqual([
      expect.objectContaining({ code: "PAYMENT_EVENT_STATE_MISMATCH" }),
    ]);
  });

  it("does not convert a different unique-constraint failure into a payment replay", async () => {
    const subject = createApplyRaceSubject({
      replayStatus: ProviderEventStatus.APPLIED,
      transactionOwner: "SAME_EVENT",
      uniqueTarget: ["orderId"],
    });

    await expect(
      subject.service.applyVerifiedWechatPaymentEvent(subject.eventId),
    ).rejects.toMatchObject({
      code: "P2002",
    });
  });

  it("accepts the provider-event target when Prisma reports it as a string", async () => {
    const subject = createApplyRaceSubject({
      replayStatus: ProviderEventStatus.APPLIED,
      transactionOwner: "SAME_EVENT",
      uniqueTarget: "providerEventId",
    });

    await expect(
      subject.service.applyVerifiedWechatPaymentEvent(subject.eventId),
    ).resolves.toMatchObject({ providerEventId: subject.eventId, status: "APPLIED" });
  });
});

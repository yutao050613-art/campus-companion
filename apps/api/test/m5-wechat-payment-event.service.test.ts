import { randomUUID } from "node:crypto";
import { PaymentProvider, ProviderEventStatus } from "@campus/database";
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
});

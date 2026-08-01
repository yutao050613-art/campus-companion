import { Writable } from "node:stream";
import { issueMockWechatCode } from "@campus/auth";
import {
  createPrismaClient,
  GenderDeclaration,
  GroupState,
  MemberStatus,
  OrderStatus,
  PlaceType,
  PolicyType,
  ProviderEventStatus,
  RefundReason,
  RefundStatus,
  RoundState,
  VerificationStatus,
} from "@campus/database";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/bootstrap";
import { PaymentsService } from "../src/payments/payments.service";

const runNative = process.env["NATIVE_POSTGRES_TESTS"] === "true";
const prisma = createPrismaClient();
const ids = {
  campus: "50000000-0000-4000-8000-000000000001",
  sensitivePolicy: "50000000-0000-4000-8000-000000000002",
  contactPolicy: "50000000-0000-4000-8000-000000000003",
  origin: "50000000-0000-4000-8000-000000000004",
  destination: "50000000-0000-4000-8000-000000000005",
  route: "50000000-0000-4000-8000-000000000006",
} as const;
const mockSecret = "m5-mock-wechat-signing-secret-longer-than-thirty-two-bytes";
const accessSecret = "m5-access-token-signing-secret-longer-than-thirty-two-bytes";
const studentSecret = "m5-student-number-hmac-secret-longer-than-thirty-two-bytes";
const uploadSecret = "m5-upload-token-signing-secret-longer-than-thirty-two-bytes";
const encryptionKey = Buffer.alloc(32, 15);

interface Session {
  readonly accessToken: string;
  readonly user: { readonly id: string; readonly campusId: string };
}

interface Demand {
  readonly id: string;
  readonly groupId: string;
}

interface Formation {
  readonly id: string;
  readonly groupId: string;
  readonly contactPolicyVersion: string;
}

interface Order {
  readonly id: string;
}

interface InjectResponse {
  readonly statusCode: number;
  readonly rawPayload: Buffer;
  json<T = unknown>(): T;
}

describe.runIf(runNative)("M5 native PostgreSQL provider-event replay and delivery", () => {
  let app: NestFastifyApplication;
  let payments: PaymentsService;
  let windowStart = "";
  let windowEnd = "";
  const sessions: Record<string, Session> = {};

  beforeAll(async () => {
    const date = futureLocalDate();
    windowStart = `${date}T10:00:00.000Z`;
    windowEnd = `${date}T10:30:00.000Z`;
    const rawWeekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
    const weekday = rawWeekday === 0 ? 7 : rawWeekday;
    Object.assign(process.env, {
      NODE_ENV: "test",
      WECHAT_AUTH_PROVIDER: "mock",
      PAYMENT_PROVIDER: "mock",
      WECHAT_PAY_CALLBACKS_ENABLED: "false",
      WECHAT_MOCK_DEFAULT_CAMPUS_ID: ids.campus,
      WECHAT_MOCK_SIGNING_SECRET: mockSecret,
      AUTH_ACCESS_TOKEN_SECRET: accessSecret,
      STUDENT_NUMBER_HMAC_SECRET: studentSecret,
      DATA_ENCRYPTION_KEY_BASE64: encryptionKey.toString("base64"),
      DATA_ENCRYPTION_KEY_VERSION: "m5-native-test",
      LOCAL_OBJECT_UPLOAD_SECRET: uploadSecret,
      LOCAL_OBJECT_STORE_ROOT: "D:\\CodexWorkspace\\work\\campus-companion-m5-native-objects",
      PUBLIC_API_BASE_URL: "http://127.0.0.1:3000",
      ADMIN_TRUSTED_ORIGINS: "http://127.0.0.1:5173",
    });
    await cleanup();
    await prisma.campus.create({
      data: { id: ids.campus, name: "M5 Native Campus", timezone: "Asia/Shanghai" },
    });
    await prisma.policyVersion.createMany({
      data: [
        {
          id: ids.sensitivePolicy,
          type: PolicyType.SENSITIVE_INFO,
          version: "sensitive-info-m5-native",
          contentDigest: "a".repeat(64),
          effectiveAt: new Date(Date.now() - 60_000),
        },
        {
          id: ids.contactPolicy,
          type: PolicyType.CONTACT_SHARING,
          version: "contact-sharing-m5-native",
          contentDigest: "b".repeat(64),
          effectiveAt: new Date(Date.now() - 60_000),
        },
      ],
    });
    await prisma.place.createMany({
      data: [
        { id: ids.origin, campusId: ids.campus, name: "M5 Gate", type: PlaceType.CAMPUS_GATE },
        {
          id: ids.destination,
          campusId: ids.campus,
          name: "M5 Hub",
          type: PlaceType.TRANSIT_HUB,
        },
      ],
    });
    await prisma.route.create({
      data: {
        id: ids.route,
        campusId: ids.campus,
        originId: ids.origin,
        destinationId: ids.destination,
        schedules: {
          create: {
            campusId: ids.campus,
            weekday,
            startMinute: 1_080,
            endMinute: 1_200,
            windowMinutes: 30,
            activeFrom: new Date(`${date}T00:00:00.000Z`),
          },
        },
      },
    });
    app = await createApp({
      level: "silent",
      destination: new Writable({ write: (_chunk, _encoding, callback) => callback() }),
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    payments = app.get(PaymentsService);
    for (const subject of ["a", "b"]) sessions[subject] = await login(subject);
    for (const [index, subject] of ["a", "b"].entries()) {
      const session = sessions[subject];
      if (session === undefined) throw new Error("M5 session setup failed");
      await prisma.user.update({
        where: { id: session.user.id },
        data: { genderDeclaration: GenderDeclaration.FEMALE },
      });
      await prisma.studentVerification.create({
        data: {
          userId: session.user.id,
          campusId: ids.campus,
          studentNumberDigest: (index + 1).toString(16).padStart(64, "0"),
          studentNumberLast4: (index + 1).toString().padStart(4, "0"),
          status: VerificationStatus.VERIFIED,
          consentPolicyId: ids.sensitivePolicy,
          submittedAt: new Date(),
          latestSubmittedAt: new Date(),
          reviewedAt: new Date(),
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });
    }
  }, 30_000);

  afterAll(async () => {
    try {
      await app?.close();
      await cleanup();
    } finally {
      await prisma.$disconnect();
    }
  }, 30_000);

  it("replays signed provider facts exactly once across twenty concurrent delivery races", async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        await cleanupGroupingData();
        const round = await createPayingRound(`m5-provider-${attempt}`);
        const [orderA, orderB] = await Promise.all([
          createOrder("a", round, `m5-provider-${attempt}-order-a`),
          createOrder("b", round, `m5-provider-${attempt}-order-b`),
        ]);
        const orders = await prisma.serviceOrder.findMany({
          where: { id: { in: [orderA.id, orderB.id] } },
          select: { id: true, merchantOrderNo: true },
          orderBy: { merchantOrderNo: "asc" },
        });
        expect(orders).toHaveLength(2);
        const eventInputs = orders.map((order, index) => ({
          eventId: `m5event${attempt}${index}provider`,
          eventType: "TRANSACTION.SUCCESS" as const,
          verifierKeyId: "m5-test-verifier-key",
          rawDigest: `${attempt}${index}`.padStart(64, "a"),
          merchantOrderNo: order.merchantOrderNo,
          providerTransactionId: `m5transaction${attempt}${index}provider`,
          amountFen: 99,
          currency: "CNY" as const,
          occurredAt: new Date(),
        }));
        const ingress = await Promise.all(
          eventInputs.flatMap((event) => [
            payments.ingestVerifiedWechatPaymentEvent(event),
            payments.ingestVerifiedWechatPaymentEvent(event),
          ]),
        );
        const eventIds = [...new Set(ingress.map((receipt) => receipt.providerEventId))];
        expect(eventIds).toHaveLength(2);
        const firstEventId = eventIds[0];
        if (firstEventId === undefined) throw new Error("M5 event replay setup failed");
        expect(ingress.every((receipt) => receipt.status === "RECEIVED")).toBe(true);

        const applied = await Promise.all(
          eventIds.flatMap((providerEventId) => [
            payments.applyVerifiedWechatPaymentEvent(providerEventId),
            payments.applyVerifiedWechatPaymentEvent(providerEventId),
          ]),
        );
        expect(applied.every((receipt) => receipt.status === "APPLIED")).toBe(true);
        expect(
          await prisma.paymentTransaction.count({
            where: {
              orderId: { in: orders.map((order) => order.id) },
              providerEventId: { not: null },
            },
          }),
        ).toBe(2);
        expect(
          await prisma.providerEvent.count({
            where: {
              id: { in: eventIds },
              status: ProviderEventStatus.APPLIED,
            },
          }),
        ).toBe(2);
        expect(await prisma.contactUnlock.count({ where: { roundId: round.id } })).toBe(2);
        expect(
          await prisma.companionGroup.findUnique({ where: { id: round.groupId } }),
        ).toMatchObject({
          state: GroupState.CONTACTS_UNLOCKED,
        });

        const firstEventInput = eventInputs[0];
        if (firstEventInput === undefined) throw new Error("M5 event input setup failed");
        await expect(
          payments.ingestVerifiedWechatPaymentEvent({
            ...firstEventInput,
            rawDigest: "f".repeat(64),
          }),
        ).resolves.toMatchObject({ status: "REVIEW_REQUIRED" });
        expect(
          await prisma.reconciliationException.count({
            where: { providerEventId: firstEventId },
          }),
        ).toBe(1);
      } finally {
        await cleanupGroupingData();
      }
    }
  }, 180_000);

  it("holds mismatched facts for review and restores a refunded formation without a second delivery", async () => {
    try {
      const unknown = await payments.ingestVerifiedWechatPaymentEvent({
        eventId: "m5unknownproviderfact",
        eventType: "TRANSACTION.SUCCESS",
        verifierKeyId: "m5-test-verifier-key",
        rawDigest: "1".repeat(64),
        merchantOrderNo: "m5_unknown_merchant_order",
        providerTransactionId: "m5unknownprovidertransaction",
        amountFen: 99,
        currency: "CNY",
        occurredAt: new Date(),
      });
      await expect(
        payments.applyVerifiedWechatPaymentEvent(unknown.providerEventId),
      ).resolves.toMatchObject({
        status: "REVIEW_REQUIRED",
      });

      await cleanupGroupingData();
      const mismatchRound = await createPayingRound("m5-amount-mismatch");
      const mismatchOrder = await createOrder("a", mismatchRound, "m5-amount-mismatch-order");
      const mismatchDetails = await orderDetails(mismatchOrder.id);
      const mismatch = await payments.ingestVerifiedWechatPaymentEvent(
        paymentEvent(mismatchDetails, "m5amountmismatchprovider", "2".repeat(64), 98),
      );
      await expect(
        payments.applyVerifiedWechatPaymentEvent(mismatch.providerEventId),
      ).resolves.toMatchObject({
        status: "REVIEW_REQUIRED",
      });

      await cleanupGroupingData();
      const expiryRound = await createPayingRound("m5-expired-order");
      const expiryOrder = await createOrder("a", expiryRound, "m5-expired-order-a");
      const expiryDetails = await orderDetails(expiryOrder.id);
      const expired = await payments.ingestVerifiedWechatPaymentEvent(
        paymentEvent(expiryDetails, "m5expiredproviderfact", "3".repeat(64)),
      );
      await expect(
        payments.applyVerifiedWechatPaymentEvent(
          expired.providerEventId,
          new Date(Date.now() + 10 * 60_000),
        ),
      ).resolves.toMatchObject({ status: "REVIEW_REQUIRED" });

      await cleanupGroupingData();
      const membershipRound = await createPayingRound("m5-membership-mismatch");
      const membershipOrder = await createOrder(
        "a",
        membershipRound,
        "m5-membership-mismatch-order",
      );
      const membershipDetails = await orderDetails(membershipOrder.id);
      const membership = await payments.ingestVerifiedWechatPaymentEvent(
        paymentEvent(membershipDetails, "m5membershipproviderfact", "4".repeat(64)),
      );
      const memberASession = sessions["a"];
      if (memberASession === undefined) throw new Error("missing M5 session a");
      await prisma.groupMember.updateMany({
        where: { groupId: membershipRound.groupId, userId: memberASession.user.id },
        data: { status: MemberStatus.PAYMENT_TIMEOUT },
      });
      await expect(
        payments.applyVerifiedWechatPaymentEvent(membership.providerEventId),
      ).resolves.toMatchObject({
        status: "REVIEW_REQUIRED",
      });

      await cleanupGroupingData();
      const conflictRound = await createPayingRound("m5-digest-conflict");
      const conflictOrder = await createOrder("a", conflictRound, "m5-digest-conflict-order");
      const conflictDetails = await orderDetails(conflictOrder.id);
      const firstConflictFact = paymentEvent(
        conflictDetails,
        "m5digestconflictproviderfact",
        "c".repeat(64),
      );
      const conflictReceipt = await payments.ingestVerifiedWechatPaymentEvent(firstConflictFact);
      await expect(
        payments.ingestVerifiedWechatPaymentEvent({
          ...firstConflictFact,
          rawDigest: "d".repeat(64),
        }),
      ).resolves.toMatchObject({ status: "REVIEW_REQUIRED" });
      expect(
        await prisma.providerEvent.findUnique({ where: { id: conflictReceipt.providerEventId } }),
      ).toMatchObject({ status: ProviderEventStatus.REVIEW_REQUIRED });
      await expect(
        payments.applyVerifiedWechatPaymentEvent(conflictReceipt.providerEventId),
      ).resolves.toMatchObject({ status: "REVIEW_REQUIRED" });
      expect(await prisma.paymentTransaction.count({ where: { orderId: conflictOrder.id } })).toBe(
        0,
      );

      await cleanupGroupingData();
      const duplicateRound = await createPayingRound("m5-duplicate-transaction");
      const duplicateOrder = await createOrder(
        "a",
        duplicateRound,
        "m5-duplicate-transaction-order",
      );
      const duplicateDetails = await orderDetails(duplicateOrder.id);
      const first = await payments.ingestVerifiedWechatPaymentEvent(
        paymentEvent(duplicateDetails, "m5firstproviderfact", "5".repeat(64)),
      );
      await expect(
        payments.applyVerifiedWechatPaymentEvent(first.providerEventId),
      ).resolves.toMatchObject({
        status: "APPLIED",
      });
      const duplicate = await payments.ingestVerifiedWechatPaymentEvent(
        paymentEvent(duplicateDetails, "m5secondproviderfact", "6".repeat(64)),
      );
      await expect(
        payments.applyVerifiedWechatPaymentEvent(duplicate.providerEventId),
      ).resolves.toMatchObject({
        status: "REVIEW_REQUIRED",
      });

      await cleanupGroupingData();
      const refundRound = await createPayingRound("m5-refund-recovery");
      const refundOrder = await createOrder("a", refundRound, "m5-refund-recovery-order");
      const refundDetails = await orderDetails(refundOrder.id);
      const payment = await payments.ingestVerifiedWechatPaymentEvent(
        paymentEvent(refundDetails, "m5refundpaymentfact", "7".repeat(64)),
      );
      await expect(
        payments.applyVerifiedWechatPaymentEvent(payment.providerEventId),
      ).resolves.toMatchObject({
        status: "APPLIED",
      });
      await prisma.formationRound.update({
        where: { id: refundRound.id },
        data: { state: RoundState.REFUNDING, invalidationReason: "PAYMENT_TIMEOUT" },
      });
      await prisma.companionGroup.update({
        where: { id: refundRound.groupId },
        data: { state: GroupState.REFUNDING },
      });
      await prisma.serviceOrder.update({
        where: { id: refundOrder.id },
        data: { status: OrderStatus.REFUND_PENDING },
      });
      const refund = await prisma.refund.create({
        data: {
          campusId: ids.campus,
          orderId: refundOrder.id,
          amountFen: 99,
          reason: RefundReason.ROUND_INVALIDATED,
          status: RefundStatus.REQUESTED,
        },
      });
      const refundEvent = await payments.ingestVerifiedWechatRefundEvent({
        eventId: "m5refundproviderfact",
        eventType: "REFUND.SUCCESS",
        verifierKeyId: "m5-test-verifier-key",
        rawDigest: "8".repeat(64),
        merchantOrderNo: refundDetails.merchantOrderNo,
        merchantRefundNo: refund.merchantRefundNo,
        providerRefundId: "m5providerrefundidentifier",
        amountFen: 99,
        currency: "CNY",
        occurredAt: new Date(),
      });
      await expect(
        payments.applyVerifiedWechatRefundEvent(refundEvent.providerEventId),
      ).resolves.toMatchObject({
        status: "APPLIED",
      });
      expect(await prisma.refund.findUnique({ where: { id: refund.id } })).toMatchObject({
        status: RefundStatus.REFUNDED,
      });
      expect(
        await prisma.formationRound.findUnique({ where: { id: refundRound.id } }),
      ).toMatchObject({
        state: RoundState.INVALIDATED,
      });
      expect(
        await prisma.companionGroup.findUnique({ where: { id: refundRound.groupId } }),
      ).toMatchObject({
        state: GroupState.RECRUITING,
      });
    } finally {
      await cleanupGroupingData();
    }
  }, 90_000);

  async function createPayingRound(prefix: string): Promise<Formation> {
    const demandA = await createDemand("a", `${prefix}-demand-a`);
    const demandB = await createDemand("b", `${prefix}-demand-b`);
    expect(
      (
        await request(
          "POST",
          `/v1/groups/${demandA.groupId}/join`,
          { demandId: demandB.id },
          { ...auth("b"), "idempotency-key": `${prefix}-join-b` },
        )
      ).statusCode,
    ).toBe(200);
    const started = await request(
      "POST",
      `/v1/groups/${demandA.groupId}/formation-rounds`,
      undefined,
      { ...auth("a"), "idempotency-key": `${prefix}-start-round` },
    );
    expect(started.statusCode).toBe(201);
    const round = started.json<Formation>();
    const confirmations = await Promise.all(
      ["a", "b"].map((subject) =>
        request(
          "POST",
          `/v1/formation-rounds/${round.id}/confirm`,
          {
            decision: "ACCEPT",
            contactConsent: { granted: true, policyVersion: round.contactPolicyVersion },
          },
          { ...auth(subject), "idempotency-key": `${prefix}-confirm-${subject}` },
        ),
      ),
    );
    expect(confirmations.every((response) => response.statusCode === 200)).toBe(true);
    for (const subject of ["a", "b"]) {
      expect(
        (
          await request(
            "POST",
            "/v1/me/contact",
            { wechatId: `m5wechat_${subject}` },
            { ...auth(subject), "idempotency-key": `${prefix}-contact-${subject}` },
          )
        ).statusCode,
      ).toBe(200);
    }
    return round;
  }

  async function createDemand(subject: string, key: string): Promise<Demand> {
    const response = await request(
      "POST",
      "/v1/demands",
      {
        routeId: ids.route,
        windowStart,
        windowEnd,
        seatCount: 1,
        luggage: "NONE",
        genderPreference: "ANY",
      },
      { ...auth(subject), "idempotency-key": key },
    );
    expect(response.statusCode, response.rawPayload.toString("utf8")).toBe(201);
    return response.json<Demand>();
  }

  async function createOrder(subject: string, round: Formation, key: string): Promise<Order> {
    const response = await request(
      "POST",
      `/v1/groups/${round.groupId}/service-orders`,
      { roundId: round.id },
      { ...auth(subject), "idempotency-key": key },
    );
    expect(response.statusCode, response.rawPayload.toString("utf8")).toBe(201);
    return response.json<Order>();
  }

  async function orderDetails(
    orderId: string,
  ): Promise<{ readonly id: string; readonly merchantOrderNo: string }> {
    const order = await prisma.serviceOrder.findUnique({
      where: { id: orderId },
      select: { id: true, merchantOrderNo: true },
    });
    if (order === null) throw new Error("M5 service order setup failed");
    return order;
  }

  function paymentEvent(
    order: { readonly merchantOrderNo: string },
    eventId: string,
    rawDigest: string,
    amountFen = 99,
  ) {
    return {
      eventId,
      eventType: "TRANSACTION.SUCCESS" as const,
      verifierKeyId: "m5-test-verifier-key",
      rawDigest,
      merchantOrderNo: order.merchantOrderNo,
      providerTransactionId: `m5transaction-${eventId}`,
      amountFen,
      currency: "CNY" as const,
      occurredAt: new Date(),
    };
  }

  async function login(subject: string): Promise<Session> {
    const response = await request("POST", "/v1/auth/wechat/login", {
      code: issueMockWechatCode(`m5-${subject}`, mockSecret, new Date(Date.now() + 60_000)),
    });
    expect(response.statusCode).toBe(200);
    return response.json<Session>();
  }

  function auth(subject: string): Record<string, string> {
    const session = sessions[subject];
    if (session === undefined) throw new Error("missing M5 session");
    return { authorization: `Bearer ${session.accessToken}` };
  }

  async function request(
    method: "GET" | "POST" | "DELETE",
    url: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ): Promise<InjectResponse> {
    return (await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method,
        url,
        headers,
        ...(payload === undefined ? {} : { payload: payload as never }),
      })) as InjectResponse;
  }
});

function futureLocalDate(): string {
  const date = new Date(Date.now() + 4 * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

async function cleanup(): Promise<void> {
  await cleanupGroupingData();
  await prisma.userContact.deleteMany({ where: { campusId: ids.campus } });
  await prisma.studentVerification.deleteMany({ where: { campusId: ids.campus } });
  await prisma.userSession.deleteMany({ where: { campusId: ids.campus } });
  await prisma.user.deleteMany({ where: { campusId: ids.campus } });
  await prisma.routeSchedule.deleteMany({ where: { campusId: ids.campus } });
  await prisma.route.deleteMany({ where: { campusId: ids.campus } });
  await prisma.place.deleteMany({ where: { campusId: ids.campus } });
  await prisma.policyVersion.deleteMany({
    where: { id: { in: [ids.sensitivePolicy, ids.contactPolicy] } },
  });
  await prisma.campus.deleteMany({ where: { id: ids.campus } });
}

async function cleanupGroupingData(): Promise<void> {
  await prisma.contactAccessLog.deleteMany({ where: { campusId: ids.campus } });
  await prisma.contactUnlock.deleteMany({ where: { campusId: ids.campus } });
  await prisma.contactConsent.deleteMany({ where: { campusId: ids.campus } });
  await prisma.memberConfirmation.deleteMany({ where: { campusId: ids.campus } });
  await prisma.reconciliationException.deleteMany({
    where: {
      OR: [{ campusId: ids.campus }, { providerEvent: { is: { eventId: { startsWith: "m5" } } } }],
    },
  });
  await prisma.paymentTransaction.deleteMany({ where: { campusId: ids.campus } });
  await prisma.refund.updateMany({
    where: { campusId: ids.campus, providerEventId: { not: null } },
    data: { providerEventId: null },
  });
  await prisma.providerEvent.deleteMany({
    where: { OR: [{ campusId: ids.campus }, { eventId: { startsWith: "m5" } }] },
  });
  await prisma.refund.deleteMany({ where: { campusId: ids.campus } });
  await prisma.serviceOrder.deleteMany({ where: { campusId: ids.campus } });
  await prisma.formationRound.deleteMany({ where: { campusId: ids.campus } });
  await prisma.groupMember.deleteMany({ where: { campusId: ids.campus } });
  await prisma.travelDemand.deleteMany({ where: { campusId: ids.campus } });
  await prisma.companionGroup.deleteMany({ where: { campusId: ids.campus } });
  await prisma.outboxEvent.deleteMany({ where: { campusId: ids.campus } });
  await prisma.idempotencyRecord.deleteMany({ where: { campusId: ids.campus } });
}

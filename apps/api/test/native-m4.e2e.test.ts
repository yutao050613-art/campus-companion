import { Writable } from "node:stream";
import { issueMockWechatCode } from "@campus/auth";
import {
  createPrismaClient,
  GenderDeclaration,
  GroupState,
  PlaceType,
  PolicyType,
  RoundState,
  VerificationStatus,
} from "@campus/database";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/bootstrap";

const runNative = process.env["NATIVE_POSTGRES_TESTS"] === "true";
const prisma = createPrismaClient();
const ids = {
  campus: "40000000-0000-4000-8000-000000000001",
  sensitivePolicy: "40000000-0000-4000-8000-000000000002",
  contactPolicy: "40000000-0000-4000-8000-000000000003",
  origin: "40000000-0000-4000-8000-000000000004",
  destination: "40000000-0000-4000-8000-000000000005",
  route: "40000000-0000-4000-8000-000000000006",
} as const;
const mockSecret = "m4-mock-wechat-signing-secret-longer-than-thirty-two-bytes";
const accessSecret = "m4-access-token-signing-secret-longer-than-thirty-two-bytes";
const studentSecret = "m4-student-number-hmac-secret-longer-than-thirty-two-bytes";
const uploadSecret = "m4-upload-token-signing-secret-longer-than-thirty-two-bytes";
const encryptionKey = Buffer.alloc(32, 12);

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
  readonly state: string;
  readonly contactPolicyVersion: string;
}

interface Order {
  readonly id: string;
  readonly status: string;
  readonly amountFen: number;
}

interface Prepay {
  readonly intentId: string;
  readonly amountFen: number;
}

interface InjectResponse {
  readonly statusCode: number;
  readonly rawPayload: Buffer;
  json<T = unknown>(): T;
}

describe.runIf(runNative)("M4 native PostgreSQL payment and contact API", () => {
  let app: NestFastifyApplication;
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
      WECHAT_MOCK_DEFAULT_CAMPUS_ID: ids.campus,
      WECHAT_MOCK_SIGNING_SECRET: mockSecret,
      AUTH_ACCESS_TOKEN_SECRET: accessSecret,
      STUDENT_NUMBER_HMAC_SECRET: studentSecret,
      DATA_ENCRYPTION_KEY_BASE64: encryptionKey.toString("base64"),
      DATA_ENCRYPTION_KEY_VERSION: "m4-native-test",
      LOCAL_OBJECT_UPLOAD_SECRET: uploadSecret,
      LOCAL_OBJECT_STORE_ROOT: "D:\\campus-companion-m4-native-objects",
      PUBLIC_API_BASE_URL: "http://127.0.0.1:3000",
      ADMIN_TRUSTED_ORIGINS: "http://127.0.0.1:5173",
    });
    await cleanup();
    await prisma.campus.create({
      data: { id: ids.campus, name: "M4 Native Campus", timezone: "Asia/Shanghai" },
    });
    await prisma.policyVersion.createMany({
      data: [
        {
          id: ids.sensitivePolicy,
          type: PolicyType.SENSITIVE_INFO,
          version: "sensitive-info-m4-native",
          contentDigest: "a".repeat(64),
          effectiveAt: new Date(Date.now() - 60_000),
        },
        {
          id: ids.contactPolicy,
          type: PolicyType.CONTACT_SHARING,
          version: "contact-sharing-m4-native",
          contentDigest: "b".repeat(64),
          effectiveAt: new Date(Date.now() - 60_000),
        },
      ],
    });
    await prisma.place.createMany({
      data: [
        { id: ids.origin, campusId: ids.campus, name: "M4 Gate", type: PlaceType.CAMPUS_GATE },
        { id: ids.destination, campusId: ids.campus, name: "M4 Hub", type: PlaceType.TRANSIT_HUB },
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
    for (const subject of ["a", "b", "outsider"]) {
      sessions[subject] = await login(subject);
    }
    for (const [index, subject] of ["a", "b", "outsider"].entries()) {
      const session = sessions[subject];
      if (session === undefined) throw new Error("M4 session setup failed");
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

  it("repeats concurrent final payment and all-or-nothing contact delivery for 20 rounds", async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const round = await createPayingRound(`m4-delivery-${attempt}`);
        const [orderA, orderB] = await Promise.all([
          createOrder("a", round, `m4-delivery-${attempt}-a-order`),
          createOrder("b", round, `m4-delivery-${attempt}-b-order`),
        ]);
        expect(orderA.amountFen).toBe(99);
        expect(orderB.amountFen).toBe(99);
        const [prepayA, prepayB] = await Promise.all([
          prepay("a", orderA.id, `m4-delivery-${attempt}-a-prepay`),
          prepay("b", orderB.id, `m4-delivery-${attempt}-b-prepay`),
        ]);
        const settlements = await Promise.all([
          settle("a", orderA.id, prepayA.intentId, `m4-delivery-${attempt}-a-settle`),
          settle("b", orderB.id, prepayB.intentId, `m4-delivery-${attempt}-b-settle`),
        ]);
        expect(settlements.every((response) => response.statusCode === 200)).toBe(true);
        expect(await prisma.formationRound.findUnique({ where: { id: round.id } })).toMatchObject({
          state: RoundState.DELIVERED,
        });
        expect(
          await prisma.companionGroup.findUnique({ where: { id: round.groupId } }),
        ).toMatchObject({
          state: GroupState.CONTACTS_UNLOCKED,
        });
        expect(await prisma.contactUnlock.count({ where: { roundId: round.id } })).toBe(2);
        expect(
          await prisma.serviceOrder.count({ where: { roundId: round.id, status: "DELIVERED" } }),
        ).toBe(2);

        const contactsA = await request(
          "GET",
          `/v1/groups/${round.groupId}/contacts`,
          undefined,
          auth("a"),
        );
        expect(contactsA.statusCode).toBe(200);
        expect(contactsA.json<readonly { label: string; wechatId: string }[]>()).toEqual([
          { label: "成员 1", wechatId: "m4wechat_b" },
        ]);
        expect(contactsA.rawPayload.toString("utf8")).not.toMatch(
          /userId|ciphertext|studentNumber/i,
        );
        expect(
          (
            await request(
              "GET",
              `/v1/groups/${round.groupId}/contacts`,
              undefined,
              auth("outsider"),
            )
          ).statusCode,
        ).toBe(409);
      } finally {
        await cleanupGroupingData();
      }
    }
  }, 180_000);

  it("rejects forged payment facts and keeps a successful replay from creating another charge", async () => {
    try {
      const round = await createPayingRound("m4-forgery");
      const forged = await request(
        "POST",
        `/v1/groups/${round.groupId}/service-orders`,
        { roundId: round.id, amountFen: 1, status: "PAID" },
        { ...auth("a"), "idempotency-key": "m4-forgery-order-key" },
      );
      expect(forged.statusCode).toBe(400);
      const order = await createOrder("a", round, "m4-forgery-a-order");
      const invalidIntent = await settle(
        "a",
        order.id,
        "mock_intent_0000000000000000000000000000000000000000",
        "m4-forgery-invalid-intent",
      );
      expect(invalidIntent.statusCode).toBe(404);
      expect(await prisma.paymentTransaction.count({ where: { orderId: order.id } })).toBe(0);
      const payment = await prepay("a", order.id, "m4-forgery-a-prepay");
      const first = await settle("a", order.id, payment.intentId, "m4-forgery-a-settle");
      const replay = await settle("a", order.id, payment.intentId, "m4-forgery-a-settle");
      expect(first.statusCode).toBe(200);
      expect(replay.statusCode).toBe(200);
      expect(first.json<Order>()).toEqual(replay.json<Order>());
      expect(await prisma.paymentTransaction.count({ where: { orderId: order.id } })).toBe(2);
    } finally {
      await cleanupGroupingData();
    }
  });

  it("denies every future contact read after a delivered member revokes consent", async () => {
    try {
      const round = await createPayingRound("m4-revoke");
      const orderA = await createOrder("a", round, "m4-revoke-a-order");
      const orderB = await createOrder("b", round, "m4-revoke-b-order");
      const prepayA = await prepay("a", orderA.id, "m4-revoke-a-prepay");
      const prepayB = await prepay("b", orderB.id, "m4-revoke-b-prepay");
      await settle("a", orderA.id, prepayA.intentId, "m4-revoke-a-settle");
      await settle("b", orderB.id, prepayB.intentId, "m4-revoke-b-settle");
      expect(
        (
          await request("DELETE", `/v1/formation-rounds/${round.id}/contact-consent`, undefined, {
            ...auth("a"),
            "idempotency-key": "m4-revoke-contact-consent",
          })
        ).statusCode,
      ).toBe(204);
      const denied = await request(
        "GET",
        `/v1/groups/${round.groupId}/contacts`,
        undefined,
        auth("b"),
      );
      expect(denied.statusCode).toBe(409);
      const viewerId = sessions["b"]?.user.id;
      if (viewerId === undefined) throw new Error("M4 B session is unavailable");
      expect(
        await prisma.contactAccessLog.findFirst({ where: { roundId: round.id, viewerId } }),
      ).toMatchObject({
        outcome: "DENIED",
      });
    } finally {
      await cleanupGroupingData();
    }
  });

  it("repeats settlement-versus-pre-delivery-consent-revocation races for 20 rounds", async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const round = await createPayingRound(`m4-revoke-race-${attempt}`);
        const orderA = await createOrder("a", round, `m4-revoke-race-${attempt}-a-order`);
        const orderB = await createOrder("b", round, `m4-revoke-race-${attempt}-b-order`);
        const prepayA = await prepay("a", orderA.id, `m4-revoke-race-${attempt}-a-prepay`);
        const prepayB = await prepay("b", orderB.id, `m4-revoke-race-${attempt}-b-prepay`);
        expect(
          (await settle("a", orderA.id, prepayA.intentId, `m4-revoke-race-${attempt}-a-settle`))
            .statusCode,
        ).toBe(200);
        const [settlement, revocation] = await Promise.all([
          settle("b", orderB.id, prepayB.intentId, `m4-revoke-race-${attempt}-b-settle`),
          request("DELETE", `/v1/formation-rounds/${round.id}/contact-consent`, undefined, {
            ...auth("a"),
            "idempotency-key": `m4-revoke-race-${attempt}-revoke`,
          }),
        ]);
        expect([200, 409]).toContain(settlement.statusCode);
        expect(revocation.statusCode).toBe(204);
        const group = await prisma.companionGroup.findUnique({ where: { id: round.groupId } });
        const deliveredUnlocks = await prisma.contactUnlock.count({ where: { roundId: round.id } });
        expect([GroupState.CONTACTS_UNLOCKED, GroupState.REFUNDING]).toContain(group?.state);
        if (group?.state === GroupState.REFUNDING) expect(deliveredUnlocks).toBe(0);
        if (group?.state === GroupState.CONTACTS_UNLOCKED) expect(deliveredUnlocks).toBe(2);
        expect(
          (await request("GET", `/v1/groups/${round.groupId}/contacts`, undefined, auth("b")))
            .statusCode,
        ).toBe(409);
      } finally {
        await cleanupGroupingData();
      }
    }
  }, 180_000);

  async function createPayingRound(prefix: string): Promise<Formation> {
    const demandA = await createDemand("a", `${prefix}-demand-a`);
    const demandB = await createDemand("b", `${prefix}-demand-b`);
    const joined = await request(
      "POST",
      `/v1/groups/${demandA.groupId}/join`,
      { demandId: demandB.id },
      { ...auth("b"), "idempotency-key": `${prefix}-join-b` },
    );
    expect(joined.statusCode).toBe(200);
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
    expect(await prisma.formationRound.findUnique({ where: { id: round.id } })).toMatchObject({
      state: RoundState.PAYING,
    });
    for (const subject of ["a", "b"]) {
      const setContact = await request(
        "POST",
        "/v1/me/contact",
        { wechatId: `m4wechat_${subject}` },
        { ...auth(subject), "idempotency-key": `${prefix}-contact-${subject}` },
      );
      expect(setContact.statusCode).toBe(200);
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
    expect(response.statusCode).toBe(201);
    return response.json<Demand>();
  }

  async function createOrder(subject: string, round: Formation, key: string): Promise<Order> {
    const response = await request(
      "POST",
      `/v1/groups/${round.groupId}/service-orders`,
      { roundId: round.id },
      { ...auth(subject), "idempotency-key": key },
    );
    expect(response.statusCode, response.rawPayload.toString("utf8")).toBeLessThan(300);
    return response.json<Order>();
  }

  async function prepay(subject: string, orderId: string, key: string): Promise<Prepay> {
    const response = await request("POST", `/v1/service-orders/${orderId}/prepay`, undefined, {
      ...auth(subject),
      "idempotency-key": key,
    });
    expect(response.statusCode, response.rawPayload.toString("utf8")).toBe(200);
    return response.json<Prepay>();
  }

  function settle(
    subject: string,
    orderId: string,
    intentId: string,
    key: string,
  ): Promise<InjectResponse> {
    return request(
      "POST",
      `/v1/service-orders/${orderId}/mock-settlement`,
      { intentId },
      { ...auth(subject), "idempotency-key": key },
    );
  }

  async function login(subject: string): Promise<Session> {
    const response = await request("POST", "/v1/auth/wechat/login", {
      code: issueMockWechatCode(`m4-${subject}`, mockSecret, new Date(Date.now() + 60_000)),
    });
    expect(response.statusCode).toBe(200);
    return response.json<Session>();
  }

  function auth(subject: string): Record<string, string> {
    const session = sessions[subject];
    if (session === undefined) throw new Error("missing M4 session");
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
  const date = new Date(Date.now() + 3 * 86_400_000);
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
  await prisma.refund.deleteMany({ where: { campusId: ids.campus } });
  await prisma.paymentTransaction.deleteMany({ where: { order: { campusId: ids.campus } } });
  await prisma.serviceOrder.deleteMany({ where: { campusId: ids.campus } });
  await prisma.formationRound.deleteMany({ where: { campusId: ids.campus } });
  await prisma.groupMember.deleteMany({ where: { campusId: ids.campus } });
  await prisma.travelDemand.deleteMany({ where: { campusId: ids.campus } });
  await prisma.companionGroup.deleteMany({ where: { campusId: ids.campus } });
  await prisma.outboxEvent.deleteMany({ where: { campusId: ids.campus } });
  await prisma.idempotencyRecord.deleteMany({ where: { campusId: ids.campus } });
}

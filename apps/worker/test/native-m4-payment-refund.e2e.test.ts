import { randomUUID } from "node:crypto";
import {
  createPrismaClient,
  DemandStatus,
  GenderPreference,
  GroupState,
  LuggageSize,
  MemberStatus,
  PaymentProvider,
  PaymentStatus,
  PlaceType,
  PolicyType,
  RefundStatus,
  RoundState,
} from "@campus/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaPaymentRefundRepository } from "../src/payment-refund";

const runNative = process.env["NATIVE_POSTGRES_TESTS"] === "true";
const prisma = createPrismaClient();
const now = new Date("2026-08-01T12:00:00.000Z");
const ids = {
  campus: "41000000-0000-4000-8000-000000000001",
  policy: "41000000-0000-4000-8000-000000000002",
  origin: "41000000-0000-4000-8000-000000000003",
  destination: "41000000-0000-4000-8000-000000000004",
  route: "41000000-0000-4000-8000-000000000005",
  userA: "41000000-0000-4000-8000-000000000006",
  userB: "41000000-0000-4000-8000-000000000007",
} as const;

describe.runIf(runNative)("M4 native payment timeout and refund worker", () => {
  beforeAll(async () => {
    await cleanup();
    await prisma.campus.create({ data: { id: ids.campus, name: "M4 Refund Campus" } });
    await prisma.policyVersion.create({
      data: {
        id: ids.policy,
        type: PolicyType.CONTACT_SHARING,
        version: "m4-refund-policy",
        contentDigest: "f".repeat(64),
        effectiveAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    });
    await prisma.place.createMany({
      data: [
        { id: ids.origin, campusId: ids.campus, name: "Refund Gate", type: PlaceType.CAMPUS_GATE },
        {
          id: ids.destination,
          campusId: ids.campus,
          name: "Refund Hub",
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
      },
    });
    await prisma.user.createMany({
      data: [
        { id: ids.userA, campusId: ids.campus, wechatSubject: "m4-refund-a", displayName: "A" },
        { id: ids.userB, campusId: ids.campus, wechatSubject: "m4-refund-b", displayName: "B" },
      ],
    });
  });

  afterAll(async () => {
    try {
      await cleanup();
    } finally {
      await prisma.$disconnect();
    }
  });

  it("repeats payment-timeout removal, full refund, and recruitable recovery for 20 rounds", async () => {
    const repository = new PrismaPaymentRefundRepository(prisma, "test");
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const seeded = await seedPayingRound(attempt);
      try {
        expect(await repository.listDuePaymentRoundIds(now)).toContain(seeded.roundId);
        await expect(repository.invalidatePaymentRound(seeded.roundId, now)).resolves.toBe(true);
        await expect(repository.invalidatePaymentRound(seeded.roundId, now)).resolves.toBe(false);
        expect(
          await prisma.formationRound.findUnique({ where: { id: seeded.roundId } }),
        ).toMatchObject({
          state: RoundState.REFUNDING,
          invalidationReason: "PAYMENT_TIMEOUT",
        });
        expect(
          await prisma.companionGroup.findUnique({ where: { id: seeded.groupId } }),
        ).toMatchObject({
          state: GroupState.REFUNDING,
        });
        expect(
          await prisma.groupMember.findUnique({ where: { id: seeded.memberBId } }),
        ).toMatchObject({
          status: MemberStatus.PAYMENT_TIMEOUT,
        });
        expect(
          await prisma.travelDemand.findUnique({ where: { id: seeded.demandBId } }),
        ).toMatchObject({
          status: DemandStatus.OPEN,
        });
        expect(
          await prisma.serviceOrder.findUnique({ where: { id: seeded.orderId } }),
        ).toMatchObject({
          status: "REFUND_PENDING",
        });
        const refund = await prisma.refund.findFirst({ where: { orderId: seeded.orderId } });
        expect(refund).toMatchObject({ amountFen: 99, status: RefundStatus.REQUESTED });
        if (refund === null) throw new Error("payment timeout did not create a refund");
        await expect(repository.settleRefund(refund.id, now)).resolves.toBe(true);
        await expect(repository.settleRefund(refund.id, now)).resolves.toBe(false);
        expect(await prisma.refund.findUnique({ where: { id: refund.id } })).toMatchObject({
          status: RefundStatus.REFUNDED,
          providerRefundId: expect.stringMatching(/^mock_ref_/u),
        });
        expect(
          await prisma.serviceOrder.findUnique({ where: { id: seeded.orderId } }),
        ).toMatchObject({
          status: "REFUNDED",
        });
        expect(
          await prisma.formationRound.findUnique({ where: { id: seeded.roundId } }),
        ).toMatchObject({
          state: RoundState.INVALIDATED,
        });
        expect(
          await prisma.companionGroup.findUnique({ where: { id: seeded.groupId } }),
        ).toMatchObject({
          state: GroupState.RECRUITING,
        });
        expect(
          await prisma.groupMember.findUnique({ where: { id: seeded.memberAId } }),
        ).toMatchObject({
          status: MemberStatus.JOINED,
        });
      } finally {
        await cleanupRound(seeded.groupId);
      }
    }

    const retrySeed = await seedPayingRound(20_001);
    try {
      const failingRepository = new PrismaPaymentRefundRepository(prisma, "test", {
        refund: () => {
          throw new Error("injected mock refund failure");
        },
      });
      await expect(failingRepository.invalidatePaymentRound(retrySeed.roundId, now)).resolves.toBe(
        true,
      );
      const retryRefund = await prisma.refund.findFirst({ where: { orderId: retrySeed.orderId } });
      if (retryRefund === null)
        throw new Error("payment timeout did not create an injected retry refund");
      await expect(failingRepository.settleRefund(retryRefund.id, now)).resolves.toBe(false);
      expect(await prisma.refund.findUnique({ where: { id: retryRefund.id } })).toMatchObject({
        status: RefundStatus.REQUESTED,
      });
      expect(
        await prisma.outboxEvent.findFirst({
          where: { aggregateId: retryRefund.id, eventType: "MockRefundRetryScheduled" },
        }),
      ).not.toBeNull();
      await expect(repository.settleRefund(retryRefund.id, now)).resolves.toBe(true);
    } finally {
      await cleanupRound(retrySeed.groupId);
    }

    const reviewSeed = await seedPayingRound(20_002);
    try {
      await prisma.paymentTransaction.deleteMany({ where: { orderId: reviewSeed.orderId } });
      await expect(repository.invalidatePaymentRound(reviewSeed.roundId, now)).resolves.toBe(true);
      const reviewRefund = await prisma.refund.findFirst({
        where: { orderId: reviewSeed.orderId },
      });
      if (reviewRefund === null)
        throw new Error("payment timeout did not create a manual-review refund");
      await expect(repository.settleRefund(reviewRefund.id, now)).resolves.toBe(false);
      expect(await prisma.refund.findUnique({ where: { id: reviewRefund.id } })).toMatchObject({
        status: RefundStatus.REVIEW_REQUIRED,
      });
      expect(
        await prisma.formationRound.findUnique({ where: { id: reviewSeed.roundId } }),
      ).toMatchObject({
        state: RoundState.REFUND_RETRY,
      });
      expect(
        await prisma.companionGroup.findUnique({ where: { id: reviewSeed.groupId } }),
      ).toMatchObject({
        state: GroupState.REFUND_RETRY,
      });
    } finally {
      await cleanupRound(reviewSeed.groupId);
    }
  }, 180_000);
});

async function seedPayingRound(attempt: number): Promise<{
  readonly groupId: string;
  readonly roundId: string;
  readonly orderId: string;
  readonly memberAId: string;
  readonly memberBId: string;
  readonly demandBId: string;
}> {
  const groupId = randomUUID();
  const roundId = randomUUID();
  const demandAId = randomUUID();
  const demandBId = randomUUID();
  const memberAId = randomUUID();
  const memberBId = randomUUID();
  const orderId = randomUUID();
  const payBy = new Date(now.getTime() - 1_000);
  await prisma.companionGroup.create({
    data: {
      id: groupId,
      campusId: ids.campus,
      routeId: ids.route,
      windowStart: new Date(now.getTime() + 60 * 60_000),
      windowEnd: new Date(now.getTime() + 90 * 60_000),
      state: GroupState.PAYING,
    },
  });
  await prisma.travelDemand.createMany({
    data: [
      {
        id: demandAId,
        userId: ids.userA,
        campusId: ids.campus,
        routeId: ids.route,
        windowStart: new Date(now.getTime() + 60 * 60_000),
        windowEnd: new Date(now.getTime() + 90 * 60_000),
        seatCount: 1,
        luggageSize: LuggageSize.NONE,
        genderPreference: GenderPreference.ANY,
        status: DemandStatus.GROUPED,
      },
      {
        id: demandBId,
        userId: ids.userB,
        campusId: ids.campus,
        routeId: ids.route,
        windowStart: new Date(now.getTime() + 60 * 60_000),
        windowEnd: new Date(now.getTime() + 90 * 60_000),
        seatCount: 1,
        luggageSize: LuggageSize.NONE,
        genderPreference: GenderPreference.ANY,
        status: DemandStatus.GROUPED,
      },
    ],
  });
  await prisma.groupMember.createMany({
    data: [
      {
        id: memberAId,
        campusId: ids.campus,
        groupId,
        userId: ids.userA,
        demandId: demandAId,
        seatCount: 1,
        status: MemberStatus.PAYMENT_PENDING,
      },
      {
        id: memberBId,
        campusId: ids.campus,
        groupId,
        userId: ids.userB,
        demandId: demandBId,
        seatCount: 1,
        status: MemberStatus.PAYMENT_PENDING,
      },
    ],
  });
  await prisma.formationRound.create({
    data: {
      id: roundId,
      campusId: ids.campus,
      groupId,
      sequence: 1,
      memberSnapshotHash: "a".repeat(64),
      state: RoundState.PAYING,
      confirmBy: new Date(now.getTime() - 10 * 60_000),
      payBy,
      contactPolicyVersionId: ids.policy,
    },
  });
  await prisma.serviceOrder.create({
    data: {
      id: orderId,
      campusId: ids.campus,
      roundId,
      userId: ids.userA,
      merchantOrderNo: `m4_refund_${attempt}_${randomUUID().replaceAll("-", "")}`,
      amountFen: 99,
      currency: "CNY",
      pricingVersion: "m4-99-fen-v1",
      expiresAt: payBy,
      status: "PAID",
    },
  });
  await prisma.groupMember.update({
    where: { id: memberAId },
    data: { status: MemberStatus.PAID },
  });
  await prisma.paymentTransaction.create({
    data: {
      campusId: ids.campus,
      orderId,
      provider: PaymentProvider.MOCK,
      providerTransactionId: `mock_txn_${randomUUID().replaceAll("-", "").slice(0, 32)}deadbeef`,
      status: PaymentStatus.SUCCEEDED,
      rawDigest: "b".repeat(64),
      occurredAt: now,
    },
  });
  return { groupId, roundId, orderId, memberAId, memberBId, demandBId };
}

async function cleanupRound(groupId: string): Promise<void> {
  const members = await prisma.groupMember.findMany({
    where: { groupId },
    select: { demandId: true },
  });
  const demandIds = members.map((member) => member.demandId);
  const rounds = await prisma.formationRound.findMany({ where: { groupId }, select: { id: true } });
  const roundIds = rounds.map((round) => round.id);
  const orders = await prisma.serviceOrder.findMany({
    where: { roundId: { in: roundIds } },
    select: { id: true },
  });
  const orderIds = orders.map((order) => order.id);
  await prisma.refund.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.paymentTransaction.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.serviceOrder.deleteMany({ where: { id: { in: orderIds } } });
  await prisma.contactConsent.deleteMany({ where: { roundId: { in: roundIds } } });
  await prisma.formationRound.deleteMany({ where: { id: { in: roundIds } } });
  await prisma.groupMember.deleteMany({ where: { groupId } });
  await prisma.travelDemand.deleteMany({ where: { id: { in: demandIds } } });
  await prisma.companionGroup.delete({ where: { id: groupId } });
  await prisma.outboxEvent.deleteMany({ where: { aggregateId: { in: [...roundIds, groupId] } } });
}

async function cleanup(): Promise<void> {
  await prisma.outboxEvent.deleteMany({ where: { campusId: ids.campus } });
  const groups = await prisma.companionGroup.findMany({
    where: { campusId: ids.campus },
    select: { id: true },
  });
  for (const group of groups) await cleanupRound(group.id);
  await prisma.travelDemand.deleteMany({ where: { campusId: ids.campus } });
  await prisma.user.deleteMany({ where: { campusId: ids.campus } });
  await prisma.route.deleteMany({ where: { campusId: ids.campus } });
  await prisma.place.deleteMany({ where: { campusId: ids.campus } });
  await prisma.policyVersion.deleteMany({ where: { id: ids.policy } });
  await prisma.campus.deleteMany({ where: { id: ids.campus } });
}

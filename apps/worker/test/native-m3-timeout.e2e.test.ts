import {
  createPrismaClient,
  DemandStatus,
  GenderPreference,
  GroupState,
  LuggageSize,
  MemberStatus,
  PlaceType,
  PolicyType,
  RoundState,
} from "@campus/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaFormationDeadlineRepository } from "../src/formation-timeout";

const runNative = process.env["NATIVE_POSTGRES_TESTS"] === "true";
const prisma = createPrismaClient();
const ids = {
  campus: "31000000-0000-4000-8000-000000000001",
  policy: "31000000-0000-4000-8000-000000000002",
  origin: "31000000-0000-4000-8000-000000000003",
  destination: "31000000-0000-4000-8000-000000000004",
  route: "31000000-0000-4000-8000-000000000005",
  userA: "31000000-0000-4000-8000-000000000006",
  userB: "31000000-0000-4000-8000-000000000007",
  confirmingGroup: "31000000-0000-4000-8000-000000000008",
  payingGroup: "31000000-0000-4000-8000-000000000009",
  expiredGroup: "31000000-0000-4000-8000-000000000010",
  confirmingRound: "31000000-0000-4000-8000-000000000011",
  payingRound: "31000000-0000-4000-8000-000000000012",
} as const;
const now = new Date("2026-08-01T12:00:00.000Z");

describe.runIf(runNative)("M3 native formation deadline worker", () => {
  beforeAll(async () => {
    await cleanup();
    await prisma.campus.create({ data: { id: ids.campus, name: "M3 Timeout Campus" } });
    await prisma.policyVersion.create({
      data: {
        id: ids.policy,
        type: PolicyType.CONTACT_SHARING,
        version: "contact-timeout-test",
        contentDigest: "c".repeat(64),
        effectiveAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    });
    await prisma.place.createMany({
      data: [
        { id: ids.origin, campusId: ids.campus, name: "Timeout Gate", type: PlaceType.CAMPUS_GATE },
        {
          id: ids.destination,
          campusId: ids.campus,
          name: "Timeout Hub",
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
        { id: ids.userA, campusId: ids.campus, wechatSubject: "m3-timeout-a", displayName: "A" },
        { id: ids.userB, campusId: ids.campus, wechatSubject: "m3-timeout-b", displayName: "B" },
      ],
    });
    await seedGroup(
      ids.confirmingGroup,
      GroupState.CONFIRMING,
      new Date("2026-08-01T13:00:00.000Z"),
      "confirm",
    );
    await seedGroup(
      ids.payingGroup,
      GroupState.PAYING,
      new Date("2026-08-01T13:00:00.000Z"),
      "paying",
    );
    await seedGroup(
      ids.expiredGroup,
      GroupState.READY,
      new Date("2026-08-01T11:00:00.000Z"),
      "expired",
    );

    await prisma.formationRound.create({
      data: {
        id: ids.confirmingRound,
        campusId: ids.campus,
        groupId: ids.confirmingGroup,
        sequence: 1,
        memberSnapshotHash: "d".repeat(64),
        state: RoundState.CONFIRMING,
        // Keep fixture creation time before its simulated deadline. This test uses a fixed
        // historical clock so it stays valid after that calendar date has passed.
        createdAt: new Date("2026-08-01T11:00:00.000Z"),
        confirmBy: new Date("2026-08-01T11:59:00.000Z"),
        contactPolicyVersionId: ids.policy,
      },
    });
    await prisma.formationRound.create({
      data: {
        id: ids.payingRound,
        campusId: ids.campus,
        groupId: ids.payingGroup,
        sequence: 1,
        memberSnapshotHash: "e".repeat(64),
        state: RoundState.PAYING,
        createdAt: new Date("2026-08-01T11:00:00.000Z"),
        confirmBy: new Date("2026-08-01T11:59:00.000Z"),
        payBy: new Date("2026-08-01T12:05:00.000Z"),
        contactPolicyVersionId: ids.policy,
      },
    });
    await prisma.groupMember.updateMany({
      where: { groupId: ids.confirmingGroup, userId: ids.userA },
      data: { status: MemberStatus.CONFIRMED },
    });
    await prisma.contactConsent.create({
      data: {
        campusId: ids.campus,
        roundId: ids.confirmingRound,
        userId: ids.userA,
        policyVersionId: ids.policy,
        grantedAt: new Date("2026-08-01T11:01:00.000Z"),
      },
    });
    await prisma.outboxEvent.create({
      data: {
        campusId: ids.campus,
        aggregateType: "FormationRound",
        aggregateId: ids.confirmingRound,
        eventType: "FormationConfirmationTimeout",
        payload: { groupId: ids.confirmingGroup },
        availableAt: new Date("2026-08-01T11:59:00.000Z"),
        createdAt: new Date("2026-08-01T11:01:00.000Z"),
      },
    });
  });

  afterAll(async () => {
    try {
      await cleanup();
    } finally {
      await prisma.$disconnect();
    }
  });

  it("rolls back only overdue confirming rounds and expires only recruitable groups", async () => {
    const repository = new PrismaFormationDeadlineRepository(prisma);
    expect(await repository.listDueConfirmationRoundIds(now)).toContain(ids.confirmingRound);
    expect(await repository.listDueConfirmationRoundIds(now)).not.toContain(ids.payingRound);
    await expect(repository.invalidateConfirmationRound(ids.confirmingRound, now)).resolves.toBe(
      true,
    );
    await expect(repository.invalidateConfirmationRound(ids.confirmingRound, now)).resolves.toBe(
      false,
    );
    await expect(repository.invalidateConfirmationRound(ids.payingRound, now)).resolves.toBe(false);

    expect(
      await prisma.formationRound.findUnique({ where: { id: ids.confirmingRound } }),
    ).toMatchObject({
      state: RoundState.INVALIDATED,
      invalidationReason: "CONFIRMATION_TIMEOUT",
    });
    expect(
      await prisma.companionGroup.findUnique({ where: { id: ids.confirmingGroup } }),
    ).toMatchObject({
      state: GroupState.READY,
    });
    expect(
      await prisma.groupMember.count({
        where: { groupId: ids.confirmingGroup, status: MemberStatus.CONFIRMED },
      }),
    ).toBe(0);
    expect(
      await prisma.contactConsent.findFirst({ where: { roundId: ids.confirmingRound } }),
    ).toMatchObject({
      revokedAt: now,
    });
    expect(
      await prisma.companionGroup.findUnique({ where: { id: ids.payingGroup } }),
    ).toMatchObject({
      state: GroupState.PAYING,
    });

    expect(await repository.listExpiredRecruitableGroupIds(now)).toContain(ids.expiredGroup);
    await expect(repository.expireRecruitableGroup(ids.expiredGroup, now)).resolves.toBe(true);
    await expect(repository.expireRecruitableGroup(ids.expiredGroup, now)).resolves.toBe(false);
    expect(
      await prisma.companionGroup.findUnique({ where: { id: ids.expiredGroup } }),
    ).toMatchObject({
      state: GroupState.EXPIRED,
    });
    expect(
      await prisma.groupMember.count({
        where: { groupId: ids.expiredGroup, status: MemberStatus.REMOVED },
      }),
    ).toBe(2);
    expect(
      await prisma.travelDemand.count({
        where: { status: DemandStatus.EXPIRED, groupMember: { groupId: ids.expiredGroup } },
      }),
    ).toBe(2);
    expect(await prisma.serviceOrder.count({ where: { roundId: ids.confirmingRound } })).toBe(0);
  });
});

async function seedGroup(
  groupId: string,
  state: GroupState,
  windowEnd: Date,
  suffix: string,
): Promise<void> {
  const windowStart = new Date(windowEnd.getTime() - 30 * 60_000);
  const demandA = await prisma.travelDemand.create({
    data: {
      userId: ids.userA,
      campusId: ids.campus,
      routeId: ids.route,
      windowStart,
      windowEnd,
      seatCount: 1,
      luggageSize: LuggageSize.NONE,
      genderPreference: GenderPreference.ANY,
      status: DemandStatus.GROUPED,
    },
  });
  const demandB = await prisma.travelDemand.create({
    data: {
      userId: ids.userB,
      campusId: ids.campus,
      routeId: ids.route,
      windowStart,
      windowEnd,
      seatCount: 1,
      luggageSize: LuggageSize.NONE,
      genderPreference: GenderPreference.ANY,
      status: DemandStatus.GROUPED,
    },
  });
  await prisma.companionGroup.create({
    data: { id: groupId, campusId: ids.campus, routeId: ids.route, windowStart, windowEnd, state },
  });
  await prisma.groupMember.createMany({
    data: [
      { campusId: ids.campus, groupId, userId: ids.userA, demandId: demandA.id, seatCount: 1 },
      { campusId: ids.campus, groupId, userId: ids.userB, demandId: demandB.id, seatCount: 1 },
    ],
  });
  void suffix;
}

async function cleanup(): Promise<void> {
  await prisma.contactConsent.deleteMany({ where: { campusId: ids.campus } });
  await prisma.memberConfirmation.deleteMany({ where: { campusId: ids.campus } });
  await prisma.serviceOrder.deleteMany({ where: { campusId: ids.campus } });
  await prisma.formationRound.deleteMany({ where: { campusId: ids.campus } });
  await prisma.groupMember.deleteMany({ where: { campusId: ids.campus } });
  await prisma.travelDemand.deleteMany({ where: { campusId: ids.campus } });
  await prisma.companionGroup.deleteMany({ where: { campusId: ids.campus } });
  await prisma.outboxEvent.deleteMany({ where: { campusId: ids.campus } });
  await prisma.route.deleteMany({ where: { campusId: ids.campus } });
  await prisma.place.deleteMany({ where: { campusId: ids.campus } });
  await prisma.user.deleteMany({ where: { campusId: ids.campus } });
  await prisma.policyVersion.deleteMany({ where: { id: ids.policy } });
  await prisma.campus.deleteMany({ where: { id: ids.campus } });
}

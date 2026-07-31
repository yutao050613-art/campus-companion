import { randomUUID } from "node:crypto";
import { sha256Hex } from "@campus/auth";
import {
  AccountStatus,
  ConfirmationDecision,
  DemandStatus,
  GenderDeclaration,
  GenderPreference,
  GroupState,
  MemberStatus,
  RoundState,
  VerificationStatus,
} from "@campus/database";
import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedUser } from "../src/auth/auth.service";
import type { PrismaService } from "../src/database/prisma.service";
import { GroupingService } from "../src/grouping/grouping.service";
import type { IdempotencyService } from "../src/m2/idempotency.service";

const now = new Date("2026-08-01T08:00:00.000Z");
const windowStart = "2026-08-02T10:00:00.000Z";
const windowEnd = "2026-08-02T10:30:00.000Z";
const campusId = randomUUID();
const routeId = randomUUID();
const groupId = randomUUID();
const sourceGroupId = randomUUID();
const demandAId = randomUUID();
const demandBId = randomUUID();
const userAId = randomUUID();
const userBId = randomUUID();
const roundId = randomUUID();
const policyId = randomUUID();
const principalA: AuthenticatedUser = { userId: userAId, sessionId: randomUUID(), campusId };
const principalB: AuthenticatedUser = { userId: userBId, sessionId: randomUUID(), campusId };

const verification = {
  status: VerificationStatus.VERIFIED,
  expiresAt: new Date("2026-08-02T08:00:00.000Z"),
};
const userA = {
  id: userAId,
  campusId,
  status: AccountStatus.ACTIVE,
  deletedAt: null,
  genderDeclaration: GenderDeclaration.FEMALE,
  verifications: [verification],
};
const userB = {
  id: userBId,
  campusId,
  status: AccountStatus.ACTIVE,
  deletedAt: null,
  genderDeclaration: GenderDeclaration.FEMALE,
  verifications: [verification],
};
const demandA = {
  id: demandAId,
  userId: userAId,
  campusId,
  routeId,
  windowStart: new Date(windowStart),
  windowEnd: new Date(windowEnd),
  seatCount: 1,
  luggageSize: "NONE",
  genderPreference: GenderPreference.SAME_GENDER_ONLY,
  status: DemandStatus.GROUPED,
  createdAt: now,
};
const demandB = { ...demandA, id: demandBId, userId: userBId };
const memberA = {
  id: randomUUID(),
  groupId,
  userId: userAId,
  demandId: demandAId,
  seatCount: 1,
  status: MemberStatus.JOINED,
  joinedAt: now,
  user: userA,
  demand: demandA,
};
const memberB = {
  id: randomUUID(),
  groupId,
  userId: userBId,
  demandId: demandBId,
  seatCount: 1,
  status: MemberStatus.JOINED,
  joinedAt: new Date(now.getTime() + 1_000),
  user: userB,
  demand: demandB,
};

function prisma(value: Record<string, unknown>): PrismaService {
  return value as unknown as PrismaService;
}

function idempotency(transaction: Record<string, unknown>): IdempotencyService {
  return {
    execute: vi.fn(async (_operation, _key, _actor, _request, action) => ({
      ...(await action(transaction as never)),
      replayed: false,
    })),
  } as unknown as IdempotencyService;
}

function service(
  transaction: Record<string, unknown>,
  outer: Record<string, unknown> = {},
): GroupingService {
  return new GroupingService(prisma(outer), idempotency(transaction));
}

function groupView(state: GroupState = GroupState.READY) {
  return {
    id: groupId,
    campusId,
    routeId,
    windowStart: new Date(windowStart),
    windowEnd: new Date(windowEnd),
    state,
    version: 2,
    members: [
      { id: memberA.id, seatCount: 1, joinedAt: memberA.joinedAt },
      { id: memberB.id, seatCount: 1, joinedAt: memberB.joinedAt },
    ],
    rounds: [],
  };
}

function eligibleUserDelegate(user = userA) {
  return { findFirst: vi.fn().mockResolvedValue(user) };
}

describe("GroupingService", () => {
  it("creates a verified fixed-window demand and isolated one-account candidate group", async () => {
    const created = { ...demandA, status: DemandStatus.OPEN };
    const grouped = { ...created, status: DemandStatus.GROUPED };
    const transaction = {
      user: eligibleUserDelegate(),
      route: {
        findFirst: vi.fn().mockResolvedValue({
          id: routeId,
          campusId,
          campus: { timezone: "Asia/Shanghai" },
          schedules: [
            {
              weekday: 7,
              startMinute: 1_080,
              endMinute: 1_140,
              windowMinutes: 30,
              activeFrom: new Date("2026-08-01T00:00:00.000Z"),
              activeUntil: null,
            },
          ],
        }),
      },
      travelDemand: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(created),
        update: vi.fn().mockResolvedValue(grouped),
      },
      companionGroup: { create: vi.fn().mockResolvedValue({ id: groupId }) },
      groupMember: { create: vi.fn().mockResolvedValue({}) },
      outboxEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    await expect(
      service(transaction).createDemand(
        principalA,
        {
          routeId,
          windowStart,
          windowEnd,
          seatCount: 1,
          luggage: "NONE",
          genderPreference: "SAME_GENDER_ONLY",
        },
        "m3-create-demand-unit-0001",
        now,
      ),
    ).resolves.toMatchObject({ id: demandAId, groupId, status: DemandStatus.GROUPED });
    expect(transaction.groupMember.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ groupId, userId: userAId, seatCount: 1 }),
    });
  });

  it("lists and reads only masked groups for an actively verified viewer", async () => {
    const outer = {
      user: { findFirst: vi.fn().mockResolvedValue({ id: userAId }) },
      companionGroup: {
        findMany: vi.fn().mockResolvedValue([groupView()]),
        findFirst: vi.fn().mockResolvedValue(groupView()),
      },
    };
    const grouping = service({}, outer);
    const listed = await grouping.listGroups(principalA, routeId, windowStart, undefined, now);
    expect(listed.items[0]).toMatchObject({ accountCount: 2, occupiedSeats: 2, remainingSeats: 2 });
    expect(JSON.stringify(listed)).not.toMatch(/userId|gender|wechat/i);
    await expect(grouping.getGroup(principalA, groupId, now)).resolves.toMatchObject({
      id: groupId,
    });

    outer.user.findFirst.mockResolvedValueOnce(null);
    await expect(grouping.getGroup(principalA, groupId, now)).rejects.toMatchObject({
      code: "STUDENT_NOT_VERIFIED",
    });
  });

  it("paginates past full candidate groups without skipping joinable groups", async () => {
    const fullGroups = Array.from({ length: 21 }, () => ({
      ...groupView(),
      id: randomUUID(),
      members: [
        { ...groupView().members[0], seatCount: 3 },
        { ...groupView().members[1], seatCount: 1 },
      ],
    }));
    const joinable = {
      ...groupView(GroupState.RECRUITING),
      id: randomUUID(),
      members: [groupView().members[0]],
    };
    const findMany = vi.fn().mockResolvedValueOnce(fullGroups).mockResolvedValueOnce([joinable]);
    const outer = {
      user: { findFirst: vi.fn().mockResolvedValue({ id: userAId }) },
      companionGroup: { findMany },
    };
    await expect(
      service({}, outer).listGroups(principalA, routeId, windowStart, undefined, now),
    ).resolves.toEqual({ items: [expect.objectContaining({ id: joinable.id })], nextCursor: null });
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(findMany.mock.calls[1]?.[0]).toMatchObject({
      cursor: { id: fullGroups.at(-1)?.id },
      skip: 1,
    });

    const joinablePage = Array.from({ length: 21 }, () => ({ ...groupView(), id: randomUUID() }));
    outer.companionGroup.findMany.mockResolvedValueOnce(joinablePage);
    const page = await service({}, outer).listGroups(
      principalA,
      routeId,
      windowStart,
      undefined,
      now,
    );
    expect(page.items).toHaveLength(20);
    expect(page.nextCursor).toBe(joinablePage[19]?.id);
  });

  it("transfers a sole recruiting demand into a compatible target and recomputes both groups", async () => {
    const sourceMembership = {
      id: randomUUID(),
      groupId: sourceGroupId,
      userId: userBId,
      status: MemberStatus.JOINED,
      group: { id: sourceGroupId, state: GroupState.RECRUITING },
    };
    const target = {
      ...groupView(GroupState.RECRUITING),
      members: [memberA],
    };
    const transaction = {
      user: eligibleUserDelegate(userB),
      companionGroup: {
        findFirst: vi.fn().mockResolvedValueOnce(target).mockResolvedValueOnce(groupView()),
        update: vi.fn().mockResolvedValue({}),
      },
      travelDemand: {
        findFirst: vi.fn().mockResolvedValue({ ...demandB, groupMember: sourceMembership }),
        update: vi.fn().mockResolvedValue({}),
      },
      groupMember: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([
            {
              ...sourceMembership,
              group: { ...sourceMembership.group, members: [sourceMembership] },
            },
          ])
          .mockResolvedValueOnce([]),
        update: vi.fn().mockResolvedValue({}),
      },
      outboxEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    await expect(
      service(transaction).joinGroup(
        principalB,
        groupId,
        demandBId,
        "m3-join-group-unit-0001",
        now,
      ),
    ).resolves.toMatchObject({ id: groupId, accountCount: 2 });
    expect(transaction.groupMember.update).toHaveBeenCalledWith({
      where: { id: sourceMembership.id },
      data: expect.objectContaining({ groupId, status: MemberStatus.JOINED }),
    });
    expect(transaction.companionGroup.update).toHaveBeenCalledWith({
      where: { id: sourceGroupId },
      data: { state: GroupState.EXPIRED, version: { increment: 1 } },
    });
  });

  it("rejects a fifth seat and an expired member before mutating a target group", async () => {
    const fullTarget = {
      ...groupView(),
      members: [
        { ...memberA, seatCount: 3 },
        { ...memberB, userId: randomUUID(), id: randomUUID(), seatCount: 1 },
      ],
    };
    const transaction = {
      user: eligibleUserDelegate(userB),
      companionGroup: { findFirst: vi.fn().mockResolvedValue(fullTarget) },
      travelDemand: {
        findFirst: vi.fn().mockResolvedValue({ ...demandB, groupMember: null }),
      },
      groupMember: { findMany: vi.fn().mockResolvedValue([]), create: vi.fn() },
    };
    await expect(
      service(transaction).joinGroup(
        principalB,
        groupId,
        demandBId,
        "m3-fifth-seat-unit-0001",
        now,
      ),
    ).rejects.toMatchObject({ code: "GROUP_CAPACITY_EXCEEDED" });
    expect(transaction.groupMember.create).not.toHaveBeenCalled();

    const expiredTarget = {
      ...fullTarget,
      members: [
        {
          ...memberA,
          user: { ...userA, verifications: [{ ...verification, expiresAt: now }] },
        },
      ],
    };
    transaction.companionGroup.findFirst.mockResolvedValueOnce(expiredTarget);
    await expect(
      service(transaction).joinGroup(
        principalB,
        groupId,
        demandBId,
        "m3-expired-member-unit-01",
        now,
      ),
    ).rejects.toMatchObject({ code: "GROUP_NOT_JOINABLE" });
  });

  it("starts a locked formation with a policy snapshot and exposes it only to members", async () => {
    const formationGroup = { ...groupView(), members: [memberA, memberB] };
    const round = roundRecord(formationGroup);
    const transaction = {
      user: eligibleUserDelegate(),
      companionGroup: {
        findFirst: vi.fn().mockResolvedValue(formationGroup),
        update: vi.fn().mockResolvedValue({}),
      },
      policyVersion: {
        findFirst: vi.fn().mockResolvedValue({ id: policyId, version: "contact-v1" }),
      },
      formationRound: {
        aggregate: vi.fn().mockResolvedValue({ _max: { sequence: null } }),
        create: vi.fn().mockResolvedValue(round),
      },
      outboxEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    await expect(
      service(transaction).startFormation(principalA, groupId, "m3-start-formation-unit-01", now),
    ).resolves.toMatchObject({ id: roundId, state: RoundState.CONFIRMING, memberCount: 2 });
    expect(transaction.companionGroup.update).toHaveBeenCalledWith({
      where: { id: groupId },
      data: { state: GroupState.CONFIRMING, version: { increment: 1 } },
    });

    const outer = {
      formationRound: {
        findFirst: vi.fn().mockResolvedValue({
          ...round,
          group: { _count: { members: 2 } },
        }),
      },
    };
    await expect(service({}, outer).getFormation(principalA, roundId)).resolves.toMatchObject({
      id: roundId,
      contactPolicyVersion: "contact-v1",
    });
    outer.formationRound.findFirst.mockResolvedValueOnce(null);
    await expect(service({}, outer).getFormation(principalB, roundId)).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
    });
  });

  it("records immutable acceptance and hands off to PAYING only after every snapshot member accepts", async () => {
    const formationGroup = { ...groupView(GroupState.CONFIRMING), members: [memberA, memberB] };
    const round = roundRecord(formationGroup);
    const partial = confirmationTransaction(round, 1);
    await expect(
      service(partial).confirmFormation(
        principalA,
        roundId,
        { decision: "ACCEPT", contactConsent: { granted: true, policyVersion: "contact-v1" } },
        "m3-accept-partial-unit-01",
        now,
      ),
    ).resolves.toMatchObject({ state: RoundState.CONFIRMING });
    expect(partial.contactConsent.create).toHaveBeenCalledOnce();

    const complete = confirmationTransaction(round, 2);
    complete.formationRound.update.mockResolvedValue({
      ...round,
      state: RoundState.PAYING,
      payBy: new Date(now.getTime() + 300_000),
    });
    await expect(
      service(complete).confirmFormation(
        principalB,
        roundId,
        { decision: "ACCEPT", contactConsent: { granted: true, policyVersion: "contact-v1" } },
        "m3-accept-complete-unit-1",
        now,
      ),
    ).resolves.toMatchObject({ state: RoundState.PAYING });
    expect(complete.companionGroup.update).toHaveBeenCalledWith({
      where: { id: groupId },
      data: { state: GroupState.PAYING, version: { increment: 1 } },
    });
    expect(complete.groupMember.updateMany).toHaveBeenCalledWith({
      where: { groupId, status: MemberStatus.CONFIRMED },
      data: { status: MemberStatus.PAYMENT_PENDING },
    });
  });

  it("invalidates a declined round, reopens the demand and revokes prior consent", async () => {
    const formationGroup = { ...groupView(GroupState.CONFIRMING), members: [memberA, memberB] };
    const round = roundRecord(formationGroup);
    const invalidated = { ...round, state: RoundState.INVALIDATED, invalidatedAt: now };
    const transaction = confirmationTransaction(round, 0);
    transaction.formationRound.update.mockResolvedValue(invalidated);
    transaction.groupMember.findMany = vi.fn().mockResolvedValue([memberB]);
    await expect(
      service(transaction).confirmFormation(
        principalA,
        roundId,
        { decision: "DECLINE" },
        "m3-decline-round-unit-01",
        now,
      ),
    ).resolves.toMatchObject({ state: RoundState.INVALIDATED });
    expect(transaction.travelDemand.update).toHaveBeenCalledWith({
      where: { id: demandAId },
      data: { status: DemandStatus.OPEN },
    });
    expect(transaction.contactConsent.updateMany).toHaveBeenCalledWith({
      where: { roundId, revokedAt: null },
      data: { revokedAt: now },
    });
  });

  it("cancels only an owned recruitable demand and recomputes the remaining group", async () => {
    const membership = { ...memberA, user: undefined, demand: undefined };
    const transaction = {
      travelDemand: {
        findFirst: vi.fn().mockResolvedValue({ ...demandA, groupMember: membership }),
        update: vi.fn().mockResolvedValue({}),
      },
      companionGroup: {
        findFirst: vi.fn().mockResolvedValue({ id: groupId, state: GroupState.READY }),
        update: vi.fn().mockResolvedValue({}),
      },
      groupMember: {
        update: vi.fn().mockResolvedValue({}),
        findMany: vi.fn().mockResolvedValue([memberB]),
      },
      outboxEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    await expect(
      service(transaction).cancelDemand(principalA, demandAId, "m3-cancel-demand-unit-01", now),
    ).resolves.toBeUndefined();
    expect(transaction.travelDemand.update).toHaveBeenCalledWith({
      where: { id: demandAId },
      data: { status: DemandStatus.CANCELLED },
    });
    expect(transaction.companionGroup.update).toHaveBeenCalledWith({
      where: { id: groupId },
      data: { state: GroupState.RECRUITING, version: { increment: 1 } },
    });

    transaction.travelDemand.findFirst.mockResolvedValueOnce({
      ...demandA,
      status: DemandStatus.CANCELLED,
      groupMember: null,
    });
    await expect(
      service(transaction).cancelDemand(principalA, demandAId, "m3-cancel-replay-unit-01", now),
    ).resolves.toBeUndefined();
  });

  it("allows a member to leave a multi-account recruitable group but not a locked group", async () => {
    const membershipA = { id: memberA.id, userId: userAId, demandId: demandAId };
    const membershipB = { id: memberB.id, userId: userBId, demandId: demandBId };
    const transaction = {
      companionGroup: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce({
            id: groupId,
            state: GroupState.READY,
            members: [membershipA, membershipB],
          })
          .mockResolvedValueOnce({
            ...groupView(GroupState.RECRUITING),
            members: [groupView().members[1]],
          }),
        update: vi.fn().mockResolvedValue({}),
      },
      groupMember: {
        update: vi.fn().mockResolvedValue({}),
        findMany: vi.fn().mockResolvedValue([memberB]),
      },
      travelDemand: { update: vi.fn().mockResolvedValue({}) },
      outboxEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    await expect(
      service(transaction).leaveGroup(principalA, groupId, "m3-leave-group-unit-001", now),
    ).resolves.toMatchObject({ state: GroupState.RECRUITING, accountCount: 1 });
    expect(transaction.travelDemand.update).toHaveBeenCalledWith({
      where: { id: demandAId },
      data: { status: DemandStatus.OPEN },
    });

    const locked = {
      companionGroup: {
        findFirst: vi.fn().mockResolvedValue({
          id: groupId,
          state: GroupState.CONFIRMING,
          members: [membershipA, membershipB],
        }),
      },
    };
    await expect(
      service(locked).leaveGroup(principalA, groupId, "m3-leave-locked-unit-01", now),
    ).rejects.toMatchObject({ code: "GROUP_NOT_JOINABLE" });
  });

  it("rejects overlapping demands, malformed windows and incompatible gender groups", async () => {
    const baseTransaction = {
      user: eligibleUserDelegate(),
      route: {
        findFirst: vi.fn().mockResolvedValue({
          campus: { timezone: "Asia/Shanghai" },
          schedules: [
            {
              weekday: 7,
              startMinute: 1_080,
              endMinute: 1_140,
              windowMinutes: 30,
              activeFrom: new Date("2026-08-01T00:00:00.000Z"),
              activeUntil: null,
            },
          ],
        }),
      },
      travelDemand: { findFirst: vi.fn().mockResolvedValue({ id: randomUUID() }) },
    };
    await expect(
      service(baseTransaction).createDemand(
        principalA,
        { routeId, windowStart, windowEnd, seatCount: 1, luggage: "NONE", genderPreference: "ANY" },
        "m3-overlap-demand-unit-01",
        now,
      ),
    ).rejects.toMatchObject({ code: "OVERLAPPING_ACTIVE_GROUP" });
    await expect(
      service(baseTransaction).createDemand(
        principalA,
        {
          routeId,
          windowStart: now.toISOString(),
          windowEnd,
          seatCount: 1,
          luggage: "NONE",
          genderPreference: "ANY",
        },
        "m3-invalid-window-unit-001",
        now,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    const maleTarget = {
      ...groupView(GroupState.RECRUITING),
      members: [
        {
          ...memberA,
          user: { ...userA, genderDeclaration: GenderDeclaration.MALE },
        },
      ],
    };
    const joinTransaction = {
      user: eligibleUserDelegate(userB),
      companionGroup: { findFirst: vi.fn().mockResolvedValue(maleTarget) },
      travelDemand: { findFirst: vi.fn().mockResolvedValue({ ...demandB, groupMember: null }) },
      groupMember: { findMany: vi.fn().mockResolvedValue([]) },
    };
    await expect(
      service(joinTransaction).joinGroup(
        principalB,
        groupId,
        demandBId,
        "m3-gender-conflict-unit-1",
        now,
      ),
    ).rejects.toMatchObject({ code: "GENDER_PREFERENCE_INCOMPATIBLE" });
  });

  it("rejects stale, altered, duplicate and wrong-policy formation decisions without writes", async () => {
    const formationGroup = { ...groupView(GroupState.CONFIRMING), members: [memberA, memberB] };
    const round = roundRecord(formationGroup);
    const expired = confirmationTransaction({ ...round, confirmBy: now }, 0);
    await expect(
      service(expired).confirmFormation(
        principalA,
        roundId,
        { decision: "DECLINE" },
        "m3-expired-confirm-unit-1",
        now,
      ),
    ).rejects.toMatchObject({ code: "FORMATION_EXPIRED" });

    const altered = confirmationTransaction({ ...round, memberSnapshotHash: "f".repeat(64) }, 0);
    await expect(
      service(altered).confirmFormation(
        principalA,
        roundId,
        { decision: "DECLINE" },
        "m3-altered-confirm-unit-1",
        now,
      ),
    ).rejects.toMatchObject({ code: "GROUP_NOT_JOINABLE" });

    const duplicate = confirmationTransaction(round, 0);
    duplicate.memberConfirmation.findUnique.mockResolvedValueOnce({ id: randomUUID() });
    await expect(
      service(duplicate).confirmFormation(
        principalA,
        roundId,
        { decision: "DECLINE" },
        "m3-duplicate-confirm-unit",
        now,
      ),
    ).rejects.toMatchObject({ code: "GROUP_NOT_JOINABLE" });

    const wrongPolicy = confirmationTransaction(round, 0);
    await expect(
      service(wrongPolicy).confirmFormation(
        principalA,
        roundId,
        { decision: "ACCEPT", contactConsent: { granted: true, policyVersion: "wrong" } },
        "m3-wrong-policy-unit-001",
        now,
      ),
    ).rejects.toMatchObject({ code: "CONTACT_CONSENT_VERSION_MISMATCH" });
    expect(wrongPolicy.contactConsent.create).not.toHaveBeenCalled();
  });
});

function snapshotHash(members: readonly (typeof memberA)[]): string {
  return sha256Hex(
    JSON.stringify(
      members
        .map((member) => ({
          memberId: member.id,
          userId: member.userId,
          demandId: member.demandId,
          seatCount: member.seatCount,
        }))
        .sort((left, right) => left.userId.localeCompare(right.userId)),
    ),
  );
}

function roundRecord(
  group: ReturnType<typeof groupView> & { members: readonly (typeof memberA)[] },
) {
  return {
    id: roundId,
    campusId,
    groupId,
    state: RoundState.CONFIRMING,
    memberSnapshotHash: snapshotHash(group.members),
    confirmBy: new Date(now.getTime() + 300_000),
    payBy: null,
    createdAt: now,
    contactPolicyVersionId: policyId,
    contactPolicyVersion: { id: policyId, version: "contact-v1" },
    group,
  };
}

function confirmationTransaction(round: ReturnType<typeof roundRecord>, accepted: number) {
  return {
    user: eligibleUserDelegate(round.group.members[0]?.user ?? userA),
    formationRound: {
      findFirst: vi.fn().mockResolvedValue(round),
      update: vi.fn(),
    },
    memberConfirmation: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ decision: ConfirmationDecision.ACCEPT }),
      count: vi.fn().mockResolvedValue(accepted),
    },
    contactConsent: {
      create: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    groupMember: {
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 2 }),
      findMany: vi.fn().mockResolvedValue(round.group.members),
    },
    travelDemand: { update: vi.fn().mockResolvedValue({}) },
    companionGroup: { update: vi.fn().mockResolvedValue({}) },
    outboxEvent: { create: vi.fn().mockResolvedValue({}) },
  };
}

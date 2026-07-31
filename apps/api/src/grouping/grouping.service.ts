import { sha256Hex } from "@campus/auth";
import {
  AccountStatus,
  CatalogStatus,
  ConfirmationDecision,
  DemandStatus,
  GroupState,
  MemberStatus,
  PolicyType,
  type Prisma,
  RoundState,
  VerificationStatus,
} from "@campus/database";
import {
  assertFormationReady,
  type GroupingMember,
  type GroupingSummary,
  isGenderPreferenceCompatible,
  summarizeGroupingMembers,
} from "@campus/domain";
import { Inject, Injectable } from "@nestjs/common";
import type { AuthenticatedUser } from "../auth/auth.service";
import { dateDetailsInZone, matchesWindowRule } from "../catalog/route-windows";
import { ApplicationError } from "../common/application-error";
import { PrismaService } from "../database/prisma.service";
import { IdempotencyService } from "../m2/idempotency.service";

const ACTIVE_MEMBER_STATUSES = [
  MemberStatus.JOINED,
  MemberStatus.CONFIRMED,
  MemberStatus.PAYMENT_PENDING,
  MemberStatus.PAID,
  MemberStatus.CONTACT_UNLOCKED,
] as const;
const RECRUITABLE_GROUP_STATES = [GroupState.RECRUITING, GroupState.READY] as const;
const CONFIRMATION_LIFETIME_MS = 5 * 60 * 1_000;
const PAYMENT_HANDOFF_LIFETIME_MS = 5 * 60 * 1_000;
const GROUP_PAGE_SIZE = 20;
const GROUP_SCAN_BATCH_LIMIT = 5;

export interface CreateDemandInput {
  readonly routeId: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly seatCount: number;
  readonly luggage: "NONE" | "SMALL" | "LARGE";
  readonly genderPreference: "ANY" | "SAME_GENDER_ONLY";
}

export interface DemandResponse {
  readonly id: string;
  readonly routeId: string;
  readonly groupId: string | null;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly seatCount: number;
  readonly status: string;
  readonly createdAt: string;
}

export interface GroupResponse {
  readonly id: string;
  readonly campusId: string;
  readonly routeId: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly state: string;
  readonly accountCount: number;
  readonly occupiedSeats: number;
  readonly remainingSeats: number;
  readonly members: readonly {
    readonly memberId: string;
    readonly displayName: string;
    readonly seatCount: number;
    readonly verified: true;
    readonly joinedAt: string;
  }[];
  readonly activeRoundId: string | null;
  readonly version: number;
}

export interface FormationResponse {
  readonly id: string;
  readonly groupId: string;
  readonly state: string;
  readonly memberCount: number;
  readonly memberSnapshotHash: string;
  readonly contactPolicyVersion: string;
  readonly confirmBy: string;
  readonly payBy: string | null;
  readonly createdAt: string;
}

type Transaction = Prisma.TransactionClient;

@Injectable()
export class GroupingService {
  public constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
  ) {}

  public async createDemand(
    principal: AuthenticatedUser,
    input: CreateDemandInput,
    idempotencyKey: string,
    now = new Date(),
  ): Promise<DemandResponse> {
    const windowStart = parseDateTime(input.windowStart, "windowStart");
    const windowEnd = parseDateTime(input.windowEnd, "windowEnd");
    const result = await this.idempotency.execute(
      "createDemand",
      idempotencyKey,
      principal,
      input,
      async (transaction) => {
        await this.requireEligibleUser(transaction, principal, now);
        await this.requireEnabledRouteWindow(
          transaction,
          principal.campusId,
          input.routeId,
          windowStart,
          windowEnd,
          now,
        );
        await this.rejectOverlappingDemand(transaction, principal.userId, windowStart, windowEnd);
        const demand = await transaction.travelDemand.create({
          data: {
            userId: principal.userId,
            campusId: principal.campusId,
            routeId: input.routeId,
            windowStart,
            windowEnd,
            seatCount: input.seatCount,
            luggageSize: input.luggage,
            genderPreference: input.genderPreference,
          },
        });
        const group = await transaction.companionGroup.create({
          data: {
            campusId: principal.campusId,
            routeId: input.routeId,
            windowStart,
            windowEnd,
          },
        });
        await transaction.groupMember.create({
          data: {
            campusId: principal.campusId,
            groupId: group.id,
            userId: principal.userId,
            demandId: demand.id,
            seatCount: demand.seatCount,
          },
        });
        const grouped = await transaction.travelDemand.update({
          where: { id: demand.id },
          data: { status: DemandStatus.GROUPED },
        });
        await transaction.outboxEvent.create({
          data: {
            campusId: principal.campusId,
            aggregateType: "TravelDemand",
            aggregateId: demand.id,
            eventType: "DemandPublished",
            payload: { groupId: group.id, routeId: input.routeId },
          },
        });
        return { status: 201, body: demandResponse(grouped, group.id) };
      },
      now,
    );
    return result.body;
  }

  public async listMyDemands(
    principal: AuthenticatedUser,
    cursor?: string,
  ): Promise<{ readonly items: readonly DemandResponse[]; readonly nextCursor: string | null }> {
    const demands = await this.prisma.travelDemand.findMany({
      where: { userId: principal.userId, campusId: principal.campusId },
      include: { groupMember: { select: { groupId: true } } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 21,
      ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
    });
    const page = demands.slice(0, 20);
    return {
      items: page.map((demand) => demandResponse(demand, demand.groupMember?.groupId ?? null)),
      nextCursor: demands.length > 20 ? (page.at(-1)?.id ?? null) : null,
    };
  }

  public async getDemand(principal: AuthenticatedUser, demandId: string): Promise<DemandResponse> {
    const demand = await this.prisma.travelDemand.findFirst({
      where: { id: demandId, userId: principal.userId, campusId: principal.campusId },
      include: { groupMember: { select: { groupId: true } } },
    });
    if (demand === null) throw resourceNotFound();
    return demandResponse(demand, demand.groupMember?.groupId ?? null);
  }

  public async cancelDemand(
    principal: AuthenticatedUser,
    demandId: string,
    idempotencyKey: string,
    now = new Date(),
  ): Promise<void> {
    await this.idempotency.execute(
      "cancelDemand",
      idempotencyKey,
      principal,
      { demandId },
      async (transaction) => {
        const demand = await transaction.travelDemand.findFirst({
          where: { id: demandId, userId: principal.userId, campusId: principal.campusId },
          include: { groupMember: true },
        });
        if (demand === null) throw resourceNotFound();
        if (demand.status === DemandStatus.CANCELLED) {
          return { status: 204, body: { cancelled: true } };
        }
        if (demand.status === DemandStatus.EXPIRED) throw stateConflict("demand has expired");
        if (demand.groupMember !== null) {
          const group = await transaction.companionGroup.findFirst({
            where: { id: demand.groupMember.groupId, campusId: principal.campusId },
          });
          if (group === null) throw resourceNotFound();
          if (
            !RECRUITABLE_GROUP_STATES.includes(
              group.state as (typeof RECRUITABLE_GROUP_STATES)[number],
            )
          ) {
            throw stateConflict("locked formation cannot be cancelled");
          }
          await transaction.groupMember.update({
            where: { id: demand.groupMember.id },
            data: { status: MemberStatus.LEFT },
          });
          await this.recomputeRecruitableGroup(transaction, group.id);
        }
        await transaction.travelDemand.update({
          where: { id: demand.id },
          data: { status: DemandStatus.CANCELLED },
        });
        await transaction.outboxEvent.create({
          data: {
            campusId: principal.campusId,
            aggregateType: "TravelDemand",
            aggregateId: demand.id,
            eventType: "DemandCancelled",
            payload: {},
          },
        });
        return { status: 204, body: { cancelled: true } };
      },
      now,
    );
  }

  public async listGroups(
    principal: AuthenticatedUser,
    routeId: string,
    windowStartText: string,
    cursor?: string,
    now = new Date(),
  ): Promise<{ readonly items: readonly GroupResponse[]; readonly nextCursor: string | null }> {
    await this.requireEligibleViewer(principal, now);
    const windowStart = parseDateTime(windowStartText, "windowStart");
    const items: GroupResponse[] = [];
    let scanCursor = cursor;
    for (let batchIndex = 0; batchIndex < GROUP_SCAN_BATCH_LIMIT; batchIndex += 1) {
      const groups = await this.prisma.companionGroup.findMany({
        where: {
          campusId: principal.campusId,
          routeId,
          windowStart,
          state: { in: [GroupState.RECRUITING, GroupState.READY] },
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: GROUP_PAGE_SIZE + 1,
        ...(scanCursor === undefined ? {} : { cursor: { id: scanCursor }, skip: 1 }),
        include: groupViewInclude,
      });
      for (const [index, group] of groups.entries()) {
        scanCursor = group.id;
        const mapped = mapGroup(group);
        if (mapped.remainingSeats > 0) items.push(mapped);
        if (items.length === GROUP_PAGE_SIZE) {
          const hasMore = index < groups.length - 1 || groups.length > GROUP_PAGE_SIZE;
          return { items, nextCursor: hasMore ? scanCursor : null };
        }
      }
      if (groups.length <= GROUP_PAGE_SIZE) return { items, nextCursor: null };
    }
    return { items, nextCursor: scanCursor ?? null };
  }

  public async getGroup(
    principal: AuthenticatedUser,
    groupId: string,
    now = new Date(),
  ): Promise<GroupResponse> {
    await this.requireEligibleViewer(principal, now);
    return this.readGroup(this.prisma, principal.campusId, groupId);
  }

  public async joinGroup(
    principal: AuthenticatedUser,
    groupId: string,
    demandId: string,
    idempotencyKey: string,
    now = new Date(),
  ): Promise<GroupResponse> {
    const result = await this.idempotency.execute(
      "joinGroup",
      idempotencyKey,
      principal,
      { groupId, demandId },
      async (transaction) => {
        const joiningUser = await this.requireEligibleUser(transaction, principal, now);
        const target = await transaction.companionGroup.findFirst({
          where: { id: groupId, campusId: principal.campusId },
          include: groupMembersForRulesInclude,
        });
        if (target === null) throw resourceNotFound();
        if (
          !RECRUITABLE_GROUP_STATES.includes(
            target.state as (typeof RECRUITABLE_GROUP_STATES)[number],
          ) ||
          target.windowEnd <= now
        ) {
          throw new ApplicationError("GROUP_NOT_JOINABLE", "group is not joinable", 409);
        }
        if (
          target.members.some(
            (member) =>
              member.user.status !== AccountStatus.ACTIVE ||
              member.user.deletedAt !== null ||
              !hasActiveVerification(member.user.verifications, now),
          )
        ) {
          throw new ApplicationError(
            "GROUP_NOT_JOINABLE",
            "group contains an ineligible member",
            409,
          );
        }
        const demand = await transaction.travelDemand.findFirst({
          where: { id: demandId, userId: principal.userId, campusId: principal.campusId },
          include: { groupMember: { include: { group: true } } },
        });
        if (demand === null) throw resourceNotFound();
        if (demand.status === DemandStatus.CANCELLED || demand.status === DemandStatus.EXPIRED) {
          throw stateConflict("demand is not active");
        }
        if (
          demand.routeId !== target.routeId ||
          demand.windowStart.getTime() !== target.windowStart.getTime() ||
          demand.windowEnd.getTime() !== target.windowEnd.getTime()
        ) {
          throw new ApplicationError("GROUP_NOT_JOINABLE", "demand does not match group", 409);
        }
        if (
          demand.groupMember?.groupId === target.id &&
          ACTIVE_MEMBER_STATUSES.includes(
            demand.groupMember.status as (typeof ACTIVE_MEMBER_STATUSES)[number],
          )
        ) {
          return {
            status: 200,
            body: await this.readGroup(transaction, principal.campusId, target.id),
          };
        }

        const overlapping = await transaction.groupMember.findMany({
          where: {
            userId: principal.userId,
            campusId: principal.campusId,
            status: { in: [...ACTIVE_MEMBER_STATUSES] },
            group: {
              windowStart: { lt: target.windowEnd },
              windowEnd: { gt: target.windowStart },
            },
          },
          include: {
            group: {
              include: { members: { where: { status: { in: [...ACTIVE_MEMBER_STATUSES] } } } },
            },
          },
        });
        const sourceMembership = demand.groupMember;
        const transferable =
          overlapping.length === 1 &&
          sourceMembership !== null &&
          overlapping[0]?.id === sourceMembership.id &&
          sourceMembership.group.state === GroupState.RECRUITING &&
          overlapping[0].group.members.length === 1;
        if (overlapping.length > 0 && !transferable) {
          throw new ApplicationError(
            "OVERLAPPING_ACTIVE_GROUP",
            "user already has an overlapping active group",
            409,
          );
        }

        const prospective = target.members.map(memberForRules);
        prospective.push({
          userId: joiningUser.id,
          seatCount: demand.seatCount,
          gender: joiningUser.genderDeclaration,
          preference: demand.genderPreference,
        });
        let summary: GroupingSummary;
        try {
          summary = summarizeGroupingMembers(prospective);
        } catch {
          throw new ApplicationError("GROUP_CAPACITY_EXCEEDED", "group capacity is exceeded", 409);
        }
        if (!isGenderPreferenceCompatible(prospective)) {
          throw new ApplicationError(
            "GENDER_PREFERENCE_INCOMPATIBLE",
            "group preference is incompatible",
            409,
          );
        }

        if (sourceMembership === null) {
          await transaction.groupMember.create({
            data: {
              campusId: principal.campusId,
              groupId: target.id,
              userId: principal.userId,
              demandId: demand.id,
              seatCount: demand.seatCount,
            },
          });
        } else {
          await transaction.groupMember.update({
            where: { id: sourceMembership.id },
            data: { groupId: target.id, seatCount: demand.seatCount, status: MemberStatus.JOINED },
          });
          if (sourceMembership.groupId !== target.id) {
            await this.recomputeRecruitableGroup(transaction, sourceMembership.groupId);
          }
        }
        await transaction.travelDemand.update({
          where: { id: demand.id },
          data: { status: DemandStatus.GROUPED },
        });
        await transaction.companionGroup.update({
          where: { id: target.id },
          data: { state: summary.state, version: { increment: 1 } },
        });
        await transaction.outboxEvent.create({
          data: {
            campusId: principal.campusId,
            aggregateType: "CompanionGroup",
            aggregateId: target.id,
            eventType: "MemberJoined",
            payload: { memberCount: summary.accountCount, occupiedSeats: summary.occupiedSeats },
          },
        });
        return {
          status: 200,
          body: await this.readGroup(transaction, principal.campusId, target.id),
        };
      },
      now,
    );
    return result.body;
  }

  public async leaveGroup(
    principal: AuthenticatedUser,
    groupId: string,
    idempotencyKey: string,
    now = new Date(),
  ): Promise<GroupResponse> {
    const result = await this.idempotency.execute(
      "leaveGroup",
      idempotencyKey,
      principal,
      { groupId },
      async (transaction) => {
        const group = await transaction.companionGroup.findFirst({
          where: { id: groupId, campusId: principal.campusId },
          include: { members: { where: { status: { in: [...ACTIVE_MEMBER_STATUSES] } } } },
        });
        if (group === null) throw resourceNotFound();
        if (
          !RECRUITABLE_GROUP_STATES.includes(
            group.state as (typeof RECRUITABLE_GROUP_STATES)[number],
          )
        ) {
          throw stateConflict("locked formation cannot be left");
        }
        const membership = group.members.find((member) => member.userId === principal.userId);
        if (membership === undefined) throw resourceNotFound();
        if (group.members.length === 1) {
          throw stateConflict("cancel the sole demand instead of leaving its group");
        }
        await transaction.groupMember.update({
          where: { id: membership.id },
          data: { status: MemberStatus.LEFT },
        });
        await transaction.travelDemand.update({
          where: { id: membership.demandId },
          data: { status: DemandStatus.OPEN },
        });
        await this.recomputeRecruitableGroup(transaction, group.id);
        await transaction.outboxEvent.create({
          data: {
            campusId: principal.campusId,
            aggregateType: "CompanionGroup",
            aggregateId: group.id,
            eventType: "MemberLeft",
            payload: {},
          },
        });
        return {
          status: 200,
          body: await this.readGroup(transaction, principal.campusId, group.id),
        };
      },
      now,
    );
    return result.body;
  }

  public async startFormation(
    principal: AuthenticatedUser,
    groupId: string,
    idempotencyKey: string,
    now = new Date(),
  ): Promise<FormationResponse> {
    const result = await this.idempotency.execute(
      "startFormation",
      idempotencyKey,
      principal,
      { groupId },
      async (transaction) => {
        await this.requireEligibleUser(transaction, principal, now);
        const group = await transaction.companionGroup.findFirst({
          where: { id: groupId, campusId: principal.campusId },
          include: groupMembersForRulesInclude,
        });
        if (group === null) throw resourceNotFound();
        if (group.state !== GroupState.READY || group.windowStart <= now) {
          throw new ApplicationError("FORMATION_NOT_READY", "group is not ready", 409);
        }
        if (!group.members.some((member) => member.userId === principal.userId)) {
          throw resourceNotFound();
        }
        for (const member of group.members) {
          if (
            member.user.status !== AccountStatus.ACTIVE ||
            member.user.deletedAt !== null ||
            !hasActiveVerification(member.user.verifications, now)
          ) {
            throw new ApplicationError("STUDENT_NOT_VERIFIED", "group member is not eligible", 403);
          }
        }
        const rules = group.members.map(memberForRules);
        try {
          assertFormationReady(rules);
        } catch (error) {
          if (String(error).includes("preference")) {
            throw new ApplicationError(
              "GENDER_PREFERENCE_INCOMPATIBLE",
              "group preference is incompatible",
              409,
            );
          }
          throw new ApplicationError("FORMATION_NOT_READY", "group is not ready", 409);
        }
        const policy = await transaction.policyVersion.findFirst({
          where: {
            type: PolicyType.CONTACT_SHARING,
            effectiveAt: { lte: now },
            OR: [{ retiredAt: null }, { retiredAt: { gt: now } }],
          },
          orderBy: [{ effectiveAt: "desc" }, { version: "desc" }],
        });
        if (policy === null)
          throw new ApplicationError("INTERNAL_ERROR", "policy unavailable", 503);
        const sequence =
          (
            await transaction.formationRound.aggregate({
              where: { groupId: group.id },
              _max: { sequence: true },
            })
          )._max.sequence ?? 0;
        const confirmBy = new Date(
          Math.min(now.getTime() + CONFIRMATION_LIFETIME_MS, group.windowStart.getTime()),
        );
        if (confirmBy <= now) {
          throw new ApplicationError("FORMATION_NOT_READY", "confirmation deadline elapsed", 409);
        }
        const memberSnapshotHash = groupingSnapshotHash(group.members);
        const round = await transaction.formationRound.create({
          data: {
            campusId: principal.campusId,
            groupId: group.id,
            sequence: sequence + 1,
            memberSnapshotHash,
            contactPolicyVersionId: policy.id,
            confirmBy,
          },
          include: { contactPolicyVersion: true },
        });
        await transaction.companionGroup.update({
          where: { id: group.id },
          data: { state: GroupState.CONFIRMING, version: { increment: 1 } },
        });
        await transaction.outboxEvent.create({
          data: {
            campusId: principal.campusId,
            aggregateType: "FormationRound",
            aggregateId: round.id,
            eventType: "FormationConfirmationTimeout",
            payload: { groupId: group.id },
            availableAt: confirmBy,
          },
        });
        return {
          status: 201,
          body: formationResponse(round, group.members.length),
        };
      },
      now,
    );
    return result.body;
  }

  public async getFormation(
    principal: AuthenticatedUser,
    roundId: string,
  ): Promise<FormationResponse> {
    const round = await this.prisma.formationRound.findFirst({
      where: {
        id: roundId,
        campusId: principal.campusId,
        group: {
          members: {
            some: {
              userId: principal.userId,
              status: { in: [...ACTIVE_MEMBER_STATUSES] },
            },
          },
        },
      },
      include: {
        contactPolicyVersion: true,
        group: {
          select: {
            _count: {
              select: { members: { where: { status: { in: [...ACTIVE_MEMBER_STATUSES] } } } },
            },
          },
        },
      },
    });
    if (round === null) throw resourceNotFound();
    return formationResponse(round, round.group._count.members);
  }

  public async confirmFormation(
    principal: AuthenticatedUser,
    roundId: string,
    input:
      | { readonly decision: "DECLINE" }
      | {
          readonly decision: "ACCEPT";
          readonly contactConsent: { readonly granted: true; readonly policyVersion: string };
        },
    idempotencyKey: string,
    now = new Date(),
  ): Promise<FormationResponse> {
    const result = await this.idempotency.execute(
      "confirmFormation",
      idempotencyKey,
      principal,
      { roundId, ...input },
      async (transaction) => {
        await this.requireEligibleUser(transaction, principal, now);
        const round = await transaction.formationRound.findFirst({
          where: { id: roundId, campusId: principal.campusId },
          include: {
            contactPolicyVersion: true,
            group: {
              include: {
                members: {
                  where: { status: { in: [...ACTIVE_MEMBER_STATUSES] } },
                  orderBy: [{ joinedAt: "asc" }, { id: "asc" }],
                  include: {
                    user: {
                      include: {
                        verifications: {
                          where: { status: VerificationStatus.VERIFIED },
                          orderBy: { reviewedAt: "desc" },
                          take: 1,
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        });
        if (round === null) throw resourceNotFound();
        if (round.state !== RoundState.CONFIRMING || round.group.state !== GroupState.CONFIRMING) {
          throw stateConflict("formation round is not confirming");
        }
        if (round.confirmBy <= now) {
          throw new ApplicationError("FORMATION_EXPIRED", "formation confirmation expired", 409);
        }
        const membership = round.group.members.find((member) => member.userId === principal.userId);
        if (membership === undefined) throw resourceNotFound();
        if (groupingSnapshotHash(round.group.members) !== round.memberSnapshotHash) {
          throw stateConflict("formation membership snapshot changed");
        }
        if (
          round.group.members.some(
            (member) =>
              member.user.status !== AccountStatus.ACTIVE ||
              member.user.deletedAt !== null ||
              !hasActiveVerification(member.user.verifications, now),
          )
        ) {
          throw new ApplicationError("STUDENT_NOT_VERIFIED", "group member is not eligible", 403);
        }
        const existing = await transaction.memberConfirmation.findUnique({
          where: { roundId_userId: { roundId: round.id, userId: principal.userId } },
        });
        if (existing !== null) throw stateConflict("formation decision is immutable");
        const snapshotCount = round.group.members.length;
        await transaction.memberConfirmation.create({
          data: {
            campusId: principal.campusId,
            roundId: round.id,
            userId: principal.userId,
            decision:
              input.decision === "ACCEPT"
                ? ConfirmationDecision.ACCEPT
                : ConfirmationDecision.DECLINE,
            decidedAt: now,
          },
        });
        if (input.decision === "DECLINE") {
          await transaction.groupMember.update({
            where: { id: membership.id },
            data: { status: MemberStatus.DECLINED },
          });
          await transaction.travelDemand.update({
            where: { id: membership.demandId },
            data: { status: DemandStatus.OPEN },
          });
          await transaction.groupMember.updateMany({
            where: { groupId: round.groupId, status: MemberStatus.CONFIRMED },
            data: { status: MemberStatus.JOINED },
          });
          await transaction.contactConsent.updateMany({
            where: { roundId: round.id, revokedAt: null },
            data: { revokedAt: now },
          });
          const invalidated = await transaction.formationRound.update({
            where: { id: round.id },
            data: {
              state: RoundState.INVALIDATED,
              invalidatedAt: now,
              invalidationReason: "MEMBER_DECLINED",
            },
            include: { contactPolicyVersion: true },
          });
          await this.recomputeRecruitableGroup(transaction, round.groupId);
          await transaction.outboxEvent.create({
            data: {
              campusId: principal.campusId,
              aggregateType: "FormationRound",
              aggregateId: round.id,
              eventType: "FormationDeclined",
              payload: {},
            },
          });
          return { status: 200, body: formationResponse(invalidated, snapshotCount) };
        }
        if (
          input.contactConsent.policyVersion !== round.contactPolicyVersion.version ||
          input.contactConsent.granted !== true
        ) {
          throw new ApplicationError(
            "CONTACT_CONSENT_VERSION_MISMATCH",
            "contact consent version does not match formation",
            409,
          );
        }
        await transaction.contactConsent.create({
          data: {
            campusId: principal.campusId,
            roundId: round.id,
            userId: principal.userId,
            policyVersionId: round.contactPolicyVersionId,
            grantedAt: now,
          },
        });
        await transaction.groupMember.update({
          where: { id: membership.id },
          data: { status: MemberStatus.CONFIRMED },
        });
        const accepted = await transaction.memberConfirmation.count({
          where: { roundId: round.id, decision: ConfirmationDecision.ACCEPT },
        });
        if (accepted === snapshotCount) {
          const payBy = new Date(now.getTime() + PAYMENT_HANDOFF_LIFETIME_MS);
          const paying = await transaction.formationRound.update({
            where: { id: round.id },
            data: { state: RoundState.PAYING, payBy },
            include: { contactPolicyVersion: true },
          });
          await transaction.companionGroup.update({
            where: { id: round.groupId },
            data: { state: GroupState.PAYING, version: { increment: 1 } },
          });
          await transaction.groupMember.updateMany({
            where: { groupId: round.groupId, status: MemberStatus.CONFIRMED },
            data: { status: MemberStatus.PAYMENT_PENDING },
          });
          await transaction.outboxEvent.create({
            data: {
              campusId: principal.campusId,
              aggregateType: "FormationRound",
              aggregateId: round.id,
              eventType: "RoundPaymentOpened",
              payload: { groupId: round.groupId },
              availableAt: payBy,
            },
          });
          return { status: 200, body: formationResponse(paying, snapshotCount) };
        }
        return { status: 200, body: formationResponse(round, snapshotCount) };
      },
      now,
      { serializableAttempts: 5 },
    );
    return result.body;
  }

  private async requireEligibleUser(
    transaction: Transaction,
    principal: AuthenticatedUser,
    now: Date,
  ) {
    const user = await transaction.user.findFirst({
      where: {
        id: principal.userId,
        campusId: principal.campusId,
        status: AccountStatus.ACTIVE,
        deletedAt: null,
      },
      include: {
        verifications: {
          where: { status: VerificationStatus.VERIFIED, expiresAt: { gt: now } },
          orderBy: { reviewedAt: "desc" },
          take: 1,
        },
      },
    });
    if (user === null || user.verifications.length === 0) {
      throw new ApplicationError(
        "STUDENT_NOT_VERIFIED",
        "active student verification required",
        403,
      );
    }
    return user;
  }

  private async requireEligibleViewer(principal: AuthenticatedUser, now: Date): Promise<void> {
    const user = await this.prisma.user.findFirst({
      where: {
        id: principal.userId,
        campusId: principal.campusId,
        status: AccountStatus.ACTIVE,
        deletedAt: null,
        verifications: {
          some: { status: VerificationStatus.VERIFIED, expiresAt: { gt: now } },
        },
      },
      select: { id: true },
    });
    if (user === null) {
      throw new ApplicationError(
        "STUDENT_NOT_VERIFIED",
        "active student verification required",
        403,
      );
    }
  }

  private async requireEnabledRouteWindow(
    transaction: Transaction,
    campusId: string,
    routeId: string,
    windowStart: Date,
    windowEnd: Date,
    now: Date,
  ): Promise<void> {
    if (windowStart <= now || windowEnd <= windowStart) {
      throw invalidWindow();
    }
    const route = await transaction.route.findFirst({
      where: {
        id: routeId,
        campusId,
        status: CatalogStatus.ACTIVE,
        campus: { status: CatalogStatus.ACTIVE },
        origin: { status: CatalogStatus.ACTIVE },
        destination: { status: CatalogStatus.ACTIVE },
      },
      include: { campus: true, schedules: true },
    });
    if (route === null) throw resourceNotFound();
    const local = dateDetailsInZone(windowStart, route.campus.timezone);
    const valid = route.schedules.some((schedule) => {
      const activeFrom = schedule.activeFrom.toISOString().slice(0, 10);
      const activeUntil = schedule.activeUntil?.toISOString().slice(0, 10) ?? null;
      return (
        schedule.weekday === local.weekday &&
        activeFrom <= local.date &&
        (activeUntil === null || activeUntil >= local.date) &&
        matchesWindowRule(windowStart, windowEnd, route.campus.timezone, schedule)
      );
    });
    if (!valid) throw invalidWindow();
  }

  private async rejectOverlappingDemand(
    transaction: Transaction,
    userId: string,
    windowStart: Date,
    windowEnd: Date,
  ): Promise<void> {
    const overlap = await transaction.travelDemand.findFirst({
      where: {
        userId,
        status: { in: [DemandStatus.OPEN, DemandStatus.GROUPED] },
        windowStart: { lt: windowEnd },
        windowEnd: { gt: windowStart },
      },
      select: { id: true },
    });
    if (overlap !== null) {
      throw new ApplicationError(
        "OVERLAPPING_ACTIVE_GROUP",
        "user already has an overlapping active demand",
        409,
      );
    }
  }

  private async recomputeRecruitableGroup(
    transaction: Transaction,
    groupId: string,
  ): Promise<void> {
    const members = await transaction.groupMember.findMany({
      where: { groupId, status: { in: [...ACTIVE_MEMBER_STATUSES] } },
      include: { user: true, demand: true },
    });
    const summary = summarizeGroupingMembers(members.map(memberForRules));
    await transaction.companionGroup.update({
      where: { id: groupId },
      data: { state: summary.state, version: { increment: 1 } },
    });
  }

  private async readGroup(
    client: PrismaService | Transaction,
    campusId: string,
    groupId: string,
  ): Promise<GroupResponse> {
    const group = await client.companionGroup.findFirst({
      where: { id: groupId, campusId },
      include: groupViewInclude,
    });
    if (group === null) throw resourceNotFound();
    return mapGroup(group);
  }
}

const groupViewInclude = {
  members: {
    where: { status: { in: [...ACTIVE_MEMBER_STATUSES] } },
    orderBy: [{ joinedAt: "asc" as const }, { id: "asc" as const }],
  },
  rounds: {
    where: {
      state: {
        in: [
          RoundState.CONFIRMING,
          RoundState.PAYING,
          RoundState.REFUNDING,
          RoundState.REFUND_RETRY,
        ],
      },
    },
    orderBy: { sequence: "desc" as const },
    take: 1,
  },
} satisfies Prisma.CompanionGroupInclude;

const groupMembersForRulesInclude = {
  members: {
    where: { status: { in: [...ACTIVE_MEMBER_STATUSES] } },
    orderBy: [{ joinedAt: "asc" as const }, { id: "asc" as const }],
    include: {
      demand: true,
      user: {
        include: {
          verifications: {
            where: { status: VerificationStatus.VERIFIED },
            orderBy: { reviewedAt: "desc" as const },
            take: 1,
          },
        },
      },
    },
  },
} satisfies Prisma.CompanionGroupInclude;

function memberForRules(member: {
  readonly userId: string;
  readonly seatCount: number;
  readonly user: { readonly genderDeclaration: "MALE" | "FEMALE" | "UNDISCLOSED" };
  readonly demand: { readonly genderPreference: "ANY" | "SAME_GENDER_ONLY" };
}): GroupingMember {
  return {
    userId: member.userId,
    seatCount: member.seatCount,
    gender: member.user.genderDeclaration,
    preference: member.demand.genderPreference,
  };
}

function mapGroup(group: {
  readonly id: string;
  readonly campusId: string;
  readonly routeId: string;
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly state: string;
  readonly version: number;
  readonly members: readonly {
    readonly id: string;
    readonly seatCount: number;
    readonly joinedAt: Date;
  }[];
  readonly rounds: readonly { readonly id: string }[];
}): GroupResponse {
  const occupiedSeats = group.members.reduce((total, member) => total + member.seatCount, 0);
  return {
    id: group.id,
    campusId: group.campusId,
    routeId: group.routeId,
    windowStart: group.windowStart.toISOString(),
    windowEnd: group.windowEnd.toISOString(),
    state: group.state,
    accountCount: group.members.length,
    occupiedSeats,
    remainingSeats: 4 - occupiedSeats,
    members: group.members.map((member) => ({
      memberId: member.id,
      displayName: `同行成员-${sha256Hex(`${group.id}:${member.id}`).slice(0, 6)}`,
      seatCount: member.seatCount,
      verified: true,
      joinedAt: member.joinedAt.toISOString(),
    })),
    activeRoundId: group.rounds[0]?.id ?? null,
    version: group.version,
  };
}

function groupingSnapshotHash(
  members: readonly {
    readonly id: string;
    readonly userId: string;
    readonly demandId: string;
    readonly seatCount: number;
  }[],
): string {
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

function formationResponse(
  round: {
    readonly id: string;
    readonly groupId: string;
    readonly state: string;
    readonly memberSnapshotHash: string;
    readonly confirmBy: Date;
    readonly payBy: Date | null;
    readonly createdAt: Date;
    readonly contactPolicyVersion: { readonly version: string };
  },
  memberCount: number,
): FormationResponse {
  return {
    id: round.id,
    groupId: round.groupId,
    state: round.state,
    memberCount,
    memberSnapshotHash: round.memberSnapshotHash,
    contactPolicyVersion: round.contactPolicyVersion.version,
    confirmBy: round.confirmBy.toISOString(),
    payBy: round.payBy?.toISOString() ?? null,
    createdAt: round.createdAt.toISOString(),
  };
}

function demandResponse(
  demand: {
    readonly id: string;
    readonly routeId: string;
    readonly windowStart: Date;
    readonly windowEnd: Date;
    readonly seatCount: number;
    readonly status: string;
    readonly createdAt: Date;
  },
  groupId: string | null,
): DemandResponse {
  return {
    id: demand.id,
    routeId: demand.routeId,
    groupId,
    windowStart: demand.windowStart.toISOString(),
    windowEnd: demand.windowEnd.toISOString(),
    seatCount: demand.seatCount,
    status: demand.status,
    createdAt: demand.createdAt.toISOString(),
  };
}

function parseDateTime(value: string, field: string): Date {
  const date = new Date(value);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) ||
    !Number.isFinite(date.getTime())
  ) {
    throw new ApplicationError("VALIDATION_ERROR", "date-time is invalid", 400, {
      field,
      constraint: "date-time",
    });
  }
  return date;
}

function invalidWindow(): ApplicationError {
  return new ApplicationError("VALIDATION_ERROR", "route window is invalid", 400, {
    field: "windowStart",
    constraint: "enabled-route-window",
  });
}

function resourceNotFound(): ApplicationError {
  return new ApplicationError("RESOURCE_NOT_FOUND", "resource was not found", 404);
}

function stateConflict(message: string): ApplicationError {
  return new ApplicationError("GROUP_NOT_JOINABLE", message, 409);
}

function hasActiveVerification(
  verifications: readonly { readonly expiresAt: Date | null }[],
  now: Date,
): boolean {
  return verifications.some(
    (verification) => verification.expiresAt !== null && verification.expiresAt > now,
  );
}

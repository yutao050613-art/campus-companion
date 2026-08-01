import { randomInt } from "node:crypto";
import {
  DemandStatus,
  GroupState,
  MemberStatus,
  OutboxStatus,
  Prisma,
  type PrismaClient,
  RoundState,
} from "@campus/database";
import { summarizeGroupingMembers } from "@campus/domain";

const SWEEP_LIMIT = 50;
const SERIALIZABLE_ATTEMPTS = 3;
const ACTIVE_MEMBER_STATUSES = [
  MemberStatus.JOINED,
  MemberStatus.CONFIRMED,
  MemberStatus.PAYMENT_PENDING,
  MemberStatus.PAID,
  MemberStatus.CONTACT_UNLOCKED,
] as const;

export interface FormationDeadlineRepository {
  listDueConfirmationRoundIds(now: Date): Promise<readonly string[]>;
  invalidateConfirmationRound(roundId: string, now: Date): Promise<boolean>;
  listExpiredRecruitableGroupIds(now: Date): Promise<readonly string[]>;
  expireRecruitableGroup(groupId: string, now: Date): Promise<boolean>;
}

export interface FormationDeadlineSweepResult {
  readonly roundsInvalidated: number;
  readonly groupsExpired: number;
}

export class PrismaFormationDeadlineRepository implements FormationDeadlineRepository {
  public constructor(private readonly prisma: PrismaClient) {}

  public async listDueConfirmationRoundIds(now: Date): Promise<readonly string[]> {
    const rounds = await this.prisma.formationRound.findMany({
      where: { state: RoundState.CONFIRMING, confirmBy: { lte: now } },
      select: { id: true },
      orderBy: [{ confirmBy: "asc" }, { id: "asc" }],
      take: SWEEP_LIMIT,
    });
    return rounds.map((round) => round.id);
  }

  public invalidateConfirmationRound(roundId: string, now: Date): Promise<boolean> {
    return runSerializableWithRetry(this.prisma, async (transaction) => {
      const round = await transaction.formationRound.findUnique({
        where: { id: roundId },
        include: {
          group: {
            include: {
              members: {
                where: { status: { in: [...ACTIVE_MEMBER_STATUSES] } },
                include: { user: true, demand: true },
              },
            },
          },
        },
      });
      if (
        round === null ||
        round.state !== RoundState.CONFIRMING ||
        round.confirmBy > now ||
        round.group.state !== GroupState.CONFIRMING
      ) {
        return false;
      }

      const changed = await transaction.formationRound.updateMany({
        where: { id: round.id, state: RoundState.CONFIRMING, confirmBy: { lte: now } },
        data: {
          state: RoundState.INVALIDATED,
          invalidatedAt: now,
          invalidationReason: "CONFIRMATION_TIMEOUT",
        },
      });
      if (changed.count !== 1) return false;

      await transaction.groupMember.updateMany({
        where: { groupId: round.groupId, status: MemberStatus.CONFIRMED },
        data: { status: MemberStatus.JOINED },
      });
      await transaction.contactConsent.updateMany({
        where: { roundId: round.id, revokedAt: null },
        data: { revokedAt: now },
      });
      const summary = summarizeGroupingMembers(
        round.group.members.map((member) => ({
          userId: member.userId,
          seatCount: member.seatCount,
          gender: member.user.genderDeclaration,
          preference: member.demand.genderPreference,
        })),
      );
      await transaction.companionGroup.updateMany({
        where: { id: round.groupId, state: GroupState.CONFIRMING },
        data: { state: summary.state, version: { increment: 1 } },
      });
      await transaction.outboxEvent.updateMany({
        where: {
          aggregateId: round.id,
          eventType: "FormationConfirmationTimeout",
          status: { in: [OutboxStatus.PENDING, OutboxStatus.FAILED] },
        },
        data: {
          status: OutboxStatus.PUBLISHED,
          publishedAt: now,
          attempts: { increment: 1 },
          lastErrorCode: null,
        },
      });
      await transaction.outboxEvent.create({
        data: {
          campusId: round.campusId,
          aggregateType: "FormationRound",
          aggregateId: round.id,
          eventType: "FormationRoundInvalidated",
          payload: { reason: "CONFIRMATION_TIMEOUT", groupId: round.groupId },
        },
      });
      return true;
    });
  }

  public async listExpiredRecruitableGroupIds(now: Date): Promise<readonly string[]> {
    const groups = await this.prisma.companionGroup.findMany({
      where: {
        state: { in: [GroupState.RECRUITING, GroupState.READY] },
        windowEnd: { lte: now },
      },
      select: { id: true },
      orderBy: [{ windowEnd: "asc" }, { id: "asc" }],
      take: SWEEP_LIMIT,
    });
    return groups.map((group) => group.id);
  }

  public expireRecruitableGroup(groupId: string, now: Date): Promise<boolean> {
    return runSerializableWithRetry(this.prisma, async (transaction) => {
      const group = await transaction.companionGroup.findUnique({
        where: { id: groupId },
        include: {
          members: {
            where: { status: { in: [...ACTIVE_MEMBER_STATUSES] } },
            select: { id: true, demandId: true },
          },
        },
      });
      if (
        group === null ||
        (group.state !== GroupState.RECRUITING && group.state !== GroupState.READY) ||
        group.windowEnd > now
      ) {
        return false;
      }
      const changed = await transaction.companionGroup.updateMany({
        where: {
          id: group.id,
          state: { in: [GroupState.RECRUITING, GroupState.READY] },
          windowEnd: { lte: now },
        },
        data: { state: GroupState.EXPIRED, version: { increment: 1 } },
      });
      if (changed.count !== 1) return false;
      const demandIds = group.members.map((member) => member.demandId);
      await transaction.groupMember.updateMany({
        where: { id: { in: group.members.map((member) => member.id) } },
        data: { status: MemberStatus.REMOVED },
      });
      if (demandIds.length > 0) {
        await transaction.travelDemand.updateMany({
          where: {
            id: { in: demandIds },
            status: { in: [DemandStatus.OPEN, DemandStatus.GROUPED] },
          },
          data: { status: DemandStatus.EXPIRED },
        });
      }
      await transaction.outboxEvent.create({
        data: {
          campusId: group.campusId,
          aggregateType: "CompanionGroup",
          aggregateId: group.id,
          eventType: "GroupExpired",
          payload: { demandCount: demandIds.length },
        },
      });
      return true;
    });
  }
}

export async function runFormationDeadlineSweep(
  repository: FormationDeadlineRepository,
  now = new Date(),
): Promise<FormationDeadlineSweepResult> {
  let roundsInvalidated = 0;
  let groupsExpired = 0;
  for (const roundId of await repository.listDueConfirmationRoundIds(now)) {
    if (await repository.invalidateConfirmationRound(roundId, now)) roundsInvalidated += 1;
  }
  for (const groupId of await repository.listExpiredRecruitableGroupIds(now)) {
    if (await repository.expireRecruitableGroup(groupId, now)) groupsExpired += 1;
  }
  return { roundsInvalidated, groupsExpired };
}

async function runSerializableWithRetry<T>(
  prisma: PrismaClient,
  action: (transaction: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; attempt <= SERIALIZABLE_ATTEMPTS; attempt += 1) {
    try {
      return await prisma.$transaction(action, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      if (!isSerializationConflict(error) || attempt === SERIALIZABLE_ATTEMPTS) throw error;
      await boundedSerializationBackoff(attempt);
    }
  }
  throw new Error("serializable transaction retry invariant violated");
}

async function boundedSerializationBackoff(attempt: number): Promise<void> {
  const baseDelayMs = 10 * 2 ** (attempt - 1);
  const delayMs = baseDelayMs + randomInt(0, baseDelayMs + 1);
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

function isSerializationConflict(error: unknown): boolean {
  return (
    (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") ||
    (error instanceof Prisma.PrismaClientUnknownRequestError &&
      /\b(?:40P01|40001)\b/u.test(error.message))
  );
}

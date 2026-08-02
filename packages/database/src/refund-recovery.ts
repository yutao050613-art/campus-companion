import {
  GroupState,
  MemberStatus,
  OrderStatus,
  type Prisma,
  RoundState,
} from "../generated/client";

export type RefundRecoveryOutcome = "NOOP" | "PENDING" | "REVIEW_REQUIRED" | "RECOVERED";

/**
 * Recovers a group only after every paid account in a compensating formation
 * round has a terminal refund result. Both the mock-refund worker and verified
 * WeChat callbacks use this one transaction-local state machine.
 */
export async function recoverRefundedFormationRound(
  transaction: Prisma.TransactionClient,
  roundId: string,
  now: Date,
): Promise<RefundRecoveryOutcome> {
  const round = await transaction.formationRound.findUnique({
    where: { id: roundId },
    include: {
      group: {
        include: {
          members: {
            where: { status: MemberStatus.PAID },
            select: { id: true, seatCount: true },
          },
        },
      },
      orders: { select: { status: true } },
    },
  });
  if (
    round === null ||
    round.state !== RoundState.REFUNDING ||
    round.group.state !== GroupState.REFUNDING
  ) {
    return "NOOP";
  }
  if (round.orders.some((order) => order.status === OrderStatus.REFUND_PENDING)) return "PENDING";
  if (round.orders.some((order) => order.status === OrderStatus.REFUND_FAILED)) {
    await markFormationRoundForManualRefundReview(transaction, round.id);
    return "REVIEW_REQUIRED";
  }
  if (round.orders.some((order) => order.status === OrderStatus.PAID)) return "PENDING";

  const remaining = round.group.members;
  const occupiedSeats = remaining.reduce((total, member) => total + member.seatCount, 0);
  if (occupiedSeats > 4) throw new Error("compensated group exceeds M3 capacity");
  const recoveredState =
    remaining.length === 0
      ? GroupState.EXPIRED
      : remaining.length === 1
        ? GroupState.RECRUITING
        : GroupState.READY;
  if (remaining.length > 0) {
    await transaction.groupMember.updateMany({
      where: { id: { in: remaining.map((member) => member.id) }, status: MemberStatus.PAID },
      data: { status: MemberStatus.JOINED },
    });
  }
  await transaction.formationRound.update({
    where: { id: round.id },
    data: { state: RoundState.INVALIDATED, invalidatedAt: now },
  });
  await transaction.companionGroup.update({
    where: { id: round.groupId, state: GroupState.REFUNDING },
    data: { state: recoveredState, version: { increment: 1 } },
  });
  await transaction.outboxEvent.create({
    data: {
      campusId: round.campusId,
      aggregateType: "FormationRound",
      aggregateId: round.id,
      eventType: "RoundRefundedAndRecovered",
      payload: { remainingAccountCount: remaining.length, occupiedSeats },
    },
  });
  return "RECOVERED";
}

export async function markFormationRoundForManualRefundReview(
  transaction: Prisma.TransactionClient,
  roundId: string,
): Promise<void> {
  const round = await transaction.formationRound.findUnique({ where: { id: roundId } });
  if (round === null) return;
  await transaction.formationRound.updateMany({
    where: { id: round.id, state: { in: [RoundState.REFUNDING, RoundState.REFUND_RETRY] } },
    data: { state: RoundState.REFUND_RETRY },
  });
  await transaction.companionGroup.updateMany({
    where: { id: round.groupId, state: { in: [GroupState.REFUNDING, GroupState.REFUND_RETRY] } },
    data: { state: GroupState.REFUND_RETRY, version: { increment: 1 } },
  });
}

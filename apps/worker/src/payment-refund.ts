import { randomInt } from "node:crypto";
import {
  DemandStatus,
  GroupState,
  MemberStatus,
  markFormationRoundForManualRefundReview,
  OrderStatus,
  PaymentProvider,
  PaymentStatus,
  Prisma,
  type PrismaClient,
  RefundReason,
  RefundStatus,
  RoundState,
  recoverRefundedFormationRound,
} from "@campus/database";
import { MockPaymentGateway, type MockRefundSettlement } from "@campus/payments";

const SWEEP_LIMIT = 50;
const SERIALIZABLE_ATTEMPTS = 3;
const PAYING_MEMBER_STATES = [MemberStatus.PAYMENT_PENDING, MemberStatus.PAID] as const;

interface RefundGateway {
  refund(providerTransactionId: string, now?: Date): MockRefundSettlement;
}

export interface PaymentRefundRepository {
  listDuePaymentRoundIds(now: Date): Promise<readonly string[]>;
  invalidatePaymentRound(roundId: string, now: Date): Promise<boolean>;
  listRequestedRefundIds(): Promise<readonly string[]>;
  settleRefund(refundId: string, now: Date): Promise<boolean>;
}

export interface PaymentRefundSweepResult {
  readonly roundsInvalidated: number;
  readonly refundsSettled: number;
}

/**
 * Owns payment-expiry compensation only.  It never calls an external provider
 * in the transaction that changes group state: first a durable refund intent is
 * created, then the small mock-provider side effect is claimed and reconciled.
 */
export class PrismaPaymentRefundRepository implements PaymentRefundRepository {
  private readonly gateway: RefundGateway;

  public constructor(
    private readonly prisma: PrismaClient,
    environment: "development" | "test" | "staging" | "production",
    gateway?: RefundGateway,
  ) {
    // Constructing the default adapter first retains its strict environment guard
    // even when a failure-injection adapter is supplied by a test.
    const defaultGateway = new MockPaymentGateway(environment);
    this.gateway = gateway ?? defaultGateway;
  }

  public async listDuePaymentRoundIds(now: Date): Promise<readonly string[]> {
    const rounds = await this.prisma.formationRound.findMany({
      where: { state: RoundState.PAYING, payBy: { lte: now } },
      select: { id: true },
      orderBy: [{ payBy: "asc" }, { id: "asc" }],
      take: SWEEP_LIMIT,
    });
    return rounds.map((round) => round.id);
  }

  public invalidatePaymentRound(roundId: string, now: Date): Promise<boolean> {
    return runSerializableWithRetry(this.prisma, async (transaction) => {
      const round = await transaction.formationRound.findUnique({
        where: { id: roundId },
        include: {
          group: {
            include: {
              members: {
                where: { status: { in: [...PAYING_MEMBER_STATES] } },
                select: { id: true, userId: true, demandId: true, status: true },
              },
            },
          },
          orders: { select: { id: true, status: true, amountFen: true } },
        },
      });
      if (
        round === null ||
        round.state !== RoundState.PAYING ||
        round.payBy === null ||
        round.payBy > now ||
        round.group.state !== GroupState.PAYING
      ) {
        return false;
      }

      const transition = await transaction.formationRound.updateMany({
        where: { id: round.id, state: RoundState.PAYING, payBy: { lte: now } },
        data: { state: RoundState.REFUNDING, invalidationReason: "PAYMENT_TIMEOUT" },
      });
      if (transition.count !== 1) return false;
      await transaction.companionGroup.updateMany({
        where: { id: round.groupId, state: GroupState.PAYING },
        data: { state: GroupState.REFUNDING, version: { increment: 1 } },
      });

      const unpaid = round.group.members.filter(
        (member) => member.status === MemberStatus.PAYMENT_PENDING,
      );
      if (unpaid.length > 0) {
        await transaction.groupMember.updateMany({
          where: {
            id: { in: unpaid.map((member) => member.id) },
            status: MemberStatus.PAYMENT_PENDING,
          },
          data: { status: MemberStatus.PAYMENT_TIMEOUT },
        });
        await transaction.travelDemand.updateMany({
          where: {
            id: { in: unpaid.map((member) => member.demandId) },
            status: DemandStatus.GROUPED,
          },
          data: { status: DemandStatus.OPEN },
        });
      }
      await transaction.serviceOrder.updateMany({
        where: { roundId: round.id, status: { in: [OrderStatus.CREATED, OrderStatus.PAYING] } },
        data: { status: OrderStatus.CLOSED },
      });

      for (const order of round.orders.filter(
        (candidate) => candidate.status === OrderStatus.PAID,
      )) {
        if (order.amountFen !== 99) throw new Error("invalid M4 order amount during compensation");
        await transaction.serviceOrder.update({
          where: { id: order.id },
          data: { status: OrderStatus.REFUND_PENDING },
        });
        await transaction.refund.upsert({
          where: { orderId_reason: { orderId: order.id, reason: RefundReason.ROUND_INVALIDATED } },
          create: {
            campusId: round.campusId,
            orderId: order.id,
            amountFen: 99,
            reason: RefundReason.ROUND_INVALIDATED,
            status: RefundStatus.REQUESTED,
          },
          update: {},
        });
      }
      await transaction.contactConsent.updateMany({
        where: { roundId: round.id, revokedAt: null },
        data: { revokedAt: now },
      });
      await transaction.outboxEvent.create({
        data: {
          campusId: round.campusId,
          aggregateType: "FormationRound",
          aggregateId: round.id,
          eventType: "PaymentDeadlineExpired",
          payload: { unpaidAccountCount: unpaid.length },
        },
      });
      return true;
    });
  }

  public async listRequestedRefundIds(): Promise<readonly string[]> {
    const refunds = await this.prisma.refund.findMany({
      where: { status: RefundStatus.REQUESTED },
      select: { id: true },
      orderBy: [{ requestedAt: "asc" }, { id: "asc" }],
      take: SWEEP_LIMIT,
    });
    return refunds.map((refund) => refund.id);
  }

  public async settleRefund(refundId: string, now: Date): Promise<boolean> {
    const claim = await runSerializableWithRetry(this.prisma, async (transaction) => {
      const claimed = await transaction.refund.updateMany({
        where: { id: refundId, status: RefundStatus.REQUESTED },
        data: { status: RefundStatus.REFUND_PENDING },
      });
      if (claimed.count !== 1) return null;
      const refund = await transaction.refund.findUnique({
        where: { id: refundId },
        include: {
          order: {
            include: {
              round: { select: { id: true, groupId: true } },
              transactions: {
                where: { provider: PaymentProvider.MOCK, status: PaymentStatus.SUCCEEDED },
                orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
                take: 1,
              },
            },
          },
        },
      });
      if (
        refund === null ||
        refund.amountFen !== 99 ||
        refund.order.status !== OrderStatus.REFUND_PENDING ||
        refund.order.transactions[0]?.providerTransactionId === null ||
        refund.order.transactions[0] === undefined
      ) {
        await transaction.refund.updateMany({
          where: { id: refundId, status: RefundStatus.REFUND_PENDING },
          data: { status: RefundStatus.REVIEW_REQUIRED },
        });
        if (refund !== null)
          await markFormationRoundForManualRefundReview(transaction, refund.order.round.id);
        return null;
      }
      return {
        providerTransactionId: refund.order.transactions[0].providerTransactionId,
        roundId: refund.order.round.id,
      };
    });
    if (claim === null) return false;

    let settlement: MockRefundSettlement;
    try {
      settlement = this.gateway.refund(claim.providerTransactionId, now);
    } catch (error) {
      await runSerializableWithRetry(this.prisma, async (transaction) => {
        const restored = await transaction.refund.updateMany({
          where: { id: refundId, status: RefundStatus.REFUND_PENDING },
          data: { status: RefundStatus.REQUESTED },
        });
        if (restored.count === 1) {
          await transaction.outboxEvent.create({
            data: {
              campusId: await campusIdForRound(transaction, claim.roundId),
              aggregateType: "Refund",
              aggregateId: refundId,
              eventType: "MockRefundRetryScheduled",
              payload: { reason: error instanceof Error ? error.name : "UNKNOWN" },
              availableAt: new Date(now.getTime() + 30_000),
            },
          });
        }
      });
      return false;
    }

    return runSerializableWithRetry(this.prisma, async (transaction) => {
      const updated = await transaction.refund.updateMany({
        where: { id: refundId, status: RefundStatus.REFUND_PENDING },
        data: {
          status: RefundStatus.REFUNDED,
          providerRefundId: settlement.providerRefundId,
          completedAt: settlement.completedAt,
        },
      });
      if (updated.count !== 1) return false;
      const refund = await transaction.refund.findUnique({
        where: { id: refundId },
        include: { order: { include: { round: true } } },
      });
      if (refund === null) throw new Error("claimed refund disappeared");
      await transaction.serviceOrder.updateMany({
        where: { id: refund.orderId, status: OrderStatus.REFUND_PENDING },
        data: { status: OrderStatus.REFUNDED },
      });
      await recoverRefundedFormationRound(transaction, refund.order.round.id, now);
      return true;
    });
  }
}

export async function runPaymentRefundSweep(
  repository: PaymentRefundRepository,
  now = new Date(),
): Promise<PaymentRefundSweepResult> {
  let roundsInvalidated = 0;
  let refundsSettled = 0;
  for (const roundId of await repository.listDuePaymentRoundIds(now)) {
    if (await repository.invalidatePaymentRound(roundId, now)) roundsInvalidated += 1;
  }
  for (const refundId of await repository.listRequestedRefundIds()) {
    if (await repository.settleRefund(refundId, now)) refundsSettled += 1;
  }
  return { roundsInvalidated, refundsSettled };
}

async function campusIdForRound(
  transaction: Prisma.TransactionClient,
  roundId: string,
): Promise<string> {
  const round = await transaction.formationRound.findUnique({
    where: { id: roundId },
    select: { campusId: true },
  });
  if (round === null) throw new Error("round unavailable while recording refund retry");
  return round.campusId;
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
      const baseDelayMs = 10 * 2 ** (attempt - 1);
      await new Promise<void>((resolve) =>
        setTimeout(resolve, baseDelayMs + randomInt(0, baseDelayMs + 1)),
      );
    }
  }
  throw new Error("serializable transaction retry invariant violated");
}

function isSerializationConflict(error: unknown): boolean {
  return (
    (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") ||
    (error instanceof Prisma.PrismaClientUnknownRequestError &&
      /\b(?:40P01|40001)\b/u.test(error.message))
  );
}

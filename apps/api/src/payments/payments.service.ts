import { randomInt, randomUUID } from "node:crypto";
import { type AesGcmProtector, sha256Hex } from "@campus/auth";
import {
  AccountStatus,
  DemandStatus,
  GroupState,
  MemberStatus,
  OrderStatus,
  PaymentProvider,
  PaymentStatus,
  Prisma,
  ProviderEventStatus,
  ReconciliationStatus,
  RefundReason,
  RefundStatus,
  RoundState,
  recoverRefundedFormationRound,
  VerificationStatus,
} from "@campus/database";
import { MockPaymentGateway } from "@campus/payments";
import { Inject, Injectable } from "@nestjs/common";
import type { AuthenticatedUser } from "../auth/auth.service";
import { ApplicationError } from "../common/application-error";
import { APP_CONFIG, type AppConfig } from "../config";
import { PrismaService } from "../database/prisma.service";
import { IdempotencyService } from "../m2/idempotency.service";
import { DATA_PROTECTOR } from "../m2/providers";

const PRICE_FEN = 99;
const PRICING_VERSION = "m4-99-fen-v1";
const ACTIVE_MEMBER_STATES = [MemberStatus.PAYMENT_PENDING, MemberStatus.PAID] as const;
const PAYABLE_ORDER_STATES: readonly OrderStatus[] = [OrderStatus.CREATED, OrderStatus.PAYING];
const REFUNDABLE_ORDER_STATES: readonly OrderStatus[] = [
  OrderStatus.PAID,
  OrderStatus.DELIVERED,
  OrderStatus.REFUND_PENDING,
];
const CALLBACK_REFUND_STATES: readonly RefundStatus[] = [
  RefundStatus.REQUESTED,
  RefundStatus.REFUND_PENDING,
];
type Transaction = Prisma.TransactionClient;

export interface ServiceOrderResponse {
  readonly id: string;
  readonly groupId: string;
  readonly roundId: string;
  readonly amountFen: 99;
  readonly currency: "CNY";
  readonly status: string;
  readonly expiresAt: string;
}

export interface PrepayResponse {
  readonly provider: "MOCK";
  readonly intentId: string;
  readonly amountFen: 99;
  readonly expiresAt: string;
}

export interface RefundResponse {
  readonly id: string;
  readonly orderId: string;
  readonly amountFen: 99;
  readonly reason: string;
  readonly status: string;
}

export interface UnlockedContactResponse {
  readonly label: string;
  readonly wechatId: string;
}

/**
 * This is the post-verification boundary: callers may construct it only after
 * API v3 signature verification, encrypted-resource decryption and strict
 * provider schema validation. It contains no raw callback body or key data.
 */
export interface VerifiedWechatPaymentEventInput {
  readonly eventId: string;
  readonly eventType: "TRANSACTION.SUCCESS";
  readonly verifierKeyId: string;
  readonly rawDigest: string;
  readonly merchantOrderNo: string;
  readonly providerTransactionId: string;
  readonly amountFen: number;
  readonly currency: "CNY";
  readonly occurredAt: Date;
}

export interface VerifiedWechatRefundEventInput {
  readonly eventId: string;
  readonly eventType: "REFUND.SUCCESS";
  readonly verifierKeyId: string;
  readonly rawDigest: string;
  readonly merchantOrderNo: string;
  readonly merchantRefundNo: string;
  readonly providerRefundId: string;
  readonly amountFen: number;
  readonly currency: "CNY";
  readonly occurredAt: Date;
}

export interface WechatProviderEventReceipt {
  readonly providerEventId: string;
  readonly status: "RECEIVED" | "APPLIED" | "REVIEW_REQUIRED" | "REJECTED";
}

@Injectable()
export class PaymentsService {
  private readonly gateway: MockPaymentGateway;

  public constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
    @Inject(DATA_PROTECTOR) private readonly protector: AesGcmProtector,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.gateway = new MockPaymentGateway(config.nodeEnv);
  }

  public async setMyWechatContact(
    principal: AuthenticatedUser,
    wechatId: string,
    idempotencyKey: string,
    now = new Date(),
  ): Promise<{ readonly hasWechatContact: true }> {
    const normalized = normalizeWechatId(wechatId);
    const result = await this.idempotency.execute(
      "setWechatContact",
      idempotencyKey,
      principal,
      { wechatId: normalized },
      async (transaction) => {
        await requireEligibleUser(transaction, principal, now);
        const encrypted = this.protector.encrypt(normalized);
        await transaction.userContact.upsert({
          where: { userId: principal.userId },
          create: {
            campusId: principal.campusId,
            userId: principal.userId,
            wechatIdCiphertext: Uint8Array.from(encrypted.ciphertext),
            keyVersion: encrypted.keyVersion,
            valueDigest: sha256Hex(normalized),
          },
          update: {
            wechatIdCiphertext: Uint8Array.from(encrypted.ciphertext),
            keyVersion: encrypted.keyVersion,
            valueDigest: sha256Hex(normalized),
          },
        });
        return { status: 200, body: { hasWechatContact: true as const } };
      },
      now,
    );
    return result.body;
  }

  public async createOrder(
    principal: AuthenticatedUser,
    groupId: string,
    roundId: string,
    idempotencyKey: string,
    now = new Date(),
  ): Promise<ServiceOrderResponse> {
    const result = await this.idempotency.execute(
      "createServiceOrder",
      idempotencyKey,
      principal,
      { groupId, roundId },
      async (transaction) => {
        const state = await this.requirePayingMember(transaction, principal, groupId, roundId, now);
        const existing = await transaction.serviceOrder.findUnique({
          where: { roundId_userId: { roundId, userId: principal.userId } },
          include: { round: true },
        });
        if (existing !== null) return { status: 200, body: orderResponse(existing, groupId) };
        const order = await transaction.serviceOrder.create({
          data: {
            campusId: principal.campusId,
            roundId,
            userId: principal.userId,
            merchantOrderNo: `m4_${randomUUID().replaceAll("-", "")}`,
            amountFen: PRICE_FEN,
            currency: "CNY",
            pricingVersion: PRICING_VERSION,
            expiresAt: state.payBy,
          },
        });
        await transaction.outboxEvent.create({
          data: {
            campusId: principal.campusId,
            aggregateType: "ServiceOrder",
            aggregateId: order.id,
            eventType: "ServiceOrderCreated",
            payload: { roundId },
          },
        });
        return { status: 201, body: orderResponse(order, groupId) };
      },
      now,
      { serializableAttempts: 5 },
    );
    return result.body;
  }

  public async getOrder(
    principal: AuthenticatedUser,
    orderId: string,
  ): Promise<ServiceOrderResponse> {
    const order = await this.prisma.serviceOrder.findFirst({
      where: { id: orderId, campusId: principal.campusId, userId: principal.userId },
      include: { round: { select: { groupId: true } } },
    });
    if (order === null) throw resourceNotFound();
    return orderResponse(order, order.round.groupId);
  }

  public async createPrepay(
    principal: AuthenticatedUser,
    orderId: string,
    idempotencyKey: string,
    now = new Date(),
  ): Promise<PrepayResponse> {
    const result = await this.idempotency.execute(
      "createMockPrepay",
      idempotencyKey,
      principal,
      { orderId },
      async (transaction) => {
        const order = await transaction.serviceOrder.findFirst({
          where: { id: orderId, campusId: principal.campusId, userId: principal.userId },
          include: { round: { include: { group: true } } },
        });
        if (order === null) throw resourceNotFound();
        if (
          order.round.state !== RoundState.PAYING ||
          order.round.group.state !== GroupState.PAYING ||
          order.expiresAt <= now ||
          !PAYABLE_ORDER_STATES.includes(order.status)
        ) {
          throw paymentConflict("order is not payable");
        }
        const prepay = this.gateway.createPrepay({
          orderId: order.id,
          merchantOrderNo: order.merchantOrderNo,
          amountFen: order.amountFen,
          expiresAt: order.expiresAt,
        });
        await transaction.paymentTransaction.upsert({
          where: { providerTransactionId: prepay.intentId },
          create: {
            campusId: principal.campusId,
            orderId: order.id,
            provider: PaymentProvider.MOCK,
            providerTransactionId: prepay.intentId,
            status: PaymentStatus.PENDING,
            rawDigest: sha256Hex(`m4:prepay:${prepay.intentId}`),
          },
          update: {},
        });
        await transaction.serviceOrder.updateMany({
          where: { id: order.id, status: OrderStatus.CREATED },
          data: { status: OrderStatus.PAYING },
        });
        return { status: 200, body: prepay };
      },
      now,
      { serializableAttempts: 5 },
    );
    return result.body;
  }

  public async completeMockPayment(
    principal: AuthenticatedUser,
    orderId: string,
    intentId: string,
    idempotencyKey: string,
    now = new Date(),
  ): Promise<ServiceOrderResponse> {
    const result = await this.idempotency.execute(
      "completeMockPayment",
      idempotencyKey,
      principal,
      { orderId, intentId },
      async (transaction) => {
        const order = await transaction.serviceOrder.findFirst({
          where: { id: orderId, campusId: principal.campusId, userId: principal.userId },
          include: { round: { include: { group: true } } },
        });
        if (order === null) throw resourceNotFound();
        if (intentId !== this.gateway.intentFor(order.merchantOrderNo)) {
          throw resourceNotFound();
        }
        if (order.status === OrderStatus.DELIVERED || order.status === OrderStatus.PAID) {
          return { status: 200, body: orderResponse(order, order.round.groupId) };
        }
        if (
          order.round.state !== RoundState.PAYING ||
          order.round.group.state !== GroupState.PAYING ||
          order.expiresAt <= now ||
          !PAYABLE_ORDER_STATES.includes(order.status)
        ) {
          throw paymentConflict("order is not payable");
        }
        const settlement = this.gateway.settle(intentId, now);
        await transaction.paymentTransaction.upsert({
          where: { providerTransactionId: settlement.providerTransactionId },
          create: {
            campusId: principal.campusId,
            orderId: order.id,
            provider: PaymentProvider.MOCK,
            providerTransactionId: settlement.providerTransactionId,
            status: PaymentStatus.SUCCEEDED,
            rawDigest: settlement.rawDigest,
            occurredAt: settlement.occurredAt,
          },
          update: {},
        });
        const paid = await transaction.serviceOrder.updateMany({
          where: { id: order.id, status: { in: [OrderStatus.CREATED, OrderStatus.PAYING] } },
          data: { status: OrderStatus.PAID },
        });
        if (paid.count === 1) {
          await transaction.groupMember.updateMany({
            where: {
              groupId: order.round.groupId,
              userId: principal.userId,
              status: MemberStatus.PAYMENT_PENDING,
            },
            data: { status: MemberStatus.PAID },
          });
        }
        await this.deliverIfComplete(transaction, order.round.id, now);
        const current = await transaction.serviceOrder.findUnique({ where: { id: order.id } });
        if (current === null) throw resourceNotFound();
        return { status: 200, body: orderResponse(current, order.round.groupId) };
      },
      now,
      { serializableAttempts: 5 },
    );
    return result.body;
  }

  /**
   * Commits the signed external fact before any internal payment-state change.
   * A second, separately committed apply call is required to reach PAID or
   * contact delivery. This boundary makes replay and crash recovery explicit.
   */
  public async ingestVerifiedWechatPaymentEvent(
    input: VerifiedWechatPaymentEventInput,
  ): Promise<WechatProviderEventReceipt> {
    assertVerifiedWechatPaymentEvent(input);
    const existing = await this.prisma.providerEvent.findUnique({
      where: {
        provider_eventId: { provider: PaymentProvider.WECHAT_PAY, eventId: input.eventId },
      },
    });
    if (existing !== null) {
      if (existing.rawDigest !== input.rawDigest) {
        await this.recordProviderEventDigestConflict(existing, input.rawDigest);
        return { providerEventId: existing.id, status: "REVIEW_REQUIRED" };
      }
      return { providerEventId: existing.id, status: existing.status };
    }

    const order = await this.prisma.serviceOrder.findUnique({
      where: { merchantOrderNo: input.merchantOrderNo },
      select: { id: true, campusId: true, amountFen: true, currency: true },
    });
    const canBindOrder =
      order !== null && order.amountFen === input.amountFen && order.currency === input.currency;
    try {
      const event = await this.prisma.providerEvent.create({
        data: {
          provider: PaymentProvider.WECHAT_PAY,
          eventId: input.eventId,
          eventType: input.eventType,
          verifierKeyId: input.verifierKeyId,
          rawDigest: input.rawDigest,
          merchantOrderNo: input.merchantOrderNo,
          providerTransactionId: input.providerTransactionId,
          amountFen: input.amountFen,
          currency: input.currency,
          occurredAt: input.occurredAt,
          ...(order === null ? {} : { campusId: order.campusId }),
          ...(canBindOrder ? { orderId: order.id } : {}),
        },
      });
      return { providerEventId: event.id, status: event.status };
    } catch (error) {
      if (!isUniqueProviderEventConflict(error)) throw error;
      const replay = await this.prisma.providerEvent.findUnique({
        where: {
          provider_eventId: { provider: PaymentProvider.WECHAT_PAY, eventId: input.eventId },
        },
      });
      if (replay === null) throw error;
      if (replay.rawDigest !== input.rawDigest) {
        await this.recordProviderEventDigestConflict(replay, input.rawDigest);
        return { providerEventId: replay.id, status: "REVIEW_REQUIRED" };
      }
      return { providerEventId: replay.id, status: replay.status };
    }
  }

  /**
   * Applies an already-persisted payment event. It deliberately refuses to
   * apply unbound, duplicate, late, amount-mismatched or non-PAYING events;
   * those facts remain durable but require reconciliation.
   */
  public async applyVerifiedWechatPaymentEvent(
    providerEventId: string,
    now = new Date(),
  ): Promise<WechatProviderEventReceipt> {
    try {
      return await runSerializableWithRetry(this.prisma, async (transaction) => {
        const event = await transaction.providerEvent.findUnique({
          where: { id: providerEventId },
          include: {
            order: {
              include: {
                round: { include: { group: true } },
              },
            },
          },
        });
        if (event === null) throw resourceNotFound();
        if (event.status !== ProviderEventStatus.RECEIVED) {
          return { providerEventId: event.id, status: event.status };
        }
        if (event.merchantRefundNo !== null || event.eventType !== "TRANSACTION.SUCCESS") {
          return markWechatEventForReview(transaction, event, "UNSUPPORTED_PROVIDER_EVENT");
        }
        const order = event.order;
        if (order === null) {
          const candidate = await transaction.serviceOrder.findUnique({
            where: { merchantOrderNo: event.merchantOrderNo ?? "" },
            select: { id: true, campusId: true },
          });
          return markWechatEventForReview(
            transaction,
            event,
            candidate === null ? "UNKNOWN_MERCHANT_ORDER" : "PROVIDER_AMOUNT_MISMATCH",
            candidate ?? undefined,
          );
        }
        if (
          event.amountFen !== order.amountFen ||
          event.currency !== order.currency ||
          event.providerTransactionId === null
        ) {
          return markWechatEventForReview(transaction, event, "PROVIDER_PAYMENT_FACT_MISMATCH", {
            id: order.id,
            campusId: order.campusId,
          });
        }
        if (
          order.round.state !== RoundState.PAYING ||
          order.round.group.state !== GroupState.PAYING ||
          order.expiresAt <= now ||
          !PAYABLE_ORDER_STATES.includes(order.status)
        ) {
          return markWechatEventForReview(transaction, event, "UNEXPECTED_PAYMENT_ORDER_STATE", {
            id: order.id,
            campusId: order.campusId,
          });
        }
        const priorSuccess = await transaction.paymentTransaction.findFirst({
          where: {
            campusId: order.campusId,
            orderId: order.id,
            provider: PaymentProvider.WECHAT_PAY,
            status: PaymentStatus.SUCCEEDED,
          },
          select: { id: true },
        });
        if (priorSuccess !== null) {
          return markWechatEventForReview(transaction, event, "DUPLICATE_PROVIDER_TRANSACTION", {
            id: order.id,
            campusId: order.campusId,
          });
        }
        const membership = await transaction.groupMember.findFirst({
          where: {
            campusId: order.campusId,
            groupId: order.round.groupId,
            userId: order.userId,
            status: MemberStatus.PAYMENT_PENDING,
          },
          select: { id: true },
        });
        if (membership === null) {
          return markWechatEventForReview(transaction, event, "PAYMENT_MEMBER_STATE_MISMATCH", {
            id: order.id,
            campusId: order.campusId,
          });
        }

        await transaction.paymentTransaction.create({
          data: {
            campusId: order.campusId,
            orderId: order.id,
            provider: PaymentProvider.WECHAT_PAY,
            providerTransactionId: event.providerTransactionId,
            providerEventId: event.id,
            status: PaymentStatus.SUCCEEDED,
            rawDigest: event.rawDigest,
            occurredAt: event.occurredAt ?? now,
          },
        });
        const paid = await transaction.serviceOrder.updateMany({
          where: { id: order.id, status: { in: [OrderStatus.CREATED, OrderStatus.PAYING] } },
          data: { status: OrderStatus.PAID },
        });
        if (paid.count !== 1) {
          return markWechatEventForReview(
            transaction,
            event,
            "PAYMENT_ORDER_CONCURRENTLY_CHANGED",
            {
              id: order.id,
              campusId: order.campusId,
            },
          );
        }
        await transaction.groupMember.update({
          where: { id: membership.id },
          data: { status: MemberStatus.PAID },
        });
        await this.deliverIfComplete(transaction, order.round.id, now);
        await transaction.providerEvent.update({
          where: { id: event.id },
          data: { status: ProviderEventStatus.APPLIED, appliedAt: now },
        });
        await transaction.outboxEvent.create({
          data: {
            campusId: order.campusId,
            aggregateType: "ProviderEvent",
            aggregateId: event.id,
            eventType: "WechatPaymentEventApplied",
            payload: { serviceOrderId: order.id },
          },
        });
        return { providerEventId: event.id, status: "APPLIED" };
      });
    } catch (error) {
      // Two delivery workers can both observe RECEIVED before either one writes
      // the terminal transaction. The unique transaction and event IDs are
      // the durable last line of defence. A conflict must be re-read outside the aborted
      // transaction: it is an idempotent replay only when this exact event is
      // already terminal; any other claim of the provider transaction is held
      // for reconciliation.
      if (!isUniquePaymentTransactionReplayConflict(error)) throw error;
      return this.resolveWechatPaymentTransactionConflict(providerEventId);
    }
  }

  private async resolveWechatPaymentTransactionConflict(
    providerEventId: string,
  ): Promise<WechatProviderEventReceipt> {
    return runSerializableWithRetry(this.prisma, async (transaction) => {
      const event = await transaction.providerEvent.findUnique({ where: { id: providerEventId } });
      if (event === null) throw resourceNotFound();
      if (event.status !== ProviderEventStatus.RECEIVED) {
        return { providerEventId: event.id, status: event.status };
      }

      const conflictingTransaction = await transaction.paymentTransaction.findUnique({
        where: { providerTransactionId: event.providerTransactionId ?? "" },
        select: {
          campusId: true,
          orderId: true,
          provider: true,
          providerEventId: true,
          status: true,
        },
      });
      if (
        conflictingTransaction !== null &&
        conflictingTransaction.provider === PaymentProvider.WECHAT_PAY &&
        conflictingTransaction.providerEventId === event.id &&
        conflictingTransaction.orderId === event.orderId &&
        conflictingTransaction.campusId === event.campusId &&
        conflictingTransaction.status === PaymentStatus.SUCCEEDED
      ) {
        // A committed payment transaction without a terminal provider event is
        // internally inconsistent. Do not infer contact delivery from it.
        return markWechatEventForReview(transaction, event, "PAYMENT_EVENT_STATE_MISMATCH");
      }
      return markWechatEventForReview(transaction, event, "DUPLICATE_PROVIDER_TRANSACTION");
    });
  }

  public async requestRefund(
    principal: AuthenticatedUser,
    orderId: string,
    reason: RefundReason,
    idempotencyKey: string,
    now = new Date(),
  ): Promise<RefundResponse> {
    const result = await this.idempotency.execute(
      "requestRefund",
      idempotencyKey,
      principal,
      { orderId, reason },
      async (transaction) => {
        const order = await transaction.serviceOrder.findFirst({
          where: { id: orderId, campusId: principal.campusId, userId: principal.userId },
          include: {
            round: true,
            transactions: {
              where: { status: PaymentStatus.SUCCEEDED },
              select: { id: true },
            },
          },
        });
        if (order === null) throw resourceNotFound();
        if (!REFUNDABLE_ORDER_STATES.includes(order.status)) {
          throw new ApplicationError("REFUND_NOT_ELIGIBLE", "order is not refundable", 409);
        }
        const eligibleForAutomaticRequest =
          (reason === RefundReason.PLATFORM_NOT_DELIVERED &&
            order.status === OrderStatus.PAID &&
            order.round.state !== RoundState.DELIVERED) ||
          (reason === RefundReason.DUPLICATE_CHARGE && order.transactions.length > 1);
        const refund = await transaction.refund.upsert({
          where: { orderId_reason: { orderId: order.id, reason } },
          create: {
            campusId: order.campusId,
            orderId: order.id,
            amountFen: PRICE_FEN,
            reason,
            status: eligibleForAutomaticRequest
              ? RefundStatus.REQUESTED
              : RefundStatus.REVIEW_REQUIRED,
          },
          update: {},
        });
        if (eligibleForAutomaticRequest) {
          await transaction.serviceOrder.updateMany({
            where: { id: order.id, status: OrderStatus.PAID },
            data: { status: OrderStatus.REFUND_PENDING },
          });
        }
        await transaction.outboxEvent.create({
          data: {
            campusId: order.campusId,
            aggregateType: "Refund",
            aggregateId: refund.id,
            eventType: "RefundRequestedByUser",
            payload: { reason, automatic: eligibleForAutomaticRequest },
            availableAt: now,
          },
        });
        return { status: 202, body: refundResponse(refund) };
      },
      now,
      { serializableAttempts: 5 },
    );
    return result.body;
  }

  public async getRefund(principal: AuthenticatedUser, refundId: string): Promise<RefundResponse> {
    const refund = await this.prisma.refund.findFirst({
      where: { id: refundId, campusId: principal.campusId, order: { userId: principal.userId } },
    });
    if (refund === null) throw resourceNotFound();
    return refundResponse(refund);
  }

  public async ingestVerifiedWechatRefundEvent(
    input: VerifiedWechatRefundEventInput,
  ): Promise<WechatProviderEventReceipt> {
    assertVerifiedWechatRefundEvent(input);
    const existing = await this.prisma.providerEvent.findUnique({
      where: {
        provider_eventId: { provider: PaymentProvider.WECHAT_PAY, eventId: input.eventId },
      },
    });
    if (existing !== null) {
      if (existing.rawDigest !== input.rawDigest) {
        await this.recordProviderEventDigestConflict(existing, input.rawDigest);
        return { providerEventId: existing.id, status: "REVIEW_REQUIRED" };
      }
      return { providerEventId: existing.id, status: existing.status };
    }

    const refund = await this.prisma.refund.findUnique({
      where: { merchantRefundNo: input.merchantRefundNo },
      include: {
        order: { select: { id: true, campusId: true, merchantOrderNo: true, amountFen: true } },
      },
    });
    const canBindRefund =
      refund !== null &&
      refund.order.merchantOrderNo === input.merchantOrderNo &&
      refund.amountFen === input.amountFen;
    try {
      const event = await this.prisma.providerEvent.create({
        data: {
          provider: PaymentProvider.WECHAT_PAY,
          eventId: input.eventId,
          eventType: input.eventType,
          verifierKeyId: input.verifierKeyId,
          rawDigest: input.rawDigest,
          merchantOrderNo: input.merchantOrderNo,
          merchantRefundNo: input.merchantRefundNo,
          providerRefundId: input.providerRefundId,
          amountFen: input.amountFen,
          currency: input.currency,
          occurredAt: input.occurredAt,
          ...(refund === null ? {} : { campusId: refund.campusId }),
          ...(canBindRefund ? { orderId: refund.orderId, refundId: refund.id } : {}),
        },
      });
      return { providerEventId: event.id, status: event.status };
    } catch (error) {
      if (!isUniqueProviderEventConflict(error)) throw error;
      const replay = await this.prisma.providerEvent.findUnique({
        where: {
          provider_eventId: { provider: PaymentProvider.WECHAT_PAY, eventId: input.eventId },
        },
      });
      if (replay === null) throw error;
      if (replay.rawDigest !== input.rawDigest) {
        await this.recordProviderEventDigestConflict(replay, input.rawDigest);
        return { providerEventId: replay.id, status: "REVIEW_REQUIRED" };
      }
      return { providerEventId: replay.id, status: replay.status };
    }
  }

  public async applyVerifiedWechatRefundEvent(
    providerEventId: string,
    now = new Date(),
  ): Promise<WechatProviderEventReceipt> {
    return runSerializableWithRetry(this.prisma, async (transaction) => {
      const event = await transaction.providerEvent.findUnique({
        where: { id: providerEventId },
        include: { refund: { include: { order: { include: { round: true } } } } },
      });
      if (event === null) throw resourceNotFound();
      if (event.status !== ProviderEventStatus.RECEIVED) {
        return { providerEventId: event.id, status: event.status };
      }
      if (event.eventType !== "REFUND.SUCCESS" || event.refund === null || event.orderId === null) {
        return markWechatEventForReview(transaction, event, "UNKNOWN_OR_UNSUPPORTED_REFUND");
      }
      const refund = event.refund;
      if (
        event.amountFen !== refund.amountFen ||
        event.currency !== "CNY" ||
        event.providerRefundId === null ||
        !CALLBACK_REFUND_STATES.includes(refund.status)
      ) {
        return markWechatEventForReview(transaction, event, "REFUND_FACT_OR_STATE_MISMATCH", {
          id: refund.orderId,
          campusId: refund.campusId,
        });
      }
      await transaction.refund.update({
        where: { id: refund.id },
        data: {
          providerEventId: event.id,
          providerRefundId: event.providerRefundId,
          status: RefundStatus.REFUNDED,
          completedAt: event.occurredAt ?? now,
        },
      });
      await transaction.serviceOrder.updateMany({
        where: { id: refund.orderId, status: OrderStatus.REFUND_PENDING },
        data: { status: OrderStatus.REFUNDED },
      });
      await recoverRefundedFormationRound(transaction, refund.order.round.id, now);
      await transaction.providerEvent.update({
        where: { id: event.id },
        data: { status: ProviderEventStatus.APPLIED, appliedAt: now },
      });
      await transaction.outboxEvent.create({
        data: {
          campusId: refund.campusId,
          aggregateType: "Refund",
          aggregateId: refund.id,
          eventType: "WechatRefundEventApplied",
          payload: { serviceOrderId: refund.orderId },
        },
      });
      return { providerEventId: event.id, status: "APPLIED" };
    });
  }

  public async revokeContactConsent(
    principal: AuthenticatedUser,
    roundId: string,
    idempotencyKey: string,
    now = new Date(),
  ): Promise<void> {
    await this.idempotency.execute(
      "revokeContactConsent",
      idempotencyKey,
      principal,
      { roundId },
      async (transaction) => {
        const round = await transaction.formationRound.findFirst({
          where: { id: roundId, campusId: principal.campusId },
          include: { group: { include: { members: true } } },
        });
        if (round === null) throw resourceNotFound();
        const membership = round.group.members.find((member) => member.userId === principal.userId);
        if (membership === undefined) throw resourceNotFound();
        const consent = await transaction.contactConsent.findUnique({
          where: { roundId_userId: { roundId, userId: principal.userId } },
        });
        if (consent === null || consent.revokedAt !== null) return { status: 204, body: {} };
        await transaction.contactConsent.update({
          where: { id: consent.id },
          data: { revokedAt: now },
        });
        if (round.state === RoundState.PAYING && round.group.state === GroupState.PAYING) {
          await this.beginCompensation(transaction, round.id, "CONTACT_CONSENT_REVOKED", now);
        }
        return { status: 204, body: {} };
      },
      now,
      { serializableAttempts: 5 },
    );
  }

  public async getUnlockedContacts(
    principal: AuthenticatedUser,
    groupId: string,
    now = new Date(),
  ): Promise<readonly UnlockedContactResponse[]> {
    const result = await runSerializableWithRetry(this.prisma, async (transaction) => {
      const group = await transaction.companionGroup.findFirst({
        where: { id: groupId, campusId: principal.campusId },
        include: {
          members: {
            where: { status: MemberStatus.CONTACT_UNLOCKED },
            orderBy: [{ joinedAt: "asc" }, { id: "asc" }],
            include: { user: { include: { contact: true, verifications: true } } },
          },
          rounds: {
            orderBy: { sequence: "desc" },
            take: 1,
            include: {
              contactConsents: true,
              contactUnlocks: true,
              orders: { select: { id: true } },
            },
          },
        },
      });
      if (group === null) throw resourceNotFound();
      const round = group.rounds[0];
      // M3 rounds did not create service orders, so their pre-delivery contact
      // resource must remain invisible.  Once M4 has created an order, a group
      // member can instead receive the stable "not unlocked" result required
      // for payment/refund recovery without ever receiving contact data.
      if (
        round === undefined ||
        (round.state !== RoundState.DELIVERED && round.orders.length === 0)
      )
        throw resourceNotFound();
      const viewerIndex = group.members.findIndex((member) => member.userId === principal.userId);
      const denied = () => ({
        kind: "DENIED" as const,
        roundId: round.id,
        policyVersionId: round.contactPolicyVersionId,
      });
      if (
        group.state !== GroupState.CONTACTS_UNLOCKED ||
        viewerIndex < 0 ||
        group.members.length < 2 ||
        round.contactConsents.length !== group.members.length ||
        round.contactConsents.some((consent) => consent.revokedAt !== null) ||
        group.members.some(
          (member) =>
            member.user.contact === null ||
            member.user.status !== AccountStatus.ACTIVE ||
            member.user.verifications.every(
              (verification) =>
                verification.status !== VerificationStatus.VERIFIED ||
                verification.expiresAt === null ||
                verification.expiresAt <= now,
            ),
        )
      ) {
        return denied();
      }
      const subjects = group.members.filter((member) => member.userId !== principal.userId);
      if (
        !subjects.every((subject) =>
          round.contactUnlocks.some(
            (unlock) => unlock.viewerId === principal.userId && unlock.subjectId === subject.userId,
          ),
        )
      ) {
        return denied();
      }
      const subjectIds = subjects.map((subject) => subject.userId).sort();
      await transaction.contactAccessLog.create({
        data: {
          campusId: principal.campusId,
          roundId: round.id,
          viewerId: principal.userId,
          policyVersionId: round.contactPolicyVersionId,
          requestId: `m4-contact-${randomUUID()}`,
          outcome: "GRANTED",
          disclosedSubjectSetDigest: sha256Hex(subjectIds.join(",")),
          disclosedSubjectCount: subjects.length,
        },
      });
      return {
        kind: "GRANTED" as const,
        contacts: subjects.map((subject, index) => {
          const contact = subject.user.contact;
          if (contact === null)
            throw new Error("contact precondition changed during contact delivery");
          return {
            label: `成员 ${index + 1}`,
            wechatId: this.protector.decrypt(contact.wechatIdCiphertext),
          };
        }),
      };
    });
    if (result.kind === "GRANTED") return result.contacts;
    if (result.roundId !== undefined && result.policyVersionId !== undefined) {
      await this.prisma.contactAccessLog.create({
        data: {
          campusId: principal.campusId,
          roundId: result.roundId,
          viewerId: principal.userId,
          policyVersionId: result.policyVersionId,
          requestId: `m4-contact-${randomUUID()}`,
          outcome: "DENIED",
          denialCode: "CONTACTS_NOT_UNLOCKED",
        },
      });
    }
    throw new ApplicationError("CONTACTS_NOT_UNLOCKED", "contacts are not unlocked", 409);
  }

  private async requirePayingMember(
    transaction: Transaction,
    principal: AuthenticatedUser,
    groupId: string,
    roundId: string,
    now: Date,
  ): Promise<{ readonly payBy: Date }> {
    await requireEligibleUser(transaction, principal, now);
    const round = await transaction.formationRound.findFirst({
      where: { id: roundId, groupId, campusId: principal.campusId },
      include: { group: { include: { members: true } } },
    });
    if (
      round === null ||
      round.state !== RoundState.PAYING ||
      round.group.state !== GroupState.PAYING ||
      round.payBy === null ||
      round.payBy <= now ||
      !round.group.members.some(
        (member) =>
          member.userId === principal.userId && member.status === MemberStatus.PAYMENT_PENDING,
      )
    ) {
      throw paymentConflict("round is not payable");
    }
    return { payBy: round.payBy };
  }

  private async deliverIfComplete(
    transaction: Transaction,
    roundId: string,
    now: Date,
  ): Promise<void> {
    const round = await transaction.formationRound.findUnique({
      where: { id: roundId },
      include: {
        group: {
          include: {
            members: {
              where: { status: { in: [...ACTIVE_MEMBER_STATES] } },
              orderBy: [{ joinedAt: "asc" }, { id: "asc" }],
              include: { user: { include: { contact: true, verifications: true } }, demand: true },
            },
          },
        },
        orders: true,
        contactConsents: true,
      },
    });
    if (
      round === null ||
      round.state !== RoundState.PAYING ||
      round.group.state !== GroupState.PAYING
    )
      return;
    const members = round.group.members;
    const memberIds = new Set(members.map((member) => member.userId));
    if (!members.every((member) => member.status === MemberStatus.PAID)) return;
    const valid =
      members.length >= 2 &&
      formationSnapshotHash(members) === round.memberSnapshotHash &&
      round.orders.length === members.length &&
      round.orders.every(
        (order) =>
          memberIds.has(order.userId) &&
          order.status === OrderStatus.PAID &&
          order.amountFen === PRICE_FEN &&
          order.currency === "CNY" &&
          order.expiresAt.getTime() === round.payBy?.getTime(),
      ) &&
      round.contactConsents.length === members.length &&
      round.contactConsents.every(
        (consent) =>
          consent.revokedAt === null && consent.policyVersionId === round.contactPolicyVersionId,
      ) &&
      members.every(
        (member) =>
          member.user.contact !== null &&
          member.user.status === AccountStatus.ACTIVE &&
          member.user.verifications.some(
            (verification) =>
              verification.status === VerificationStatus.VERIFIED &&
              verification.expiresAt !== null &&
              verification.expiresAt > now,
          ),
      );
    if (!valid) {
      await this.beginCompensation(transaction, round.id, "DELIVERY_PRECONDITION_FAILED", now);
      return;
    }
    await transaction.formationRound.update({
      where: { id: round.id },
      data: { state: RoundState.DELIVERED },
    });
    await transaction.companionGroup.update({
      where: { id: round.groupId },
      data: { state: GroupState.CONTACTS_UNLOCKED, version: { increment: 1 } },
    });
    await transaction.serviceOrder.updateMany({
      where: { roundId: round.id, status: OrderStatus.PAID },
      data: { status: OrderStatus.DELIVERED },
    });
    await transaction.groupMember.updateMany({
      where: { groupId: round.groupId, status: MemberStatus.PAID },
      data: { status: MemberStatus.CONTACT_UNLOCKED },
    });
    await transaction.contactUnlock.createMany({
      data: members.flatMap((viewer) =>
        members
          .filter((subject) => subject.userId !== viewer.userId)
          .map((subject) => ({
            campusId: round.campusId,
            roundId: round.id,
            viewerId: viewer.userId,
            subjectId: subject.userId,
          })),
      ),
      skipDuplicates: true,
    });
    await transaction.outboxEvent.create({
      data: {
        campusId: round.campusId,
        aggregateType: "FormationRound",
        aggregateId: round.id,
        eventType: "ContactsUnlocked",
        payload: { memberCount: members.length },
      },
    });
  }

  private async beginCompensation(
    transaction: Transaction,
    roundId: string,
    reason: string,
    now: Date,
  ): Promise<void> {
    const round = await transaction.formationRound.findUnique({
      where: { id: roundId },
      include: { group: { include: { members: true } }, orders: true },
    });
    if (
      round === null ||
      round.state !== RoundState.PAYING ||
      round.group.state !== GroupState.PAYING
    )
      return;
    await transaction.formationRound.update({
      where: { id: round.id },
      data: { state: RoundState.REFUNDING, invalidationReason: reason },
    });
    await transaction.companionGroup.update({
      where: { id: round.groupId },
      data: { state: GroupState.REFUNDING, version: { increment: 1 } },
    });
    await transaction.serviceOrder.updateMany({
      where: { roundId: round.id, status: { in: [OrderStatus.CREATED, OrderStatus.PAYING] } },
      data: { status: OrderStatus.CLOSED },
    });
    const unpaidMemberIds = round.group.members
      .filter((member) => member.status === MemberStatus.PAYMENT_PENDING)
      .map((member) => member.id);
    const unpaidDemandIds = round.group.members
      .filter((member) => unpaidMemberIds.includes(member.id))
      .map((member) => member.demandId);
    if (unpaidMemberIds.length > 0) {
      await transaction.groupMember.updateMany({
        where: { id: { in: unpaidMemberIds }, status: MemberStatus.PAYMENT_PENDING },
        data: { status: MemberStatus.PAYMENT_TIMEOUT },
      });
      await transaction.travelDemand.updateMany({
        where: { id: { in: unpaidDemandIds } },
        data: { status: DemandStatus.OPEN },
      });
    }
    for (const order of round.orders.filter((candidate) => candidate.status === OrderStatus.PAID)) {
      await transaction.serviceOrder.update({
        where: { id: order.id },
        data: { status: OrderStatus.REFUND_PENDING },
      });
      await transaction.refund.upsert({
        where: { orderId_reason: { orderId: order.id, reason: RefundReason.ROUND_INVALIDATED } },
        create: {
          campusId: round.campusId,
          orderId: order.id,
          amountFen: PRICE_FEN,
          reason: RefundReason.ROUND_INVALIDATED,
          status: RefundStatus.REQUESTED,
        },
        update: {},
      });
    }
    await transaction.outboxEvent.create({
      data: {
        campusId: round.campusId,
        aggregateType: "FormationRound",
        aggregateId: round.id,
        eventType: "RoundRefundRequired",
        payload: { reason },
        availableAt: now,
      },
    });
  }

  private async recordProviderEventDigestConflict(
    event: {
      readonly id: string;
      readonly campusId: string | null;
      readonly orderId: string | null;
      readonly refundId: string | null;
      readonly rawDigest: string;
    },
    observedDigest: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      // A conflicting replay must close the normal settlement path before the
      // exception is visible to an operator.  Do not try to rewrite a terminal
      // fact: an already-applied payment remains historically true, but the
      // reconciliation record still makes the conflict durable for review.
      await transaction.providerEvent.updateMany({
        where: { id: event.id, status: ProviderEventStatus.RECEIVED },
        data: { status: ProviderEventStatus.REVIEW_REQUIRED },
      });
      await transaction.reconciliationException.upsert({
        where: { providerEventId: event.id },
        create: {
          campusId: event.campusId,
          providerEventId: event.id,
          orderId: event.orderId,
          refundId: event.refundId,
          code: "PROVIDER_EVENT_DIGEST_CONFLICT",
          expectedDigest: event.rawDigest,
          observedDigest,
          status: ReconciliationStatus.OPEN,
        },
        update: {},
      });
    });
  }
}

async function requireEligibleUser(
  transaction: Transaction,
  principal: AuthenticatedUser,
  now: Date,
): Promise<void> {
  const user = await transaction.user.findFirst({
    where: {
      id: principal.userId,
      campusId: principal.campusId,
      status: AccountStatus.ACTIVE,
      deletedAt: null,
      verifications: { some: { status: VerificationStatus.VERIFIED, expiresAt: { gt: now } } },
    },
    select: { id: true },
  });
  if (user === null)
    throw new ApplicationError("STUDENT_NOT_VERIFIED", "active verification required", 403);
}

function normalizeWechatId(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z][A-Za-z0-9_-]{5,19}$/u.test(normalized)) {
    throw new ApplicationError("VALIDATION_ERROR", "WeChat ID is invalid", 400, {
      field: "wechatId",
      constraint: "format",
    });
  }
  return normalized;
}

function assertVerifiedWechatPaymentEvent(input: VerifiedWechatPaymentEventInput): void {
  const isToken = (value: string, minimum: number, maximum: number): boolean =>
    value.length >= minimum && value.length <= maximum && /^[A-Za-z0-9_-]+$/u.test(value);
  if (
    !isToken(input.eventId, 1, 128) ||
    input.eventType !== "TRANSACTION.SUCCESS" ||
    !isToken(input.verifierKeyId, 8, 128) ||
    !/^[a-f0-9]{64}$/u.test(input.rawDigest) ||
    !isToken(input.merchantOrderNo, 8, 64) ||
    !isToken(input.providerTransactionId, 8, 128) ||
    !Number.isSafeInteger(input.amountFen) ||
    input.amountFen < 1 ||
    input.amountFen > 100_000_000 ||
    input.currency !== "CNY" ||
    !Number.isFinite(input.occurredAt.getTime())
  ) {
    throw new ApplicationError("VALIDATION_ERROR", "verified WeChat payment event is invalid", 400);
  }
}

function assertVerifiedWechatRefundEvent(input: VerifiedWechatRefundEventInput): void {
  const isToken = (value: string, minimum: number, maximum: number): boolean =>
    value.length >= minimum && value.length <= maximum && /^[A-Za-z0-9_-]+$/u.test(value);
  if (
    !isToken(input.eventId, 1, 128) ||
    input.eventType !== "REFUND.SUCCESS" ||
    !isToken(input.verifierKeyId, 8, 128) ||
    !/^[a-f0-9]{64}$/u.test(input.rawDigest) ||
    !isToken(input.merchantOrderNo, 8, 64) ||
    !isToken(input.merchantRefundNo, 8, 64) ||
    !isToken(input.providerRefundId, 8, 128) ||
    !Number.isSafeInteger(input.amountFen) ||
    input.amountFen < 1 ||
    input.amountFen > 100_000_000 ||
    input.currency !== "CNY" ||
    !Number.isFinite(input.occurredAt.getTime())
  ) {
    throw new ApplicationError("VALIDATION_ERROR", "verified WeChat refund event is invalid", 400);
  }
}

async function markWechatEventForReview(
  transaction: Transaction,
  event: {
    readonly id: string;
    readonly campusId: string | null;
    readonly orderId: string | null;
    readonly refundId: string | null;
    readonly rawDigest: string;
  },
  code: string,
  relatedOrder?: { readonly id: string; readonly campusId: string },
): Promise<WechatProviderEventReceipt> {
  await transaction.providerEvent.update({
    where: { id: event.id },
    data: { status: ProviderEventStatus.REVIEW_REQUIRED },
  });
  await transaction.reconciliationException.upsert({
    where: { providerEventId: event.id },
    create: {
      campusId: event.campusId,
      providerEventId: event.id,
      orderId: event.orderId ?? relatedOrder?.id ?? null,
      refundId: event.refundId,
      code,
      observedDigest: event.rawDigest,
      status: ReconciliationStatus.OPEN,
    },
    update: {},
  });
  return { providerEventId: event.id, status: "REVIEW_REQUIRED" };
}

function isUniqueProviderEventConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function isUniquePaymentTransactionReplayConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
    return false;
  }
  const target = error.meta?.["target"];
  const targets = Array.isArray(target) ? target : typeof target === "string" ? [target] : [];
  return targets.some(
    (value) =>
      typeof value === "string" &&
      (value.includes("providerTransactionId") || value.includes("providerEventId")),
  );
}

function refundResponse(refund: {
  readonly id: string;
  readonly orderId: string;
  readonly amountFen: number;
  readonly reason: RefundReason;
  readonly status: RefundStatus;
}): RefundResponse {
  if (refund.amountFen !== PRICE_FEN)
    throw new Error("refund response violates fixed price invariant");
  return {
    id: refund.id,
    orderId: refund.orderId,
    amountFen: PRICE_FEN,
    reason: refund.reason,
    status: refund.status,
  };
}

function orderResponse(
  order: {
    readonly id: string;
    readonly roundId: string;
    readonly amountFen: number;
    readonly currency: string;
    readonly status: string;
    readonly expiresAt: Date;
  },
  groupId: string,
): ServiceOrderResponse {
  return {
    id: order.id,
    groupId,
    roundId: order.roundId,
    amountFen: PRICE_FEN,
    currency: "CNY",
    status: order.status,
    expiresAt: order.expiresAt.toISOString(),
  };
}

function resourceNotFound(): ApplicationError {
  return new ApplicationError("RESOURCE_NOT_FOUND", "resource not found", 404);
}

function paymentConflict(message: string): ApplicationError {
  return new ApplicationError("PAYMENT_NOT_CONFIRMED", message, 409);
}

function formationSnapshotHash(
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

async function runSerializableWithRetry<T>(
  prisma: PrismaService,
  action: (transaction: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await prisma.$transaction(action, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      if (!isSerializationConflict(error) || attempt === 3) throw error;
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

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
  RefundReason,
  RefundStatus,
  RoundState,
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

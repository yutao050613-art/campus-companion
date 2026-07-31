import { type AesGcmProtector, sha256Hex } from "@campus/auth";
import { Prisma } from "@campus/database";
import { Inject, Injectable } from "@nestjs/common";
import { ApplicationError } from "../common/application-error";
import { PrismaService } from "../database/prisma.service";
import { DATA_PROTECTOR } from "./providers";

const IDEMPOTENCY_LIFETIME_MS = 24 * 60 * 60 * 1_000;

export interface IdempotentResult<T> {
  readonly status: number;
  readonly body: T;
  readonly replayed: boolean;
}

export interface IdempotencyActor {
  readonly userId?: string;
  readonly adminUserId?: string;
  readonly campusId?: string;
}

@Injectable()
export class IdempotencyService {
  public constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(DATA_PROTECTOR) private readonly protector: AesGcmProtector,
  ) {}

  public async execute<T>(
    operation: string,
    key: string,
    actor: IdempotencyActor,
    request: unknown,
    action: (transaction: Prisma.TransactionClient) => Promise<{ status: number; body: T }>,
    now = new Date(),
  ): Promise<IdempotentResult<T>> {
    if (!/^[A-Za-z0-9._:-]{16,128}$/.test(key)) {
      throw new ApplicationError("VALIDATION_ERROR", "Idempotency-Key is invalid", 400, {
        field: "Idempotency-Key",
        constraint: "format",
      });
    }
    if (!/^[A-Za-z][A-Za-z0-9._-]{1,63}$/.test(operation)) {
      throw new TypeError("invalid idempotency operation");
    }
    if ((actor.userId === undefined) === (actor.adminUserId === undefined)) {
      throw new TypeError("idempotency actor must contain exactly one identity");
    }
    const requestDigest = sha256Hex(canonicalJson(request));
    const scope = `m2:${operation}`;
    try {
      return await this.prisma.$transaction(
        async (transaction) => {
          const existing = await transaction.idempotencyRecord.findUnique({
            where: { scope_key: { scope, key } },
          });
          if (existing !== null) {
            if (existing.expiresAt > now) return this.replay<T>(existing, actor, requestDigest);
            await transaction.idempotencyRecord.delete({ where: { id: existing.id } });
          }
          const result = await action(transaction);
          const encrypted = this.protector.encrypt(JSON.stringify(result.body));
          await transaction.idempotencyRecord.create({
            data: {
              scope,
              key,
              requestDigest,
              responseStatus: result.status,
              responseCiphertext: Uint8Array.from(encrypted.ciphertext),
              keyVersion: encrypted.keyVersion,
              expiresAt: new Date(now.getTime() + IDEMPOTENCY_LIFETIME_MS),
              ...(actor.campusId === undefined ? {} : { campusId: actor.campusId }),
              ...(actor.userId === undefined ? {} : { userId: actor.userId }),
              ...(actor.adminUserId === undefined ? {} : { adminUserId: actor.adminUserId }),
            },
          });
          return { ...result, replayed: false };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (!isUniqueConstraint(error)) throw error;
      const existing = await this.prisma.idempotencyRecord.findUnique({
        where: { scope_key: { scope, key } },
      });
      if (existing === null || existing.expiresAt <= now) throw error;
      return this.replay<T>(existing, actor, requestDigest);
    }
  }

  public async findReplay<T>(
    operation: string,
    key: string,
    actor: IdempotencyActor,
    request: unknown,
    now = new Date(),
  ): Promise<IdempotentResult<T> | null> {
    validateRequest(operation, key, actor);
    const record = await this.prisma.idempotencyRecord.findUnique({
      where: { scope_key: { scope: `m2:${operation}`, key } },
    });
    if (record === null || record.expiresAt <= now) return null;
    return this.replay<T>(record, actor, sha256Hex(canonicalJson(request)));
  }

  private replay<T>(
    record: {
      readonly userId: string | null;
      readonly adminUserId: string | null;
      readonly campusId: string | null;
      readonly requestDigest: string;
      readonly responseStatus: number | null;
      readonly responseCiphertext: Uint8Array | null;
      readonly keyVersion: string | null;
    },
    actor: IdempotencyActor,
    requestDigest: string,
  ): IdempotentResult<T> {
    if (
      record.userId !== (actor.userId ?? null) ||
      record.adminUserId !== (actor.adminUserId ?? null) ||
      record.campusId !== (actor.campusId ?? null) ||
      record.requestDigest !== requestDigest
    ) {
      throw new ApplicationError("IDEMPOTENCY_CONFLICT", "Idempotency-Key conflicts", 409);
    }
    if (
      record.responseStatus === null ||
      record.responseCiphertext === null ||
      record.keyVersion !== this.protector.keyVersion
    ) {
      throw new ApplicationError("IDEMPOTENCY_CONFLICT", "request is still being processed", 409);
    }
    const body = JSON.parse(this.protector.decrypt(record.responseCiphertext)) as T;
    return { status: record.responseStatus, body, replayed: true };
  }
}

function validateRequest(operation: string, key: string, actor: IdempotencyActor): void {
  if (!/^[A-Za-z0-9._:-]{16,128}$/.test(key)) {
    throw new ApplicationError("VALIDATION_ERROR", "Idempotency-Key is invalid", 400, {
      field: "Idempotency-Key",
      constraint: "format",
    });
  }
  if (!/^[A-Za-z][A-Za-z0-9._-]{1,63}$/.test(operation)) {
    throw new TypeError("invalid idempotency operation");
  }
  if ((actor.userId === undefined) === (actor.adminUserId === undefined)) {
    throw new TypeError("idempotency actor must contain exactly one identity");
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite request number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("unsupported request value");
}

function isUniqueConstraint(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

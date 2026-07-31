export type Brand<Value, Name extends string> = Value & {
  readonly __brand: Name;
};

export type AggregateId = Brand<string, "AggregateId">;

export type VerificationStatus =
  | "AWAITING_UPLOAD"
  | "UPLOAD_EXPIRED"
  | "PENDING"
  | "VERIFIED"
  | "REJECTED"
  | "REQUIRE_RESUBMISSION"
  | "RESUBMISSION_AWAITING_UPLOAD"
  | "RESUBMISSION_PENDING"
  | "VERIFICATION_EXPIRED";

export interface DomainEvent<Payload extends Readonly<Record<string, unknown>>> {
  readonly eventId: string;
  readonly eventType: string;
  readonly aggregateId: AggregateId;
  readonly occurredAt: string;
  readonly payload: Payload;
}

export function assertNever(value: never): never {
  throw new Error(`Unexpected domain value: ${String(value)}`);
}

function timestamp(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function isVerificationActive(
  status: VerificationStatus,
  expiresAt: string | null,
  asOf: string,
): boolean {
  const expiry = expiresAt === null ? null : timestamp(expiresAt);
  const reference = timestamp(asOf);
  return status === "VERIFIED" && expiry !== null && reference !== null && expiry > reference;
}

export function expireVerificationAtBoundary(
  status: VerificationStatus,
  expiresAt: string | null,
  asOf: string,
): VerificationStatus {
  if (status !== "VERIFIED") {
    return status;
  }

  const expiry = expiresAt === null ? null : timestamp(expiresAt);
  const reference = timestamp(asOf);
  if (expiry === null || reference === null) {
    throw new Error("Verified credential requires valid expiresAt and asOf timestamps");
  }

  return expiry <= reference ? "VERIFICATION_EXPIRED" : "VERIFIED";
}

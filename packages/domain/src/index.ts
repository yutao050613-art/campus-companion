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

export type GroupingGender = "MALE" | "FEMALE" | "UNDISCLOSED";
export type GroupingPreference = "ANY" | "SAME_GENDER_ONLY";
export type RecruitableGroupState = "RECRUITING" | "READY" | "EXPIRED";

export interface GroupingMember {
  readonly userId: string;
  readonly seatCount: number;
  readonly gender: GroupingGender;
  readonly preference: GroupingPreference;
}

export interface GroupingSummary {
  readonly accountCount: number;
  readonly occupiedSeats: number;
  readonly remainingSeats: number;
  readonly state: RecruitableGroupState;
}

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

export function summarizeGroupingMembers(members: readonly GroupingMember[]): GroupingSummary {
  const userIds = new Set<string>();
  let occupiedSeats = 0;
  for (const member of members) {
    if (member.userId.length === 0 || userIds.has(member.userId)) {
      throw new Error("Grouping members must contain distinct non-empty users");
    }
    if (!Number.isInteger(member.seatCount) || member.seatCount < 1 || member.seatCount > 3) {
      throw new Error("Grouping member seatCount must be an integer from one to three");
    }
    userIds.add(member.userId);
    occupiedSeats += member.seatCount;
  }
  if (occupiedSeats > 4) throw new Error("Grouping members cannot occupy a fifth seat");
  return {
    accountCount: userIds.size,
    occupiedSeats,
    remainingSeats: 4 - occupiedSeats,
    state: userIds.size === 0 ? "EXPIRED" : userIds.size === 1 ? "RECRUITING" : "READY",
  };
}

export function isGenderPreferenceCompatible(members: readonly GroupingMember[]): boolean {
  const constrained = members.some((member) => member.preference === "SAME_GENDER_ONLY");
  if (!constrained) return true;
  const firstGender = members[0]?.gender;
  if (firstGender === undefined || firstGender === "UNDISCLOSED") return false;
  return members.every((member) => member.gender === firstGender);
}

export function assertFormationReady(members: readonly GroupingMember[]): GroupingSummary {
  const summary = summarizeGroupingMembers(members);
  if (summary.state !== "READY") {
    throw new Error("Formation requires at least two distinct accounts");
  }
  if (!isGenderPreferenceCompatible(members)) {
    throw new Error("Formation members have incompatible gender preferences");
  }
  return summary;
}

export function windowsOverlap(
  leftStart: Date,
  leftEnd: Date,
  rightStart: Date,
  rightEnd: Date,
): boolean {
  const leftStartMs = leftStart.getTime();
  const leftEndMs = leftEnd.getTime();
  const rightStartMs = rightStart.getTime();
  const rightEndMs = rightEnd.getTime();
  const values = [leftStartMs, leftEndMs, rightStartMs, rightEndMs];
  if (values.some((value) => !Number.isFinite(value)))
    throw new Error("Grouping window is invalid");
  if (leftStartMs >= leftEndMs || rightStartMs >= rightEndMs) {
    throw new Error("Grouping window end must be later than its start");
  }
  return leftStartMs < rightEndMs && rightStartMs < leftEndMs;
}

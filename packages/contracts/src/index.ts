export const ERROR_CODES = [
  "VALIDATION_ERROR",
  "AUTH_REQUIRED",
  "SESSION_EXPIRED",
  "STUDENT_NOT_VERIFIED",
  "ACCOUNT_RESTRICTED",
  "RESOURCE_NOT_FOUND",
  "RESOURCE_FORBIDDEN",
  "IDEMPOTENCY_CONFLICT",
  "OVERLAPPING_ACTIVE_GROUP",
  "GROUP_NOT_JOINABLE",
  "GROUP_CAPACITY_EXCEEDED",
  "GENDER_PREFERENCE_INCOMPATIBLE",
  "FORMATION_NOT_READY",
  "FORMATION_EXPIRED",
  "PAYMENT_NOT_CONFIRMED",
  "CONTACTS_NOT_UNLOCKED",
  "CONTACT_CONSENT_REQUIRED",
  "CONTACT_CONSENT_VERSION_MISMATCH",
  "CONTACT_CONSENT_REVOKED",
  "GROUP_REFUND_IN_PROGRESS",
  "REFUND_NOT_ELIGIBLE",
  "ADMIN_CSRF_INVALID",
  "ADMIN_ROLE_REQUIRED",
  "ADMIN_CAMPUS_FORBIDDEN",
  "ADMIN_REAUTH_REQUIRED",
  "VERIFICATION_ASSET_INVALID",
  "VERIFICATION_UPLOAD_EXPIRED",
  "VERIFICATION_RESUBMISSION_REQUIRED",
  "VERIFICATION_ASSET_GRANT_UNAVAILABLE",
  "RATE_LIMITED",
  "INTERNAL_ERROR",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface FieldViolation {
  readonly field: string;
  readonly constraint: string;
}

export interface SafeErrorDetails {
  readonly field?: string;
  readonly constraint?: string;
  readonly violations?: readonly FieldViolation[];
  readonly retryAfterSeconds?: number;
  readonly currentVersion?: number;
  readonly expectedVersion?: number;
}

export interface ApiErrorPayload {
  readonly code: ErrorCode;
  readonly message: string;
  readonly requestId: string;
  readonly details?: SafeErrorDetails;
}

export interface ApiErrorResponse {
  readonly error: ApiErrorPayload;
}

export interface HealthResponse {
  readonly status: "ok";
  readonly service: string;
  readonly version: string;
  readonly timestamp: string;
}

export function makeApiError(payload: ApiErrorPayload): ApiErrorResponse {
  return { error: payload };
}

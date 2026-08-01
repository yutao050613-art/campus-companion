import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const schema = readFileSync(join(__dirname, "../prisma/schema.prisma"), "utf8");
const migrationsRoot = join(__dirname, "../prisma/migrations");
const migrationFiles = readdirSync(migrationsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()
  .map((directory) => readFileSync(join(migrationsRoot, directory, "migration.sql"), "utf8"));
const migration = migrationFiles.join("\n");
const m1Migration = migrationFiles[0] ?? "";

function modelBody(modelName: string): string {
  const match = schema.match(new RegExp(`model ${modelName} \\{([\\s\\S]*?)\\n\\}`));
  if (!match?.[1]) {
    throw new Error(`Missing Prisma model: ${modelName}`);
  }
  return match[1];
}

describe("database architecture boundary", () => {
  it("contains every M0 core entity", () => {
    for (const model of [
      "User",
      "StudentVerification",
      "TravelDemand",
      "CompanionGroup",
      "FormationRound",
      "ServiceOrder",
      "PaymentTransaction",
      "Refund",
      "ProviderEvent",
      "ReconciliationException",
      "ContactUnlock",
      "ContactAccessLog",
      "AdminSession",
      "VerificationAssetAccessGrant",
      "RiskEvent",
      "AuditLog",
      "IdempotencyRecord",
    ]) {
      expect(schema).toContain(`model ${model} {`);
    }
  });

  it("does not introduce transport-domain entities", () => {
    expect(schema).not.toMatch(/model\s+(Driver|Vehicle|Fare|TransportOrder)\s*\{/i);
    expect(schema).not.toMatch(/driverId|vehicleId|actualFare|transportStatus/i);
  });

  it("stores money as integer fen", () => {
    expect(schema).toMatch(/amountFen\s+Int/);
    expect(schema).not.toMatch(/amount\s+(Float|Decimal)/);
  });

  it("stores campusId on tenant-owned dependent records", () => {
    for (const model of [
      "UserSession",
      "UserContact",
      "VerificationAsset",
      "RouteSchedule",
      "GroupMember",
      "FormationRound",
      "MemberConfirmation",
      "ServiceOrder",
      "PaymentTransaction",
      "Refund",
      "ContactConsent",
      "ContactUnlock",
      "ContactAccessLog",
      "VerificationAssetAccessGrant",
      "BlockRelation",
      "Notification",
      "OutboxEvent",
    ]) {
      expect(modelBody(model), model).toMatch(/campusId\s+String\s+@db\.Uuid/);
    }
  });

  it("adds database guards for tenant boundaries and seat capacity", () => {
    expect(migration).toContain('CONSTRAINT "GroupMember_campus_group_fkey"');
    expect(migration).toContain('CONSTRAINT "ServiceOrder_campus_round_fkey"');
    expect(migration).toContain('CONSTRAINT "ServiceOrder_price_check"');
    expect(migration).toContain('CONSTRAINT "GroupMember_seat_count_check"');
    expect(migration).toContain('CREATE FUNCTION "enforce_group_seat_limit"()');
    expect(migration).toContain('occupied_seats + NEW."seatCount" > 4');
    expect(migration).toContain('CONSTRAINT "ContactAccessLog_outcome_check"');
    expect(migration).toContain('CONSTRAINT "VerificationAssetAccessGrant_lifetime_check"');
    expect(migration).toContain('CONSTRAINT "StudentVerification_state_time_check"');
    expect(migration).toContain('"expiresAt" > "reviewedAt"');
    expect(migration).toContain('CONSTRAINT "ContactAccessLog_disclosure_evidence_check"');
    expect(migration).toContain('CONSTRAINT "AdminSession_lifetime_check"');
    expect(migration).toContain('FUNCTION "consume_verification_asset_access_grant"');
    expect(migration).toContain("VerificationAssetAccessGrant_usedAt_immutable_trigger");
    expect(migration).toContain('CREATE TYPE "ProviderEventStatus"');
    expect(migration).toContain('CREATE TYPE "ReconciliationStatus"');
    expect(migration).toContain('CONSTRAINT "ProviderEvent_provider_eventId_key"');
    expect(migration).toContain('CONSTRAINT "ProviderEvent_digest_check"');
    expect(migration).toContain('CONSTRAINT "ReconciliationException_evidence_check"');
    expect(migration).toContain('CREATE FUNCTION "enforce_m5_provider_event_guard"()');
    expect(migration).toContain('CREATE FUNCTION "enforce_m5_payment_transaction_guard"()');
    expect(migration).toContain('CREATE FUNCTION "enforce_m5_refund_guard"()');
    expect(migration).toContain('CREATE FUNCTION "enforce_m5_reconciliation_exception_guard"()');
    expect(migration).toContain("ProviderEvent_m5_guard");
    expect(migration).toContain("PaymentTransaction_m5_wechat_guard");
  });

  it("models provider evidence before payment settlement and keeps it privacy-minimized", () => {
    const providerEvent = modelBody("ProviderEvent");
    const reconciliation = modelBody("ReconciliationException");
    const refund = modelBody("Refund");

    expect(providerEvent).toMatch(/campusId\s+String\?/);
    expect(providerEvent).toMatch(/rawDigest\s+String\s+@db\.Char\(64\)/);
    expect(providerEvent).toMatch(/amountFen\s+Int/);
    expect(providerEvent).toMatch(/currency\s+String\s+@db\.Char\(3\)/);
    expect(providerEvent).toMatch(/@@unique\(\[provider, eventId\]\)/);
    expect(providerEvent).not.toMatch(/rawPayload|ciphertext|wechatId|phone/i);
    expect(reconciliation).toMatch(/providerEventId\s+String\?\s+@unique/);
    expect(reconciliation).toMatch(/expectedDigest\s+String\?/);
    expect(reconciliation).toMatch(/observedDigest\s+String\?/);
    expect(refund).toMatch(/merchantRefundNo\s+String\s+@unique/);
    expect(refund).toMatch(/providerEventId\s+String\?\s+@unique/);
  });

  it("registers the reviewed M2 sensitive-information policy without rewriting M1", () => {
    expect(migration).toContain("2026-07-31T00:00:00.000Z");
    expect(migration).toContain("sensitive-info-v1");
    expect(migration).toContain("46035097382e2f7435307106825cc0f2cc2a94a98e767b597a48488ee73918a7");
    expect(migration).toContain('CREATE TYPE "VerificationAssetType"');
    expect(migration).toContain('"verificationAssetId" UUID');
    expect(migration).toContain('ALTER COLUMN "deleteAfter" DROP NOT NULL');
    expect(migration).not.toMatch(/UPDATE\s+"(?:StudentVerification|PolicyVersion)"/iu);
  });

  it("models the remediated M0 states and immutable policy baseline", () => {
    const verificationStatus = schema.match(/enum VerificationStatus \{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(schema).toMatch(/enum VerificationStatus \{[\s\S]*AWAITING_UPLOAD/);
    expect(schema).toMatch(/enum VerificationStatus \{[\s\S]*UPLOAD_EXPIRED/);
    expect(schema).toMatch(/enum VerificationStatus \{[\s\S]*REQUIRE_RESUBMISSION/);
    expect(schema).toMatch(/enum VerificationStatus \{[\s\S]*RESUBMISSION_AWAITING_UPLOAD/);
    expect(schema).toMatch(/enum VerificationStatus \{[\s\S]*RESUBMISSION_PENDING/);
    expect(schema).toMatch(/enum VerificationStatus \{[\s\S]*VERIFICATION_EXPIRED/);
    expect(verificationStatus).not.toMatch(/^\s*EXPIRED\s*$/m);
    expect(schema).toMatch(/enum GroupState \{[\s\S]*REFUNDING[\s\S]*REFUND_RETRY/);
    expect(modelBody("FormationRound")).toMatch(/contactPolicyVersionId\s+String\s+@db\.Uuid/);
    expect(modelBody("StudentVerification")).toMatch(/latestSubmittedAt\s+DateTime\?/);
    expect(modelBody("VerificationAssetAccessGrant")).toMatch(
      /adminSessionId\s+String\s+@db\.Uuid/,
    );
    expect(modelBody("ContactAccessLog")).toMatch(/disclosedSubjectSetDigest\s+String\?/);

    const policy = readFileSync(
      join(__dirname, "../../../docs/policies/contact-sharing-v1.md"),
      "utf8",
    );
    const digest = createHash("sha256").update(policy).digest("hex");
    expect(migration).toContain(digest);
  });

  it("is a final-state empty-database candidate without historical upgrade steps", () => {
    expect(m1Migration).toContain(
      "M1 final-state candidate baseline generated from an empty database",
    );
    expect(m1Migration).toContain(
      `CREATE TYPE "VerificationStatus" AS ENUM ('AWAITING_UPLOAD', 'UPLOAD_EXPIRED', 'PENDING', 'VERIFIED', 'REJECTED', 'REQUIRE_RESUBMISSION', 'RESUBMISSION_AWAITING_UPLOAD', 'RESUBMISSION_PENDING', 'VERIFICATION_EXPIRED')`,
    );
    expect(m1Migration).toContain(
      `CREATE TYPE "GroupState" AS ENUM ('RECRUITING', 'READY', 'CONFIRMING', 'PAYING', 'REFUNDING', 'REFUND_RETRY', 'CONTACTS_UNLOCKED', 'COMPLETED', 'EXPIRED', 'RISK_HOLD', 'DISPUTED')`,
    );
    expect(m1Migration).not.toMatch(/ALTER TYPE|ADD COLUMN/);
    expect(m1Migration).not.toMatch(/original M1 snapshot|preceding migration|historical EXPIRED/i);
    expect(m1Migration).not.toContain('UPDATE "StudentVerification"');
    expect(m1Migration).not.toContain('UPDATE "FormationRound"');
    expect(m1Migration).not.toContain('UPDATE "VerificationAsset"');
  });
});

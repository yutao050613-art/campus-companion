-- M1 final-state candidate baseline generated from an empty database.
-- Base DDL: Prisma 6.19.2 migrate diff --from-empty --to-schema-datamodel.
-- Custom tenant keys, checks, partial indexes, triggers, functions, and the
-- versioned contact-sharing policy seed are appended below.
-- Candidate only: do not freeze or deploy to shared, persistent, or release
-- environments until PostgreSQL 16 native gates and project/release owner reset
-- approval are complete. Validation in a disposable isolated database is allowed.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'RESTRICTED', 'DELETION_PENDING', 'DELETED');

-- CreateEnum
CREATE TYPE "GenderDeclaration" AS ENUM ('MALE', 'FEMALE', 'UNDISCLOSED');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('AWAITING_UPLOAD', 'UPLOAD_EXPIRED', 'PENDING', 'VERIFIED', 'REJECTED', 'REQUIRE_RESUBMISSION', 'RESUBMISSION_AWAITING_UPLOAD', 'RESUBMISSION_PENDING', 'VERIFICATION_EXPIRED');

-- CreateEnum
CREATE TYPE "CatalogStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "PlaceType" AS ENUM ('CAMPUS_GATE', 'TRANSIT_HUB', 'OTHER_FIXED');

-- CreateEnum
CREATE TYPE "LuggageSize" AS ENUM ('NONE', 'SMALL', 'LARGE');

-- CreateEnum
CREATE TYPE "GenderPreference" AS ENUM ('ANY', 'SAME_GENDER_ONLY');

-- CreateEnum
CREATE TYPE "DemandStatus" AS ENUM ('OPEN', 'GROUPED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "GroupState" AS ENUM ('RECRUITING', 'READY', 'CONFIRMING', 'PAYING', 'REFUNDING', 'REFUND_RETRY', 'CONTACTS_UNLOCKED', 'COMPLETED', 'EXPIRED', 'RISK_HOLD', 'DISPUTED');

-- CreateEnum
CREATE TYPE "MemberStatus" AS ENUM ('JOINED', 'CONFIRMED', 'PAYMENT_PENDING', 'PAID', 'CONTACT_UNLOCKED', 'LEFT', 'DECLINED', 'PAYMENT_TIMEOUT', 'REMOVED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "RoundState" AS ENUM ('CONFIRMING', 'PAYING', 'DELIVERED', 'REFUNDING', 'REFUND_RETRY', 'INVALIDATED');

-- CreateEnum
CREATE TYPE "ConfirmationDecision" AS ENUM ('ACCEPT', 'DECLINE');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('CREATED', 'PAYING', 'PAID', 'DELIVERED', 'CLOSED', 'REFUND_PENDING', 'REFUNDED', 'REFUND_FAILED');

-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('MOCK', 'WECHAT_PAY');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "RefundReason" AS ENUM ('PLATFORM_NOT_DELIVERED', 'DUPLICATE_CHARGE', 'ROUND_INVALIDATED', 'ADMIN_APPROVED', 'OTHER');

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('REQUESTED', 'REVIEW_REQUIRED', 'REFUND_PENDING', 'REFUNDED', 'REFUND_FAILED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ReportCategory" AS ENUM ('HARASSMENT', 'IMPERSONATION', 'NO_SHOW', 'PRIVACY', 'UNSAFE_BEHAVIOR', 'OTHER');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('OPEN', 'REVIEWING', 'RESOLVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "RiskDecision" AS ENUM ('ALLOW', 'REVIEW', 'RESTRICT', 'BLOCK');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED');

-- CreateEnum
CREATE TYPE "AdminStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "PolicyType" AS ENUM ('USER_TERMS', 'PRIVACY', 'SENSITIVE_INFO', 'CONTACT_SHARING', 'REFUND', 'SAFETY');

-- CreateEnum
CREATE TYPE "ContactAccessOutcome" AS ENUM ('GRANTED', 'DENIED');

-- CreateTable
CREATE TABLE "Campus" (
    "id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "status" "CatalogStatus" NOT NULL DEFAULT 'ACTIVE',
    "timezone" VARCHAR(64) NOT NULL DEFAULT 'Asia/Shanghai',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Campus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "wechatSubject" VARCHAR(128) NOT NULL,
    "displayName" VARCHAR(30) NOT NULL,
    "status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "genderDeclaration" "GenderDeclaration" NOT NULL DEFAULT 'UNDISCLOSED',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserSession" (
    "id" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "refreshTokenHash" CHAR(64) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserContact" (
    "id" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "wechatIdCiphertext" BYTEA NOT NULL,
    "keyVersion" VARCHAR(64) NOT NULL,
    "valueDigest" CHAR(64) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "UserContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudentVerification" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "studentNumberDigest" CHAR(64) NOT NULL,
    "studentNumberLast4" VARCHAR(4) NOT NULL,
    "status" "VerificationStatus" NOT NULL DEFAULT 'AWAITING_UPLOAD',
    "consentPolicyId" UUID NOT NULL,
    "submittedAt" TIMESTAMPTZ(3),
    "latestSubmittedAt" TIMESTAMPTZ(3),
    "reviewedAt" TIMESTAMPTZ(3),
    "expiresAt" TIMESTAMPTZ(3),
    "reasonCode" VARCHAR(100),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "StudentVerification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationAsset" (
    "id" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "verificationId" UUID NOT NULL,
    "objectKey" VARCHAR(512) NOT NULL,
    "contentDigest" CHAR(64),
    "contentType" VARCHAR(100),
    "sizeBytes" INTEGER,
    "deleteAfter" TIMESTAMPTZ(3) NOT NULL,
    "uploadExpiresAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VerificationAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Place" (
    "id" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "type" "PlaceType" NOT NULL,
    "status" "CatalogStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Place_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Route" (
    "id" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "originId" UUID NOT NULL,
    "destinationId" UUID NOT NULL,
    "status" "CatalogStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Route_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RouteSchedule" (
    "id" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "routeId" UUID NOT NULL,
    "weekday" INTEGER NOT NULL,
    "startMinute" INTEGER NOT NULL,
    "endMinute" INTEGER NOT NULL,
    "windowMinutes" INTEGER NOT NULL DEFAULT 30,
    "activeFrom" DATE NOT NULL,
    "activeUntil" DATE,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RouteSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TravelDemand" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "routeId" UUID NOT NULL,
    "windowStart" TIMESTAMPTZ(3) NOT NULL,
    "windowEnd" TIMESTAMPTZ(3) NOT NULL,
    "seatCount" INTEGER NOT NULL,
    "luggageSize" "LuggageSize" NOT NULL,
    "genderPreference" "GenderPreference" NOT NULL,
    "status" "DemandStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "TravelDemand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanionGroup" (
    "id" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "routeId" UUID NOT NULL,
    "windowStart" TIMESTAMPTZ(3) NOT NULL,
    "windowEnd" TIMESTAMPTZ(3) NOT NULL,
    "state" "GroupState" NOT NULL DEFAULT 'RECRUITING',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CompanionGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupMember" (
    "id" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "demandId" UUID NOT NULL,
    "seatCount" INTEGER NOT NULL,
    "status" "MemberStatus" NOT NULL DEFAULT 'JOINED',
    "joinedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "GroupMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FormationRound" (
    "id" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "memberSnapshotHash" CHAR(64) NOT NULL,
    "state" "RoundState" NOT NULL DEFAULT 'CONFIRMING',
    "confirmBy" TIMESTAMPTZ(3) NOT NULL,
    "payBy" TIMESTAMPTZ(3),
    "invalidatedAt" TIMESTAMPTZ(3),
    "invalidationReason" VARCHAR(100),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "contactPolicyVersionId" UUID NOT NULL,

    CONSTRAINT "FormationRound_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemberConfirmation" (
    "id" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "roundId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "decision" "ConfirmationDecision" NOT NULL,
    "decidedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemberConfirmation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceOrder" (
    "id" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "roundId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "merchantOrderNo" VARCHAR(64) NOT NULL,
    "amountFen" INTEGER NOT NULL DEFAULT 99,
    "currency" CHAR(3) NOT NULL DEFAULT 'CNY',
    "pricingVersion" VARCHAR(50) NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'CREATED',
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ServiceOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentTransaction" (
    "id" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "providerTransactionId" VARCHAR(128),
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "rawDigest" CHAR(64) NOT NULL,
    "occurredAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PaymentTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Refund" (
    "id" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "providerRefundId" VARCHAR(128),
    "amountFen" INTEGER NOT NULL,
    "reason" "RefundReason" NOT NULL,
    "status" "RefundStatus" NOT NULL DEFAULT 'REQUESTED',
    "requestedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Refund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PolicyVersion" (
    "id" UUID NOT NULL,
    "type" "PolicyType" NOT NULL,
    "version" VARCHAR(50) NOT NULL,
    "contentDigest" CHAR(64) NOT NULL,
    "effectiveAt" TIMESTAMPTZ(3) NOT NULL,
    "retiredAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PolicyVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactConsent" (
    "id" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "roundId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "policyVersionId" UUID NOT NULL,
    "grantedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "ContactConsent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactUnlock" (
    "id" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "roundId" UUID NOT NULL,
    "viewerId" UUID NOT NULL,
    "subjectId" UUID NOT NULL,
    "unlockedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactUnlock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactAccessLog" (
    "id" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "roundId" UUID NOT NULL,
    "viewerId" UUID NOT NULL,
    "policyVersionId" UUID NOT NULL,
    "requestId" VARCHAR(100) NOT NULL,
    "outcome" "ContactAccessOutcome" NOT NULL,
    "denialCode" VARCHAR(100),
    "disclosedSubjectSetDigest" CHAR(64),
    "disclosedSubjectCount" INTEGER NOT NULL DEFAULT 0,
    "accessSchemaVersion" SMALLINT NOT NULL DEFAULT 2,
    "accessedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactAccessLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BlockRelation" (
    "campusId" UUID NOT NULL,
    "blockerId" UUID NOT NULL,
    "blockedId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BlockRelation_pkey" PRIMARY KEY ("blockerId","blockedId")
);

-- CreateTable
CREATE TABLE "Report" (
    "id" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "reporterId" UUID NOT NULL,
    "subjectUserId" UUID,
    "groupId" UUID,
    "category" "ReportCategory" NOT NULL,
    "description" VARCHAR(1000) NOT NULL,
    "status" "ReportStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiskEvent" (
    "id" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "ruleCode" VARCHAR(100) NOT NULL,
    "ruleVersion" VARCHAR(50) NOT NULL,
    "evidenceDigest" CHAR(64) NOT NULL,
    "decision" "RiskDecision" NOT NULL,
    "expiresAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RiskEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" VARCHAR(100) NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "availableAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "aggregateType" VARCHAR(100) NOT NULL,
    "aggregateId" UUID NOT NULL,
    "eventType" VARCHAR(100) NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "availableAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastErrorCode" VARCHAR(100),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminUser" (
    "id" UUID NOT NULL,
    "username" VARCHAR(100) NOT NULL,
    "passwordHash" VARCHAR(255) NOT NULL,
    "totpSecretCiphertext" BYTEA NOT NULL,
    "keyVersion" VARCHAR(64) NOT NULL,
    "status" "AdminStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastLoginAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AdminUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminSession" (
    "id" UUID NOT NULL,
    "adminUserId" UUID NOT NULL,
    "sessionTokenHash" CHAR(64) NOT NULL,
    "csrfTokenHash" CHAR(64) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "lastReauthenticatedAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationAssetAccessGrant" (
    "id" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "verificationId" UUID NOT NULL,
    "adminUserId" UUID NOT NULL,
    "adminSessionId" UUID NOT NULL,
    "tokenDigest" CHAR(64) NOT NULL,
    "requestId" VARCHAR(100) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "usedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VerificationAssetAccessGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Role" (
    "id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "description" VARCHAR(255) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminUserRole" (
    "adminUserId" UUID NOT NULL,
    "roleId" UUID NOT NULL,
    "grantedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminUserRole_pkey" PRIMARY KEY ("adminUserId","roleId")
);

-- CreateTable
CREATE TABLE "AdminCampusScope" (
    "adminUserId" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "grantedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminCampusScope_pkey" PRIMARY KEY ("adminUserId","campusId")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" UUID NOT NULL,
    "actorAdminId" UUID,
    "campusId" UUID,
    "action" VARCHAR(100) NOT NULL,
    "targetType" VARCHAR(100) NOT NULL,
    "targetId" UUID,
    "requestId" VARCHAR(100) NOT NULL,
    "beforeDigest" CHAR(64),
    "afterDigest" CHAR(64),
    "reasonCode" VARCHAR(100),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemConfig" (
    "id" UUID NOT NULL,
    "campusId" UUID,
    "key" VARCHAR(100) NOT NULL,
    "version" INTEGER NOT NULL,
    "value" JSONB NOT NULL,
    "effectiveAt" TIMESTAMPTZ(3) NOT NULL,
    "retiredAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SystemConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "id" UUID NOT NULL,
    "campusId" UUID,
    "scope" VARCHAR(100) NOT NULL,
    "key" VARCHAR(128) NOT NULL,
    "userId" UUID,
    "adminUserId" UUID,
    "requestDigest" CHAR(64) NOT NULL,
    "responseStatus" INTEGER,
    "responseCiphertext" BYTEA,
    "keyVersion" VARCHAR(64),
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Campus_status_idx" ON "Campus"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Campus_name_key" ON "Campus"("name");

-- CreateIndex
CREATE UNIQUE INDEX "User_wechatSubject_key" ON "User"("wechatSubject");

-- CreateIndex
CREATE INDEX "User_campusId_status_idx" ON "User"("campusId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "UserSession_refreshTokenHash_key" ON "UserSession"("refreshTokenHash");

-- CreateIndex
CREATE INDEX "UserSession_campusId_userId_expiresAt_idx" ON "UserSession"("campusId", "userId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "UserContact_userId_key" ON "UserContact"("userId");

-- CreateIndex
CREATE INDEX "StudentVerification_userId_status_idx" ON "StudentVerification"("userId", "status");

-- CreateIndex
CREATE INDEX "StudentVerification_campusId_status_submittedAt_idx" ON "StudentVerification"("campusId", "status", "submittedAt");

-- CreateIndex
CREATE UNIQUE INDEX "StudentVerification_campusId_studentNumberDigest_key" ON "StudentVerification"("campusId", "studentNumberDigest");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationAsset_verificationId_key" ON "VerificationAsset"("verificationId");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationAsset_objectKey_key" ON "VerificationAsset"("objectKey");

-- CreateIndex
CREATE INDEX "VerificationAsset_campusId_deleteAfter_deletedAt_idx" ON "VerificationAsset"("campusId", "deleteAfter", "deletedAt");

-- CreateIndex
CREATE INDEX "Place_campusId_status_type_idx" ON "Place"("campusId", "status", "type");

-- CreateIndex
CREATE UNIQUE INDEX "Place_campusId_name_key" ON "Place"("campusId", "name");

-- CreateIndex
CREATE INDEX "Route_campusId_status_idx" ON "Route"("campusId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Route_campusId_originId_destinationId_key" ON "Route"("campusId", "originId", "destinationId");

-- CreateIndex
CREATE INDEX "RouteSchedule_campusId_routeId_activeFrom_activeUntil_idx" ON "RouteSchedule"("campusId", "routeId", "activeFrom", "activeUntil");

-- CreateIndex
CREATE UNIQUE INDEX "RouteSchedule_routeId_weekday_startMinute_endMinute_activeF_key" ON "RouteSchedule"("routeId", "weekday", "startMinute", "endMinute", "activeFrom");

-- CreateIndex
CREATE INDEX "TravelDemand_campusId_routeId_windowStart_status_idx" ON "TravelDemand"("campusId", "routeId", "windowStart", "status");

-- CreateIndex
CREATE INDEX "TravelDemand_userId_windowStart_windowEnd_status_idx" ON "TravelDemand"("userId", "windowStart", "windowEnd", "status");

-- CreateIndex
CREATE INDEX "CompanionGroup_campusId_routeId_windowStart_state_idx" ON "CompanionGroup"("campusId", "routeId", "windowStart", "state");

-- CreateIndex
CREATE UNIQUE INDEX "GroupMember_demandId_key" ON "GroupMember"("demandId");

-- CreateIndex
CREATE INDEX "GroupMember_campusId_userId_status_idx" ON "GroupMember"("campusId", "userId", "status");

-- CreateIndex
CREATE INDEX "GroupMember_campusId_groupId_status_idx" ON "GroupMember"("campusId", "groupId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "GroupMember_groupId_userId_key" ON "GroupMember"("groupId", "userId");

-- CreateIndex
CREATE INDEX "FormationRound_campusId_groupId_state_idx" ON "FormationRound"("campusId", "groupId", "state");

-- CreateIndex
CREATE INDEX "FormationRound_campusId_state_confirmBy_payBy_idx" ON "FormationRound"("campusId", "state", "confirmBy", "payBy");

-- CreateIndex
CREATE UNIQUE INDEX "FormationRound_groupId_sequence_key" ON "FormationRound"("groupId", "sequence");

-- CreateIndex
CREATE INDEX "MemberConfirmation_campusId_userId_decidedAt_idx" ON "MemberConfirmation"("campusId", "userId", "decidedAt");

-- CreateIndex
CREATE UNIQUE INDEX "MemberConfirmation_roundId_userId_key" ON "MemberConfirmation"("roundId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceOrder_merchantOrderNo_key" ON "ServiceOrder"("merchantOrderNo");

-- CreateIndex
CREATE INDEX "ServiceOrder_campusId_userId_status_createdAt_idx" ON "ServiceOrder"("campusId", "userId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "ServiceOrder_campusId_roundId_status_idx" ON "ServiceOrder"("campusId", "roundId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceOrder_roundId_userId_key" ON "ServiceOrder"("roundId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentTransaction_providerTransactionId_key" ON "PaymentTransaction"("providerTransactionId");

-- CreateIndex
CREATE INDEX "PaymentTransaction_campusId_orderId_status_idx" ON "PaymentTransaction"("campusId", "orderId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_providerRefundId_key" ON "Refund"("providerRefundId");

-- CreateIndex
CREATE INDEX "Refund_campusId_orderId_status_idx" ON "Refund"("campusId", "orderId", "status");

-- CreateIndex
CREATE INDEX "Refund_campusId_status_requestedAt_idx" ON "Refund"("campusId", "status", "requestedAt");

-- CreateIndex
CREATE INDEX "PolicyVersion_type_effectiveAt_retiredAt_idx" ON "PolicyVersion"("type", "effectiveAt", "retiredAt");

-- CreateIndex
CREATE UNIQUE INDEX "PolicyVersion_type_version_key" ON "PolicyVersion"("type", "version");

-- CreateIndex
CREATE INDEX "ContactConsent_campusId_userId_grantedAt_idx" ON "ContactConsent"("campusId", "userId", "grantedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ContactConsent_roundId_userId_key" ON "ContactConsent"("roundId", "userId");

-- CreateIndex
CREATE INDEX "ContactUnlock_campusId_viewerId_unlockedAt_idx" ON "ContactUnlock"("campusId", "viewerId", "unlockedAt");

-- CreateIndex
CREATE INDEX "ContactUnlock_campusId_subjectId_unlockedAt_idx" ON "ContactUnlock"("campusId", "subjectId", "unlockedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ContactUnlock_roundId_viewerId_subjectId_key" ON "ContactUnlock"("roundId", "viewerId", "subjectId");

-- CreateIndex
CREATE UNIQUE INDEX "ContactAccessLog_requestId_key" ON "ContactAccessLog"("requestId");

-- CreateIndex
CREATE INDEX "ContactAccessLog_campusId_roundId_accessedAt_idx" ON "ContactAccessLog"("campusId", "roundId", "accessedAt");

-- CreateIndex
CREATE INDEX "ContactAccessLog_campusId_viewerId_accessedAt_idx" ON "ContactAccessLog"("campusId", "viewerId", "accessedAt");

-- CreateIndex
CREATE INDEX "BlockRelation_campusId_blockedId_idx" ON "BlockRelation"("campusId", "blockedId");

-- CreateIndex
CREATE INDEX "Report_campusId_status_createdAt_idx" ON "Report"("campusId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Report_subjectUserId_status_idx" ON "Report"("subjectUserId", "status");

-- CreateIndex
CREATE INDEX "Report_groupId_status_idx" ON "Report"("groupId", "status");

-- CreateIndex
CREATE INDEX "RiskEvent_campusId_decision_createdAt_idx" ON "RiskEvent"("campusId", "decision", "createdAt");

-- CreateIndex
CREATE INDEX "RiskEvent_userId_expiresAt_idx" ON "RiskEvent"("userId", "expiresAt");

-- CreateIndex
CREATE INDEX "Notification_campusId_status_availableAt_idx" ON "Notification"("campusId", "status", "availableAt");

-- CreateIndex
CREATE INDEX "Notification_campusId_userId_createdAt_idx" ON "Notification"("campusId", "userId", "createdAt");

-- CreateIndex
CREATE INDEX "OutboxEvent_campusId_status_availableAt_idx" ON "OutboxEvent"("campusId", "status", "availableAt");

-- CreateIndex
CREATE INDEX "OutboxEvent_campusId_aggregateType_aggregateId_createdAt_idx" ON "OutboxEvent"("campusId", "aggregateType", "aggregateId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AdminUser_username_key" ON "AdminUser"("username");

-- CreateIndex
CREATE UNIQUE INDEX "AdminSession_sessionTokenHash_key" ON "AdminSession"("sessionTokenHash");

-- CreateIndex
CREATE INDEX "AdminSession_adminUserId_expiresAt_revokedAt_idx" ON "AdminSession"("adminUserId", "expiresAt", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationAssetAccessGrant_tokenDigest_key" ON "VerificationAssetAccessGrant"("tokenDigest");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationAssetAccessGrant_requestId_key" ON "VerificationAssetAccessGrant"("requestId");

-- CreateIndex
CREATE INDEX "VerificationAssetAccessGrant_campusId_verificationId_expire_idx" ON "VerificationAssetAccessGrant"("campusId", "verificationId", "expiresAt", "usedAt");

-- CreateIndex
CREATE INDEX "VerificationAssetAccessGrant_adminUserId_createdAt_idx" ON "VerificationAssetAccessGrant"("adminUserId", "createdAt");

-- CreateIndex
CREATE INDEX "VerificationAssetAccessGrant_adminSessionId_expiresAt_usedA_idx" ON "VerificationAssetAccessGrant"("adminSessionId", "expiresAt", "usedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Role_code_key" ON "Role"("code");

-- CreateIndex
CREATE INDEX "AdminCampusScope_campusId_idx" ON "AdminCampusScope"("campusId");

-- CreateIndex
CREATE INDEX "AuditLog_actorAdminId_createdAt_idx" ON "AuditLog"("actorAdminId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_campusId_createdAt_idx" ON "AuditLog"("campusId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_targetType_targetId_createdAt_idx" ON "AuditLog"("targetType", "targetId", "createdAt");

-- CreateIndex
CREATE INDEX "SystemConfig_key_effectiveAt_retiredAt_idx" ON "SystemConfig"("key", "effectiveAt", "retiredAt");

-- CreateIndex
CREATE UNIQUE INDEX "SystemConfig_campusId_key_version_key" ON "SystemConfig"("campusId", "key", "version");

-- CreateIndex
CREATE INDEX "IdempotencyRecord_campusId_expiresAt_idx" ON "IdempotencyRecord"("campusId", "expiresAt");

-- CreateIndex
CREATE INDEX "IdempotencyRecord_campusId_userId_createdAt_idx" ON "IdempotencyRecord"("campusId", "userId", "createdAt");

-- CreateIndex
CREATE INDEX "IdempotencyRecord_campusId_adminUserId_createdAt_idx" ON "IdempotencyRecord"("campusId", "adminUserId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyRecord_scope_key_key" ON "IdempotencyRecord"("scope", "key");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_campusId_fkey" FOREIGN KEY ("campusId") REFERENCES "Campus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSession" ADD CONSTRAINT "UserSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserContact" ADD CONSTRAINT "UserContact_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentVerification" ADD CONSTRAINT "StudentVerification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentVerification" ADD CONSTRAINT "StudentVerification_campusId_fkey" FOREIGN KEY ("campusId") REFERENCES "Campus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentVerification" ADD CONSTRAINT "StudentVerification_consentPolicyId_fkey" FOREIGN KEY ("consentPolicyId") REFERENCES "PolicyVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationAsset" ADD CONSTRAINT "VerificationAsset_verificationId_fkey" FOREIGN KEY ("verificationId") REFERENCES "StudentVerification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Place" ADD CONSTRAINT "Place_campusId_fkey" FOREIGN KEY ("campusId") REFERENCES "Campus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Route" ADD CONSTRAINT "Route_campusId_fkey" FOREIGN KEY ("campusId") REFERENCES "Campus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Route" ADD CONSTRAINT "Route_originId_fkey" FOREIGN KEY ("originId") REFERENCES "Place"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Route" ADD CONSTRAINT "Route_destinationId_fkey" FOREIGN KEY ("destinationId") REFERENCES "Place"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RouteSchedule" ADD CONSTRAINT "RouteSchedule_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "Route"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TravelDemand" ADD CONSTRAINT "TravelDemand_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TravelDemand" ADD CONSTRAINT "TravelDemand_campusId_fkey" FOREIGN KEY ("campusId") REFERENCES "Campus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TravelDemand" ADD CONSTRAINT "TravelDemand_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "Route"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanionGroup" ADD CONSTRAINT "CompanionGroup_campusId_fkey" FOREIGN KEY ("campusId") REFERENCES "Campus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanionGroup" ADD CONSTRAINT "CompanionGroup_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "Route"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupMember" ADD CONSTRAINT "GroupMember_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "CompanionGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupMember" ADD CONSTRAINT "GroupMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupMember" ADD CONSTRAINT "GroupMember_demandId_fkey" FOREIGN KEY ("demandId") REFERENCES "TravelDemand"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FormationRound" ADD CONSTRAINT "FormationRound_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "CompanionGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FormationRound" ADD CONSTRAINT "FormationRound_contactPolicyVersionId_fkey" FOREIGN KEY ("contactPolicyVersionId") REFERENCES "PolicyVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberConfirmation" ADD CONSTRAINT "MemberConfirmation_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "FormationRound"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberConfirmation" ADD CONSTRAINT "MemberConfirmation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceOrder" ADD CONSTRAINT "ServiceOrder_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "FormationRound"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceOrder" ADD CONSTRAINT "ServiceOrder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentTransaction" ADD CONSTRAINT "PaymentTransaction_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "ServiceOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "ServiceOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactConsent" ADD CONSTRAINT "ContactConsent_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "FormationRound"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactConsent" ADD CONSTRAINT "ContactConsent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactConsent" ADD CONSTRAINT "ContactConsent_policyVersionId_fkey" FOREIGN KEY ("policyVersionId") REFERENCES "PolicyVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactUnlock" ADD CONSTRAINT "ContactUnlock_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "FormationRound"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactUnlock" ADD CONSTRAINT "ContactUnlock_viewerId_fkey" FOREIGN KEY ("viewerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactUnlock" ADD CONSTRAINT "ContactUnlock_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactAccessLog" ADD CONSTRAINT "ContactAccessLog_campusId_fkey" FOREIGN KEY ("campusId") REFERENCES "Campus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactAccessLog" ADD CONSTRAINT "ContactAccessLog_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "FormationRound"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactAccessLog" ADD CONSTRAINT "ContactAccessLog_viewerId_fkey" FOREIGN KEY ("viewerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactAccessLog" ADD CONSTRAINT "ContactAccessLog_policyVersionId_fkey" FOREIGN KEY ("policyVersionId") REFERENCES "PolicyVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlockRelation" ADD CONSTRAINT "BlockRelation_blockerId_fkey" FOREIGN KEY ("blockerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlockRelation" ADD CONSTRAINT "BlockRelation_blockedId_fkey" FOREIGN KEY ("blockedId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_campusId_fkey" FOREIGN KEY ("campusId") REFERENCES "Campus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_subjectUserId_fkey" FOREIGN KEY ("subjectUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "CompanionGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiskEvent" ADD CONSTRAINT "RiskEvent_campusId_fkey" FOREIGN KEY ("campusId") REFERENCES "Campus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiskEvent" ADD CONSTRAINT "RiskEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminSession" ADD CONSTRAINT "AdminSession_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "AdminUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationAssetAccessGrant" ADD CONSTRAINT "VerificationAssetAccessGrant_campusId_fkey" FOREIGN KEY ("campusId") REFERENCES "Campus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationAssetAccessGrant" ADD CONSTRAINT "VerificationAssetAccessGrant_verificationId_fkey" FOREIGN KEY ("verificationId") REFERENCES "StudentVerification"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationAssetAccessGrant" ADD CONSTRAINT "VerificationAssetAccessGrant_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationAssetAccessGrant" ADD CONSTRAINT "VerificationAssetAccessGrant_adminSessionId_fkey" FOREIGN KEY ("adminSessionId") REFERENCES "AdminSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminUserRole" ADD CONSTRAINT "AdminUserRole_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "AdminUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminUserRole" ADD CONSTRAINT "AdminUserRole_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminCampusScope" ADD CONSTRAINT "AdminCampusScope_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "AdminUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminCampusScope" ADD CONSTRAINT "AdminCampusScope_campusId_fkey" FOREIGN KEY ("campusId") REFERENCES "Campus"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorAdminId_fkey" FOREIGN KEY ("actorAdminId") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_campusId_fkey" FOREIGN KEY ("campusId") REFERENCES "Campus"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SystemConfig" ADD CONSTRAINT "SystemConfig_campusId_fkey" FOREIGN KEY ("campusId") REFERENCES "Campus"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT "IdempotencyRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT "IdempotencyRecord_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "AdminUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant keys on dependent rows are deliberate denormalization. These direct
-- foreign keys prevent orphaned campus identifiers, while the composite keys
-- below prevent a dependent row from pointing across campus boundaries.
ALTER TABLE "UserSession" ADD CONSTRAINT "UserSession_campusId_fkey" FOREIGN KEY ("campusId") REFERENCES "Campus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "UserContact" ADD CONSTRAINT "UserContact_campusId_fkey" FOREIGN KEY ("campusId") REFERENCES "Campus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VerificationAsset" ADD CONSTRAINT "VerificationAsset_campusId_fkey" FOREIGN KEY ("campusId") REFERENCES "Campus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RouteSchedule" ADD CONSTRAINT "RouteSchedule_campusId_fkey" FOREIGN KEY ("campusId") REFERENCES "Campus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GroupMember" ADD CONSTRAINT "GroupMember_campusId_fkey" FOREIGN KEY ("campusId") REFERENCES "Campus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FormationRound" ADD CONSTRAINT "FormationRound_campusId_fkey" FOREIGN KEY ("campusId") REFERENCES "Campus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MemberConfirmation" ADD CONSTRAINT "MemberConfirmation_campusId_fkey" FOREIGN KEY ("campusId") REFERENCES "Campus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ServiceOrder" ADD CONSTRAINT "ServiceOrder_campusId_fkey" FOREIGN KEY ("campusId") REFERENCES "Campus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentTransaction" ADD CONSTRAINT "PaymentTransaction_campusId_fkey" FOREIGN KEY ("campusId") REFERENCES "Campus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_campusId_fkey" FOREIGN KEY ("campusId") REFERENCES "Campus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ContactConsent" ADD CONSTRAINT "ContactConsent_campusId_fkey" FOREIGN KEY ("campusId") REFERENCES "Campus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ContactUnlock" ADD CONSTRAINT "ContactUnlock_campusId_fkey" FOREIGN KEY ("campusId") REFERENCES "Campus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BlockRelation" ADD CONSTRAINT "BlockRelation_campusId_fkey" FOREIGN KEY ("campusId") REFERENCES "Campus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_campusId_fkey" FOREIGN KEY ("campusId") REFERENCES "Campus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OutboxEvent" ADD CONSTRAINT "OutboxEvent_campusId_fkey" FOREIGN KEY ("campusId") REFERENCES "Campus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT "IdempotencyRecord_campusId_fkey" FOREIGN KEY ("campusId") REFERENCES "Campus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "User_campusId_id_key" ON "User"("campusId", "id");
CREATE UNIQUE INDEX "StudentVerification_campusId_id_key" ON "StudentVerification"("campusId", "id");
CREATE UNIQUE INDEX "Place_campusId_id_key" ON "Place"("campusId", "id");
CREATE UNIQUE INDEX "Route_campusId_id_key" ON "Route"("campusId", "id");
CREATE UNIQUE INDEX "TravelDemand_campusId_id_key" ON "TravelDemand"("campusId", "id");
CREATE UNIQUE INDEX "CompanionGroup_campusId_id_key" ON "CompanionGroup"("campusId", "id");
CREATE UNIQUE INDEX "FormationRound_campusId_id_key" ON "FormationRound"("campusId", "id");
CREATE UNIQUE INDEX "ServiceOrder_campusId_id_key" ON "ServiceOrder"("campusId", "id");

ALTER TABLE "UserSession" ADD CONSTRAINT "UserSession_campus_user_fkey" FOREIGN KEY ("campusId", "userId") REFERENCES "User"("campusId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserContact" ADD CONSTRAINT "UserContact_campus_user_fkey" FOREIGN KEY ("campusId", "userId") REFERENCES "User"("campusId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StudentVerification" ADD CONSTRAINT "StudentVerification_campus_user_fkey" FOREIGN KEY ("campusId", "userId") REFERENCES "User"("campusId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VerificationAsset" ADD CONSTRAINT "VerificationAsset_campus_verification_fkey" FOREIGN KEY ("campusId", "verificationId") REFERENCES "StudentVerification"("campusId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Route" ADD CONSTRAINT "Route_campus_origin_fkey" FOREIGN KEY ("campusId", "originId") REFERENCES "Place"("campusId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Route" ADD CONSTRAINT "Route_campus_destination_fkey" FOREIGN KEY ("campusId", "destinationId") REFERENCES "Place"("campusId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RouteSchedule" ADD CONSTRAINT "RouteSchedule_campus_route_fkey" FOREIGN KEY ("campusId", "routeId") REFERENCES "Route"("campusId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TravelDemand" ADD CONSTRAINT "TravelDemand_campus_user_fkey" FOREIGN KEY ("campusId", "userId") REFERENCES "User"("campusId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TravelDemand" ADD CONSTRAINT "TravelDemand_campus_route_fkey" FOREIGN KEY ("campusId", "routeId") REFERENCES "Route"("campusId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CompanionGroup" ADD CONSTRAINT "CompanionGroup_campus_route_fkey" FOREIGN KEY ("campusId", "routeId") REFERENCES "Route"("campusId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GroupMember" ADD CONSTRAINT "GroupMember_campus_group_fkey" FOREIGN KEY ("campusId", "groupId") REFERENCES "CompanionGroup"("campusId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GroupMember" ADD CONSTRAINT "GroupMember_campus_user_fkey" FOREIGN KEY ("campusId", "userId") REFERENCES "User"("campusId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GroupMember" ADD CONSTRAINT "GroupMember_campus_demand_fkey" FOREIGN KEY ("campusId", "demandId") REFERENCES "TravelDemand"("campusId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FormationRound" ADD CONSTRAINT "FormationRound_campus_group_fkey" FOREIGN KEY ("campusId", "groupId") REFERENCES "CompanionGroup"("campusId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MemberConfirmation" ADD CONSTRAINT "MemberConfirmation_campus_round_fkey" FOREIGN KEY ("campusId", "roundId") REFERENCES "FormationRound"("campusId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MemberConfirmation" ADD CONSTRAINT "MemberConfirmation_campus_user_fkey" FOREIGN KEY ("campusId", "userId") REFERENCES "User"("campusId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ServiceOrder" ADD CONSTRAINT "ServiceOrder_campus_round_fkey" FOREIGN KEY ("campusId", "roundId") REFERENCES "FormationRound"("campusId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ServiceOrder" ADD CONSTRAINT "ServiceOrder_campus_user_fkey" FOREIGN KEY ("campusId", "userId") REFERENCES "User"("campusId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentTransaction" ADD CONSTRAINT "PaymentTransaction_campus_order_fkey" FOREIGN KEY ("campusId", "orderId") REFERENCES "ServiceOrder"("campusId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_campus_order_fkey" FOREIGN KEY ("campusId", "orderId") REFERENCES "ServiceOrder"("campusId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ContactConsent" ADD CONSTRAINT "ContactConsent_campus_round_fkey" FOREIGN KEY ("campusId", "roundId") REFERENCES "FormationRound"("campusId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContactConsent" ADD CONSTRAINT "ContactConsent_campus_user_fkey" FOREIGN KEY ("campusId", "userId") REFERENCES "User"("campusId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ContactUnlock" ADD CONSTRAINT "ContactUnlock_campus_round_fkey" FOREIGN KEY ("campusId", "roundId") REFERENCES "FormationRound"("campusId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ContactUnlock" ADD CONSTRAINT "ContactUnlock_campus_viewer_fkey" FOREIGN KEY ("campusId", "viewerId") REFERENCES "User"("campusId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ContactUnlock" ADD CONSTRAINT "ContactUnlock_campus_subject_fkey" FOREIGN KEY ("campusId", "subjectId") REFERENCES "User"("campusId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BlockRelation" ADD CONSTRAINT "BlockRelation_campus_blocker_fkey" FOREIGN KEY ("campusId", "blockerId") REFERENCES "User"("campusId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BlockRelation" ADD CONSTRAINT "BlockRelation_campus_blocked_fkey" FOREIGN KEY ("campusId", "blockedId") REFERENCES "User"("campusId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Report" ADD CONSTRAINT "Report_campus_reporter_fkey" FOREIGN KEY ("campusId", "reporterId") REFERENCES "User"("campusId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Report" ADD CONSTRAINT "Report_campus_subject_fkey" FOREIGN KEY ("campusId", "subjectUserId") REFERENCES "User"("campusId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Report" ADD CONSTRAINT "Report_campus_group_fkey" FOREIGN KEY ("campusId", "groupId") REFERENCES "CompanionGroup"("campusId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RiskEvent" ADD CONSTRAINT "RiskEvent_campus_user_fkey" FOREIGN KEY ("campusId", "userId") REFERENCES "User"("campusId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_campus_user_fkey" FOREIGN KEY ("campusId", "userId") REFERENCES "User"("campusId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT "IdempotencyRecord_campus_user_fkey" FOREIGN KEY ("campusId", "userId") REFERENCES "User"("campusId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Local row invariants remain enforced even if an application path is flawed.
ALTER TABLE "StudentVerification" ADD CONSTRAINT "StudentVerification_last4_length_check" CHECK (char_length("studentNumberLast4") = 4);
ALTER TABLE "VerificationAsset" ADD CONSTRAINT "VerificationAsset_size_check" CHECK ("sizeBytes" IS NULL OR "sizeBytes" > 0);
ALTER TABLE "VerificationAsset" ADD CONSTRAINT "VerificationAsset_lifecycle_check" CHECK ("deleteAfter" > "createdAt" AND ("deletedAt" IS NULL OR "deletedAt" >= "createdAt"));
ALTER TABLE "Route" ADD CONSTRAINT "Route_distinct_places_check" CHECK ("originId" <> "destinationId");
ALTER TABLE "RouteSchedule" ADD CONSTRAINT "RouteSchedule_weekday_check" CHECK ("weekday" BETWEEN 1 AND 7);
ALTER TABLE "RouteSchedule" ADD CONSTRAINT "RouteSchedule_minutes_check" CHECK ("startMinute" BETWEEN 0 AND 1439 AND "endMinute" BETWEEN 1 AND 1440 AND "startMinute" < "endMinute" AND "windowMinutes" BETWEEN 5 AND 120);
ALTER TABLE "RouteSchedule" ADD CONSTRAINT "RouteSchedule_active_dates_check" CHECK ("activeUntil" IS NULL OR "activeUntil" >= "activeFrom");
ALTER TABLE "TravelDemand" ADD CONSTRAINT "TravelDemand_seat_count_check" CHECK ("seatCount" BETWEEN 1 AND 3);
ALTER TABLE "TravelDemand" ADD CONSTRAINT "TravelDemand_window_check" CHECK ("windowEnd" > "windowStart");
ALTER TABLE "CompanionGroup" ADD CONSTRAINT "CompanionGroup_window_check" CHECK ("windowEnd" > "windowStart");
ALTER TABLE "CompanionGroup" ADD CONSTRAINT "CompanionGroup_version_check" CHECK ("version" >= 1);
ALTER TABLE "GroupMember" ADD CONSTRAINT "GroupMember_seat_count_check" CHECK ("seatCount" BETWEEN 1 AND 3);
ALTER TABLE "FormationRound" ADD CONSTRAINT "FormationRound_sequence_check" CHECK ("sequence" >= 1);
ALTER TABLE "FormationRound" ADD CONSTRAINT "FormationRound_deadlines_check" CHECK ("confirmBy" > "createdAt" AND ("payBy" IS NULL OR "payBy" > "createdAt"));
ALTER TABLE "ServiceOrder" ADD CONSTRAINT "ServiceOrder_price_check" CHECK ("amountFen" = 99 AND "currency" = 'CNY');
ALTER TABLE "ServiceOrder" ADD CONSTRAINT "ServiceOrder_expiry_check" CHECK ("expiresAt" > "createdAt");
ALTER TABLE "PaymentTransaction" ADD CONSTRAINT "PaymentTransaction_occurred_check" CHECK ("occurredAt" IS NULL OR "occurredAt" >= "createdAt");
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_amount_check" CHECK ("amountFen" BETWEEN 1 AND 99);
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_lifecycle_check" CHECK ("completedAt" IS NULL OR "completedAt" >= "requestedAt");
ALTER TABLE "ContactConsent" ADD CONSTRAINT "ContactConsent_lifecycle_check" CHECK ("revokedAt" IS NULL OR "revokedAt" >= "grantedAt");
ALTER TABLE "ContactUnlock" ADD CONSTRAINT "ContactUnlock_distinct_users_check" CHECK ("viewerId" <> "subjectId");
ALTER TABLE "BlockRelation" ADD CONSTRAINT "BlockRelation_distinct_users_check" CHECK ("blockerId" <> "blockedId");
ALTER TABLE "Report" ADD CONSTRAINT "Report_target_check" CHECK ("subjectUserId" IS NOT NULL OR "groupId" IS NOT NULL);
ALTER TABLE "Report" ADD CONSTRAINT "Report_distinct_subject_check" CHECK ("subjectUserId" IS NULL OR "reporterId" <> "subjectUserId");
ALTER TABLE "RiskEvent" ADD CONSTRAINT "RiskEvent_expiry_check" CHECK ("expiresAt" IS NULL OR "expiresAt" > "createdAt");
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_attempts_check" CHECK ("attempts" >= 0);
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_sent_check" CHECK ("sentAt" IS NULL OR "sentAt" >= "createdAt");
ALTER TABLE "OutboxEvent" ADD CONSTRAINT "OutboxEvent_attempts_check" CHECK ("attempts" >= 0);
ALTER TABLE "OutboxEvent" ADD CONSTRAINT "OutboxEvent_published_check" CHECK ("publishedAt" IS NULL OR "publishedAt" >= "createdAt");
ALTER TABLE "SystemConfig" ADD CONSTRAINT "SystemConfig_version_check" CHECK ("version" >= 1);
ALTER TABLE "SystemConfig" ADD CONSTRAINT "SystemConfig_lifecycle_check" CHECK ("retiredAt" IS NULL OR "retiredAt" > "effectiveAt");
ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT "IdempotencyRecord_actor_check" CHECK (num_nonnulls("userId", "adminUserId") = 1);
ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT "IdempotencyRecord_user_campus_check" CHECK ("userId" IS NULL OR "campusId" IS NOT NULL);
ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT "IdempotencyRecord_response_check" CHECK (("responseCiphertext" IS NULL) = ("keyVersion" IS NULL) AND ("responseStatus" IS NULL OR "responseStatus" BETWEEN 100 AND 599));
ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT "IdempotencyRecord_expiry_check" CHECK ("expiresAt" > "createdAt");

CREATE UNIQUE INDEX "SystemConfig_global_key_version_key" ON "SystemConfig"("key", "version") WHERE "campusId" IS NULL;
CREATE UNIQUE INDEX "FormationRound_one_active_per_group_key" ON "FormationRound"("groupId") WHERE "state" IN ('CONFIRMING', 'PAYING', 'REFUNDING', 'REFUND_RETRY');

-- Serialize concurrent member writes on the parent group and reject any write
-- that would create a fifth active seat. M3 still performs the same check in
-- the application transaction; this trigger is the final database guard.
CREATE FUNCTION "enforce_group_seat_limit"() RETURNS trigger AS $$
DECLARE
  occupied_seats integer;
BEGIN
  IF NEW."status" IN ('JOINED', 'CONFIRMED', 'PAYMENT_PENDING', 'PAID', 'CONTACT_UNLOCKED') THEN
    PERFORM 1 FROM "CompanionGroup" WHERE "id" = NEW."groupId" FOR UPDATE;

    SELECT COALESCE(SUM("seatCount"), 0)
      INTO occupied_seats
      FROM "GroupMember"
     WHERE "groupId" = NEW."groupId"
       AND "id" <> NEW."id"
       AND "status" IN ('JOINED', 'CONFIRMED', 'PAYMENT_PENDING', 'PAID', 'CONTACT_UNLOCKED');

    IF occupied_seats + NEW."seatCount" > 4 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'GroupMember_group_seat_limit_check',
        MESSAGE = 'active group seats cannot exceed four';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "GroupMember_group_seat_limit_trigger"
BEFORE INSERT OR UPDATE OF "groupId", "seatCount", "status" ON "GroupMember"
FOR EACH ROW EXECUTE FUNCTION "enforce_group_seat_limit"();

-- Final-state policy seed. This baseline starts from an empty database, so no
-- compatibility lookup or data backfill is required.
INSERT INTO "PolicyVersion" (
  "id", "type", "version", "contentDigest", "effectiveAt", "createdAt"
) VALUES (
  '00000000-0000-0000-0000-00000000c001',
  'CONTACT_SHARING',
  'contact-sharing-v1',
  '0edb7bc14901dc477cae840e4e5dc5dd4d6933610f950f7f0999cc0fd89bf9b6',
  TIMESTAMPTZ '2026-07-14 00:00:00+08',
  NOW()
);

-- Cross-field invariants that Prisma Schema cannot express.
ALTER TABLE "VerificationAsset"
  ADD CONSTRAINT "VerificationAsset_upload_window_check"
  CHECK ("uploadExpiresAt" > "createdAt" AND "uploadExpiresAt" <= "deleteAfter");

ALTER TABLE "StudentVerification"
  ADD CONSTRAINT "StudentVerification_state_time_check"
  CHECK (
    (
      "status"::text IN ('AWAITING_UPLOAD', 'UPLOAD_EXPIRED') AND
      "submittedAt" IS NULL AND
      "latestSubmittedAt" IS NULL AND
      "reviewedAt" IS NULL AND
      "expiresAt" IS NULL
    ) OR (
      "status"::text = 'PENDING' AND
      "submittedAt" IS NOT NULL AND
      "latestSubmittedAt" IS NOT NULL AND
      "latestSubmittedAt" = "submittedAt" AND
      "reviewedAt" IS NULL AND
      "expiresAt" IS NULL
    ) OR (
      "status"::text IN (
        'REJECTED', 'REQUIRE_RESUBMISSION',
        'RESUBMISSION_AWAITING_UPLOAD', 'RESUBMISSION_PENDING'
      ) AND
      "submittedAt" IS NOT NULL AND
      "latestSubmittedAt" IS NOT NULL AND
      "latestSubmittedAt" >= "submittedAt" AND
      "reviewedAt" IS NOT NULL AND
      "expiresAt" IS NULL
    ) OR (
      "status"::text IN ('VERIFIED', 'VERIFICATION_EXPIRED') AND
      "submittedAt" IS NOT NULL AND
      "latestSubmittedAt" IS NOT NULL AND
      "latestSubmittedAt" >= "submittedAt" AND
      "reviewedAt" IS NOT NULL AND
      "expiresAt" IS NOT NULL AND
      "expiresAt" > "reviewedAt"
    )
  );

ALTER TABLE "ContactAccessLog"
  ADD CONSTRAINT "ContactAccessLog_outcome_check"
  CHECK (
    ("outcome" = 'GRANTED' AND "denialCode" IS NULL) OR
    ("outcome" = 'DENIED' AND "denialCode" IS NOT NULL)
  ),
  ADD CONSTRAINT "ContactAccessLog_disclosure_evidence_check"
  CHECK (
    "accessSchemaVersion" = 2 AND (
      (
        "outcome" = 'GRANTED' AND
        "denialCode" IS NULL AND
        "disclosedSubjectSetDigest" IS NOT NULL AND
        "disclosedSubjectCount" BETWEEN 1 AND 3
      ) OR (
        "outcome" = 'DENIED' AND
        "denialCode" IS NOT NULL AND
        "disclosedSubjectSetDigest" IS NULL AND
        "disclosedSubjectCount" = 0
      )
    )
  );

ALTER TABLE "AdminSession"
  ADD CONSTRAINT "AdminSession_lifetime_check"
  CHECK (
    "expiresAt" > "createdAt" AND
    "lastReauthenticatedAt" <= "expiresAt" AND
    "rotatedAt" >= "createdAt"
  );

ALTER TABLE "VerificationAssetAccessGrant"
  ADD CONSTRAINT "VerificationAssetAccessGrant_lifetime_check"
  CHECK (
    "expiresAt" > "createdAt" AND
    "expiresAt" <= "createdAt" + INTERVAL '60 seconds' AND
    ("usedAt" IS NULL OR "usedAt" BETWEEN "createdAt" AND "expiresAt")
  );

-- Composite tenant foreign keys close cross-campus reference paths.
ALTER TABLE "ContactAccessLog"
  ADD CONSTRAINT "ContactAccessLog_campus_round_fkey"
  FOREIGN KEY ("campusId", "roundId") REFERENCES "FormationRound"("campusId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ContactAccessLog"
  ADD CONSTRAINT "ContactAccessLog_campus_viewer_fkey"
  FOREIGN KEY ("campusId", "viewerId") REFERENCES "User"("campusId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VerificationAssetAccessGrant"
  ADD CONSTRAINT "VerificationAssetAccessGrant_campus_verification_fkey"
  FOREIGN KEY ("campusId", "verificationId")
  REFERENCES "StudentVerification"("campusId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- A consumed administrator material grant can never be made reusable.
CREATE FUNCTION "prevent_verification_asset_grant_reuse"()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."usedAt" IS NOT NULL AND NEW."usedAt" IS DISTINCT FROM OLD."usedAt" THEN
    RAISE EXCEPTION 'verification asset access grant has already been consumed'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "VerificationAssetAccessGrant_usedAt_immutable_trigger"
BEFORE UPDATE OF "usedAt" ON "VerificationAssetAccessGrant"
FOR EACH ROW EXECUTE FUNCTION "prevent_verification_asset_grant_reuse"();

CREATE FUNCTION "consume_verification_asset_access_grant"(
  p_token_digest CHAR(64),
  p_admin_session_id UUID,
  p_campus_id UUID,
  p_audit_id UUID,
  p_request_id VARCHAR(100)
)
RETURNS TABLE (
  "grantId" UUID,
  "verificationId" UUID,
  "adminUserId" UUID
) AS $$
DECLARE
  consumed_grant_id UUID;
  consumed_verification_id UUID;
  consumed_admin_user_id UUID;
BEGIN
  UPDATE "VerificationAssetAccessGrant" grant_row
     SET "usedAt" = CURRENT_TIMESTAMP
   WHERE grant_row."tokenDigest" = p_token_digest
     AND grant_row."adminSessionId" = p_admin_session_id
     AND grant_row."campusId" = p_campus_id
     AND grant_row."usedAt" IS NULL
     AND grant_row."expiresAt" > CURRENT_TIMESTAMP
     AND EXISTS (
       SELECT 1
         FROM "AdminSession" session_row
        WHERE session_row."id" = grant_row."adminSessionId"
          AND session_row."adminUserId" = grant_row."adminUserId"
          AND session_row."revokedAt" IS NULL
          AND session_row."expiresAt" > CURRENT_TIMESTAMP
     )
     AND EXISTS (
       SELECT 1
         FROM "VerificationAsset" asset_row
        WHERE asset_row."verificationId" = grant_row."verificationId"
          AND asset_row."deletedAt" IS NULL
          AND asset_row."deleteAfter" > CURRENT_TIMESTAMP
     )
  RETURNING grant_row."id", grant_row."verificationId", grant_row."adminUserId"
       INTO consumed_grant_id, consumed_verification_id, consumed_admin_user_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  INSERT INTO "AuditLog" (
    "id", "actorAdminId", "campusId", "action", "targetType", "targetId",
    "requestId", "afterDigest", "reasonCode"
  ) VALUES (
    p_audit_id, consumed_admin_user_id, p_campus_id,
    'VERIFICATION_ASSET_GRANT_CONSUMED', 'StudentVerification',
    consumed_verification_id, p_request_id, p_token_digest,
    'SINGLE_USE_PROXY_ACCESS'
  );

  RETURN QUERY
  SELECT consumed_grant_id, consumed_verification_id, consumed_admin_user_id;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;

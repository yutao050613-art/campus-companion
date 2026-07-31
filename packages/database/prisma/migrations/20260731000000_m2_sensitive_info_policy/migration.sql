-- M2 additive migration: typed verification evidence, exact-asset grants, review-aware retention,
-- and the reviewed sensitive-information consent text. The released M1 migration is untouched.

CREATE TYPE "VerificationAssetType" AS ENUM ('STUDENT_CARD', 'WECOM_SCREENSHOT');

ALTER TABLE "VerificationAsset"
  ADD COLUMN "type" "VerificationAssetType" NOT NULL DEFAULT 'STUDENT_CARD',
  ADD COLUMN "deletionClaimedAt" TIMESTAMPTZ(3),
  ALTER COLUMN "deleteAfter" DROP NOT NULL;

DROP INDEX "VerificationAsset_verificationId_key";
CREATE UNIQUE INDEX "VerificationAsset_verificationId_type_key"
  ON "VerificationAsset"("verificationId", "type");
CREATE UNIQUE INDEX "VerificationAsset_campusId_verificationId_id_key"
  ON "VerificationAsset"("campusId", "verificationId", "id");
CREATE INDEX "VerificationAsset_deleteAfter_deletionClaimedAt_deletedAt_idx"
  ON "VerificationAsset"("deleteAfter", "deletionClaimedAt", "deletedAt");

ALTER TABLE "VerificationAssetAccessGrant"
  ADD COLUMN "verificationAssetId" UUID;

UPDATE "VerificationAssetAccessGrant" grant_row
   SET "verificationAssetId" = asset_row."id"
  FROM "VerificationAsset" asset_row
 WHERE asset_row."verificationId" = grant_row."verificationId";

ALTER TABLE "VerificationAssetAccessGrant"
  ALTER COLUMN "verificationAssetId" SET NOT NULL,
  ADD CONSTRAINT "VerificationAssetAccessGrant_verificationAssetId_fkey"
    FOREIGN KEY ("verificationAssetId") REFERENCES "VerificationAsset"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "VerificationAssetAccessGrant_exact_asset_fkey"
    FOREIGN KEY ("campusId", "verificationId", "verificationAssetId")
    REFERENCES "VerificationAsset"("campusId", "verificationId", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "VerificationAssetAccessGrant_verificationAssetId_expiresAt_usedAt_idx"
  ON "VerificationAssetAccessGrant"("verificationAssetId", "expiresAt", "usedAt");

DROP FUNCTION "consume_verification_asset_access_grant"(CHAR(64), UUID, UUID, UUID, VARCHAR(100));

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
  "verificationAssetId" UUID,
  "adminUserId" UUID
) AS $$
DECLARE
  consumed_grant_id UUID;
  consumed_verification_id UUID;
  consumed_verification_asset_id UUID;
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
        WHERE asset_row."id" = grant_row."verificationAssetId"
          AND asset_row."verificationId" = grant_row."verificationId"
          AND asset_row."campusId" = grant_row."campusId"
          AND asset_row."deletedAt" IS NULL
          AND asset_row."deletionClaimedAt" IS NULL
          AND (asset_row."deleteAfter" IS NULL OR asset_row."deleteAfter" > CURRENT_TIMESTAMP)
     )
  RETURNING grant_row."id", grant_row."verificationId", grant_row."verificationAssetId",
            grant_row."adminUserId"
       INTO consumed_grant_id, consumed_verification_id, consumed_verification_asset_id,
            consumed_admin_user_id;

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
  SELECT consumed_grant_id, consumed_verification_id, consumed_verification_asset_id,
         consumed_admin_user_id;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;

INSERT INTO "PolicyVersion" (
  "id",
  "type",
  "version",
  "contentDigest",
  "effectiveAt"
) VALUES (
  '00000000-0000-0000-0000-00000000c002',
  'SENSITIVE_INFO',
  'sensitive-info-v1',
  '46035097382e2f7435307106825cc0f2cc2a94a98e767b597a48488ee73918a7',
  '2026-07-31T00:00:00.000Z'
);

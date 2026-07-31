export const expectedDatabaseObjectInventory = {
  verificationStatuses: [
    "AWAITING_UPLOAD",
    "UPLOAD_EXPIRED",
    "PENDING",
    "VERIFIED",
    "REJECTED",
    "REQUIRE_RESUBMISSION",
    "RESUBMISSION_AWAITING_UPLOAD",
    "RESUBMISSION_PENDING",
    "VERIFICATION_EXPIRED",
  ],
  constraints: [
    "ContactAccessLog_disclosure_evidence_check",
    "ContactAccessLog_outcome_check",
    "GroupMember_campusId_fkey",
    "GroupMember_campus_demand_fkey",
    "GroupMember_campus_group_fkey",
    "GroupMember_campus_user_fkey",
    "ServiceOrder_campusId_fkey",
    "ServiceOrder_campus_round_fkey",
    "ServiceOrder_campus_user_fkey",
    "StudentVerification_last4_length_check",
    "StudentVerification_state_time_check",
    "VerificationAssetAccessGrant_exact_asset_fkey",
    "VerificationAssetAccessGrant_lifetime_check",
    "VerificationAssetAccessGrant_verificationAssetId_fkey",
  ],
  functions: [
    "consume_verification_asset_access_grant",
    "enforce_group_seat_limit",
    "prevent_verification_asset_grant_reuse",
  ],
  triggers: [
    "GroupMember_group_seat_limit_trigger",
    "VerificationAssetAccessGrant_usedAt_immutable_trigger",
  ],
} as const;

export const databaseObjectInventorySql = {
  verificationStatuses: `
    SELECT enum_value.enumlabel
      FROM pg_enum enum_value
      JOIN pg_type enum_type ON enum_type.oid = enum_value.enumtypid
      JOIN pg_namespace enum_namespace ON enum_namespace.oid = enum_type.typnamespace
     WHERE enum_namespace.nspname = 'public'
       AND enum_type.typname = 'VerificationStatus'
     ORDER BY enum_value.enumsortorder
  `,
  constraints: `
    SELECT constraint_object.conname
      FROM pg_constraint constraint_object
      JOIN pg_namespace constraint_namespace
        ON constraint_namespace.oid = constraint_object.connamespace
     WHERE constraint_namespace.nspname = 'public'
       AND (
         constraint_object.conname LIKE 'GroupMember_campus_%_fkey'
         OR constraint_object.conname LIKE 'ServiceOrder_campus_%_fkey'
         OR constraint_object.conname LIKE 'StudentVerification_%_check'
         OR constraint_object.conname LIKE 'ContactAccessLog_%_check'
         OR constraint_object.conname = 'VerificationAssetAccessGrant_lifetime_check'
         OR constraint_object.conname IN (
           'VerificationAssetAccessGrant_exact_asset_fkey',
           'VerificationAssetAccessGrant_verificationAssetId_fkey'
         )
       )
     ORDER BY constraint_object.conname
  `,
  functions: `
    SELECT function_object.proname
      FROM pg_proc function_object
      JOIN pg_namespace function_namespace
        ON function_namespace.oid = function_object.pronamespace
     WHERE function_namespace.nspname = 'public'
       AND (
         function_object.proname LIKE '%group_seat%'
         OR function_object.proname LIKE '%verification_asset%'
       )
     ORDER BY function_object.proname
  `,
  triggers: `
    SELECT trigger_object.tgname
      FROM pg_trigger trigger_object
      JOIN pg_class trigger_table ON trigger_table.oid = trigger_object.tgrelid
      JOIN pg_namespace trigger_namespace ON trigger_namespace.oid = trigger_table.relnamespace
     WHERE trigger_namespace.nspname = 'public'
       AND NOT trigger_object.tgisinternal
       AND (
         trigger_object.tgname LIKE 'GroupMember_%'
         OR trigger_object.tgname LIKE 'VerificationAssetAccessGrant_%'
       )
     ORDER BY trigger_object.tgname
  `,
} as const;

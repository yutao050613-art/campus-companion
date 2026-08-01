-- M4 adds last-line guards for server-priced orders and delivered contact grants.
-- The richer all-member checks are performed in serializable application transactions.

CREATE UNIQUE INDEX "Refund_orderId_reason_key" ON "Refund"("orderId", "reason");

-- A provider can report a successful payment before this service writes its
-- immutable receipt row. The M1 check incorrectly assumed the inverse order,
-- which rejects valid payment evidence under normal network latency.
ALTER TABLE "PaymentTransaction" DROP CONSTRAINT "PaymentTransaction_occurred_check";

CREATE OR REPLACE FUNCTION "enforce_m4_service_order_guard"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Let the released price CHECK own malformed prices, so diagnostics remain stable.
  IF NEW."amountFen" <> 99 OR NEW."currency" <> 'CNY' THEN
    RETURN NEW;
  END IF;

  PERFORM 1
  FROM "FormationRound" round_row
  JOIN "CompanionGroup" group_row ON group_row."id" = round_row."groupId"
  JOIN "GroupMember" member_row
    ON member_row."groupId" = round_row."groupId"
   AND member_row."userId" = NEW."userId"
   AND member_row."campusId" = NEW."campusId"
  WHERE round_row."id" = NEW."roundId"
    AND round_row."campusId" = NEW."campusId"
    AND round_row."state" = 'PAYING'
    AND round_row."payBy" = NEW."expiresAt"
    AND round_row."payBy" IS NOT NULL
    AND group_row."campusId" = NEW."campusId"
    AND group_row."state" = 'PAYING'
    AND member_row."status" = 'PAYMENT_PENDING';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'M4 service order requires matching PAYING round, group, member and deadline'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ServiceOrder_m4_paying_guard"
BEFORE INSERT ON "ServiceOrder"
FOR EACH ROW EXECUTE FUNCTION "enforce_m4_service_order_guard"();

CREATE OR REPLACE FUNCTION "enforce_m4_contact_unlock_guard"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM 1
  FROM "FormationRound" round_row
  JOIN "CompanionGroup" group_row ON group_row."id" = round_row."groupId"
  JOIN "GroupMember" viewer_member
    ON viewer_member."groupId" = round_row."groupId"
   AND viewer_member."userId" = NEW."viewerId"
   AND viewer_member."campusId" = NEW."campusId"
  JOIN "GroupMember" subject_member
    ON subject_member."groupId" = round_row."groupId"
   AND subject_member."userId" = NEW."subjectId"
   AND subject_member."campusId" = NEW."campusId"
  WHERE round_row."id" = NEW."roundId"
    AND round_row."campusId" = NEW."campusId"
    AND round_row."state" = 'DELIVERED'
    AND group_row."campusId" = NEW."campusId"
    AND group_row."state" = 'CONTACTS_UNLOCKED'
    AND viewer_member."status" = 'CONTACT_UNLOCKED'
    AND subject_member."status" = 'CONTACT_UNLOCKED'
    AND NEW."viewerId" <> NEW."subjectId";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'M4 contact unlock requires delivered matching members'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ContactUnlock_m4_delivery_guard"
BEFORE INSERT ON "ContactUnlock"
FOR EACH ROW EXECUTE FUNCTION "enforce_m4_contact_unlock_guard"();

-- M5 adds a durable, privacy-minimized payment-provider event ledger.
-- Provider events are written before internal settlement. An unclassified,
-- signed event is intentionally allowed to have no campus until reconciliation
-- binds it to an order or refund; it can never be marked APPLIED in that state.

CREATE TYPE "ProviderEventStatus" AS ENUM ('RECEIVED', 'APPLIED', 'REVIEW_REQUIRED', 'REJECTED');
CREATE TYPE "ReconciliationStatus" AS ENUM ('OPEN', 'RESOLVED');

ALTER TABLE "PaymentTransaction"
  ADD COLUMN "providerEventId" UUID;

ALTER TABLE "Refund"
  ADD COLUMN "merchantRefundNo" VARCHAR(64),
  ADD COLUMN "providerEventId" UUID;

-- Existing databases may contain historical mock refunds. A deterministic,
-- non-secret identifier makes the additive migration safe before the new
-- non-null contract is enabled. New Prisma writes use UUIDs directly.
UPDATE "Refund"
   SET "merchantRefundNo" = 'legacy_' || REPLACE("id"::text, '-', '')
 WHERE "merchantRefundNo" IS NULL;

ALTER TABLE "Refund"
  ALTER COLUMN "merchantRefundNo" SET NOT NULL;

CREATE TABLE "ProviderEvent" (
  "id" UUID NOT NULL,
  "campusId" UUID,
  "provider" "PaymentProvider" NOT NULL,
  "eventId" VARCHAR(128) NOT NULL,
  "eventType" VARCHAR(100) NOT NULL,
  "verifierKeyId" VARCHAR(128) NOT NULL,
  "rawDigest" CHAR(64) NOT NULL,
  "merchantOrderNo" VARCHAR(64),
  "merchantRefundNo" VARCHAR(64),
  "providerTransactionId" VARCHAR(128),
  "providerRefundId" VARCHAR(128),
  "amountFen" INTEGER NOT NULL,
  "currency" CHAR(3) NOT NULL,
  "occurredAt" TIMESTAMPTZ(3),
  "status" "ProviderEventStatus" NOT NULL DEFAULT 'RECEIVED',
  "appliedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "orderId" UUID,
  "refundId" UUID,

  CONSTRAINT "ProviderEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProviderEvent_provider_eventId_key" UNIQUE ("provider", "eventId"),
  CONSTRAINT "ProviderEvent_provider_check" CHECK ("provider" = 'WECHAT_PAY'),
  CONSTRAINT "ProviderEvent_digest_check" CHECK ("rawDigest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "ProviderEvent_reference_check"
    CHECK ("merchantOrderNo" IS NOT NULL OR "merchantRefundNo" IS NOT NULL),
  CONSTRAINT "ProviderEvent_amount_check" CHECK ("amountFen" BETWEEN 1 AND 100000000 AND "currency" = 'CNY'),
  CONSTRAINT "ProviderEvent_status_time_check" CHECK (
    ("status" = 'RECEIVED' AND "appliedAt" IS NULL) OR
    ("status" = 'APPLIED' AND "appliedAt" IS NOT NULL) OR
    ("status" IN ('REVIEW_REQUIRED', 'REJECTED') AND "appliedAt" IS NULL)
  )
);

CREATE TABLE "ReconciliationException" (
  "id" UUID NOT NULL,
  "campusId" UUID,
  "providerEventId" UUID,
  "orderId" UUID,
  "refundId" UUID,
  "code" VARCHAR(100) NOT NULL,
  "expectedDigest" CHAR(64),
  "observedDigest" CHAR(64),
  "status" "ReconciliationStatus" NOT NULL DEFAULT 'OPEN',
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMPTZ(3),

  CONSTRAINT "ReconciliationException_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ReconciliationException_providerEventId_key" UNIQUE ("providerEventId"),
  CONSTRAINT "ReconciliationException_evidence_check"
    CHECK ("expectedDigest" IS NOT NULL OR "observedDigest" IS NOT NULL),
  CONSTRAINT "ReconciliationException_lifecycle_check" CHECK (
    ("status" = 'OPEN' AND "resolvedAt" IS NULL) OR
    ("status" = 'RESOLVED' AND "resolvedAt" >= "createdAt")
  )
);

CREATE UNIQUE INDEX "PaymentTransaction_providerEventId_key"
  ON "PaymentTransaction"("providerEventId");
CREATE UNIQUE INDEX "Refund_merchantRefundNo_key"
  ON "Refund"("merchantRefundNo");
CREATE UNIQUE INDEX "Refund_providerEventId_key"
  ON "Refund"("providerEventId");
CREATE INDEX "ProviderEvent_campusId_status_createdAt_idx"
  ON "ProviderEvent"("campusId", "status", "createdAt");
CREATE INDEX "ProviderEvent_campusId_merchantOrderNo_createdAt_idx"
  ON "ProviderEvent"("campusId", "merchantOrderNo", "createdAt");
CREATE INDEX "ProviderEvent_campusId_merchantRefundNo_createdAt_idx"
  ON "ProviderEvent"("campusId", "merchantRefundNo", "createdAt");
CREATE INDEX "ProviderEvent_orderId_createdAt_idx"
  ON "ProviderEvent"("orderId", "createdAt");
CREATE INDEX "ProviderEvent_refundId_createdAt_idx"
  ON "ProviderEvent"("refundId", "createdAt");
CREATE INDEX "ReconciliationException_campusId_status_createdAt_idx"
  ON "ReconciliationException"("campusId", "status", "createdAt");

CREATE INDEX "Report_reporterId_createdAt_idx"
  ON "Report"("reporterId", "createdAt");
CREATE INDEX "ReconciliationException_orderId_status_createdAt_idx"
  ON "ReconciliationException"("orderId", "status", "createdAt");
CREATE INDEX "ReconciliationException_refundId_status_createdAt_idx"
  ON "ReconciliationException"("refundId", "status", "createdAt");

ALTER TABLE "PaymentTransaction"
  ADD CONSTRAINT "PaymentTransaction_providerEventId_fkey"
  FOREIGN KEY ("providerEventId") REFERENCES "ProviderEvent"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Refund"
  ADD CONSTRAINT "Refund_providerEventId_fkey"
  FOREIGN KEY ("providerEventId") REFERENCES "ProviderEvent"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProviderEvent"
  ADD CONSTRAINT "ProviderEvent_campusId_fkey"
  FOREIGN KEY ("campusId") REFERENCES "Campus"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ProviderEvent_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "ServiceOrder"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ProviderEvent_refundId_fkey"
  FOREIGN KEY ("refundId") REFERENCES "Refund"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReconciliationException"
  ADD CONSTRAINT "ReconciliationException_campusId_fkey"
  FOREIGN KEY ("campusId") REFERENCES "Campus"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ReconciliationException_providerEventId_fkey"
  FOREIGN KEY ("providerEventId") REFERENCES "ProviderEvent"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ReconciliationException_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "ServiceOrder"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ReconciliationException_refundId_fkey"
  FOREIGN KEY ("refundId") REFERENCES "Refund"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "enforce_m5_provider_event_guard"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  expected_campus_id UUID;
  expected_order_no VARCHAR(64);
  expected_refund_no VARCHAR(64);
  expected_refund_order_id UUID;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."provider" IS DISTINCT FROM OLD."provider"
       OR NEW."eventId" IS DISTINCT FROM OLD."eventId"
       OR NEW."eventType" IS DISTINCT FROM OLD."eventType"
       OR NEW."verifierKeyId" IS DISTINCT FROM OLD."verifierKeyId"
       OR NEW."rawDigest" IS DISTINCT FROM OLD."rawDigest"
       OR NEW."merchantOrderNo" IS DISTINCT FROM OLD."merchantOrderNo"
       OR NEW."merchantRefundNo" IS DISTINCT FROM OLD."merchantRefundNo"
       OR NEW."providerTransactionId" IS DISTINCT FROM OLD."providerTransactionId"
       OR NEW."providerRefundId" IS DISTINCT FROM OLD."providerRefundId"
       OR NEW."occurredAt" IS DISTINCT FROM OLD."occurredAt" THEN
      RAISE EXCEPTION 'M5 provider event identity and signed facts are immutable'
        USING ERRCODE = '23514';
    END IF;
    IF OLD."status" IN ('APPLIED', 'REVIEW_REQUIRED', 'REJECTED')
       AND NEW."status" IS DISTINCT FROM OLD."status" THEN
      RAISE EXCEPTION 'M5 provider event cannot leave a terminal state'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW."orderId" IS NOT NULL THEN
    SELECT order_row."campusId", order_row."merchantOrderNo"
      INTO expected_campus_id, expected_order_no
      FROM "ServiceOrder" order_row
     WHERE order_row."id" = NEW."orderId";
    IF NOT FOUND OR NEW."campusId" IS DISTINCT FROM expected_campus_id
       OR NEW."merchantOrderNo" IS DISTINCT FROM expected_order_no THEN
      RAISE EXCEPTION 'M5 provider event order must match campus and merchant order number'
        USING ERRCODE = '23514';
    END IF;
    PERFORM 1 FROM "ServiceOrder" order_row
     WHERE order_row."id" = NEW."orderId"
       AND order_row."amountFen" = NEW."amountFen"
       AND order_row."currency" = NEW."currency";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'M5 provider event amount must match its service order'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW."refundId" IS NOT NULL THEN
    SELECT refund_row."campusId", refund_row."merchantRefundNo", refund_row."orderId"
      INTO expected_campus_id, expected_refund_no, expected_refund_order_id
      FROM "Refund" refund_row
     WHERE refund_row."id" = NEW."refundId";
    IF NOT FOUND OR NEW."campusId" IS DISTINCT FROM expected_campus_id
       OR NEW."merchantRefundNo" IS DISTINCT FROM expected_refund_no
       OR (NEW."orderId" IS NOT NULL AND NEW."orderId" IS DISTINCT FROM expected_refund_order_id) THEN
      RAISE EXCEPTION 'M5 provider event refund must match campus, refund number and order'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW."status" = 'APPLIED' THEN
    IF NEW."campusId" IS NULL OR NEW."orderId" IS NULL THEN
      RAISE EXCEPTION 'M5 applied provider event requires a tenant-bound order'
        USING ERRCODE = '23514';
    END IF;
    IF NEW."merchantRefundNo" IS NULL THEN
      PERFORM 1
        FROM "PaymentTransaction" payment_row
       WHERE payment_row."providerEventId" = NEW."id"
         AND payment_row."campusId" = NEW."campusId"
         AND payment_row."orderId" = NEW."orderId"
         AND payment_row."provider" = 'WECHAT_PAY'
         AND payment_row."status" = 'SUCCEEDED'
         AND payment_row."providerTransactionId" IS NOT DISTINCT FROM NEW."providerTransactionId"
         AND payment_row."rawDigest" = NEW."rawDigest";
    ELSE
      PERFORM 1
        FROM "Refund" refund_row
       WHERE refund_row."id" = NEW."refundId"
         AND refund_row."providerEventId" = NEW."id"
         AND refund_row."campusId" = NEW."campusId"
         AND refund_row."orderId" = NEW."orderId"
         AND refund_row."merchantRefundNo" = NEW."merchantRefundNo"
         AND (NEW."providerRefundId" IS NULL OR refund_row."providerRefundId" = NEW."providerRefundId")
         AND refund_row."status" = 'REFUNDED';
    END IF;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'M5 applied provider event requires matching terminal internal fact'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION "enforce_m5_payment_transaction_guard"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  event_row "ProviderEvent"%ROWTYPE;
BEGIN
  IF NEW."provider" = 'WECHAT_PAY' AND NEW."status" = 'SUCCEEDED' THEN
    IF NEW."providerEventId" IS NULL THEN
      RAISE EXCEPTION 'M5 successful WeChat payment requires a provider event'
        USING ERRCODE = '23514';
    END IF;
    SELECT * INTO event_row FROM "ProviderEvent" WHERE "id" = NEW."providerEventId";
    IF NOT FOUND OR event_row."provider" <> 'WECHAT_PAY'
       OR event_row."campusId" IS DISTINCT FROM NEW."campusId"
       OR event_row."orderId" IS DISTINCT FROM NEW."orderId"
       OR event_row."providerTransactionId" IS DISTINCT FROM NEW."providerTransactionId"
       OR event_row."rawDigest" <> NEW."rawDigest" THEN
      RAISE EXCEPTION 'M5 successful WeChat payment must match its provider event'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION "enforce_m5_refund_guard"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  event_row "ProviderEvent"%ROWTYPE;
BEGIN
  IF NEW."providerEventId" IS NOT NULL THEN
    SELECT * INTO event_row FROM "ProviderEvent" WHERE "id" = NEW."providerEventId";
    IF NOT FOUND OR event_row."provider" <> 'WECHAT_PAY'
       OR event_row."campusId" IS DISTINCT FROM NEW."campusId"
       OR event_row."orderId" IS DISTINCT FROM NEW."orderId"
       OR event_row."refundId" IS DISTINCT FROM NEW."id"
       OR event_row."merchantRefundNo" IS DISTINCT FROM NEW."merchantRefundNo"
       OR (event_row."providerRefundId" IS NOT NULL
           AND event_row."providerRefundId" IS DISTINCT FROM NEW."providerRefundId") THEN
      RAISE EXCEPTION 'M5 refund must match its provider event'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION "enforce_m5_reconciliation_exception_guard"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  expected_campus_id UUID;
BEGIN
  IF NEW."providerEventId" IS NOT NULL THEN
    SELECT event_row."campusId" INTO expected_campus_id
      FROM "ProviderEvent" event_row WHERE event_row."id" = NEW."providerEventId";
    IF NOT FOUND OR NEW."campusId" IS DISTINCT FROM expected_campus_id THEN
      RAISE EXCEPTION 'M5 reconciliation event must remain in its tenant boundary'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW."orderId" IS NOT NULL THEN
    SELECT order_row."campusId" INTO expected_campus_id
      FROM "ServiceOrder" order_row WHERE order_row."id" = NEW."orderId";
    IF NOT FOUND OR NEW."campusId" IS DISTINCT FROM expected_campus_id THEN
      RAISE EXCEPTION 'M5 reconciliation order must remain in its tenant boundary'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW."refundId" IS NOT NULL THEN
    SELECT refund_row."campusId" INTO expected_campus_id
      FROM "Refund" refund_row WHERE refund_row."id" = NEW."refundId";
    IF NOT FOUND OR NEW."campusId" IS DISTINCT FROM expected_campus_id THEN
      RAISE EXCEPTION 'M5 reconciliation refund must remain in its tenant boundary'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."status" = 'RESOLVED' AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'M5 resolved reconciliation exception cannot reopen'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ProviderEvent_m5_guard"
BEFORE INSERT OR UPDATE ON "ProviderEvent"
FOR EACH ROW EXECUTE FUNCTION "enforce_m5_provider_event_guard"();
CREATE TRIGGER "PaymentTransaction_m5_wechat_guard"
BEFORE INSERT OR UPDATE OF "provider", "providerEventId", "status", "providerTransactionId", "rawDigest", "campusId", "orderId"
ON "PaymentTransaction"
FOR EACH ROW EXECUTE FUNCTION "enforce_m5_payment_transaction_guard"();
CREATE TRIGGER "Refund_m5_provider_event_guard"
BEFORE INSERT OR UPDATE OF "providerEventId", "providerRefundId", "merchantRefundNo", "campusId", "orderId", "status"
ON "Refund"
FOR EACH ROW EXECUTE FUNCTION "enforce_m5_refund_guard"();
CREATE TRIGGER "ReconciliationException_m5_guard"
BEFORE INSERT OR UPDATE ON "ReconciliationException"
FOR EACH ROW EXECUTE FUNCTION "enforce_m5_reconciliation_exception_guard"();

-- schema-review-hardening: dedupe existing rows (D3), then install the new
-- constraints/indexes. Partial uniques cannot be declared in schema.prisma.

-- Contact rows sharing (customer_id, normalized): keep the primary if one is
-- among them, else the oldest (created_at, then id); delete the rest.
DELETE FROM "customer_phone" AS loser
USING "customer_phone" AS keeper
WHERE loser."customer_id" = keeper."customer_id"
  AND loser."normalized" = keeper."normalized"
  AND loser."id" <> keeper."id"
  AND keeper."id" = (
    SELECT cand."id"
    FROM "customer_phone" AS cand
    WHERE cand."customer_id" = loser."customer_id"
      AND cand."normalized" = loser."normalized"
    ORDER BY cand."is_primary" DESC, cand."created_at" ASC, cand."id" ASC
    LIMIT 1
  );

DELETE FROM "customer_email" AS loser
USING "customer_email" AS keeper
WHERE loser."customer_id" = keeper."customer_id"
  AND loser."normalized" = keeper."normalized"
  AND loser."id" <> keeper."id"
  AND keeper."id" = (
    SELECT cand."id"
    FROM "customer_email" AS cand
    WHERE cand."customer_id" = loser."customer_id"
      AND cand."normalized" = loser."normalized"
    ORDER BY cand."is_primary" DESC, cand."created_at" ASC, cand."id" ASC
    LIMIT 1
  );

-- Multiple is_primary rows per customer: keep the most recently updated_at.
UPDATE "customer_phone" AS row
SET "is_primary" = false
WHERE row."is_primary"
  AND row."id" <> (
    SELECT cand."id"
    FROM "customer_phone" AS cand
    WHERE cand."customer_id" = row."customer_id"
      AND cand."is_primary"
    ORDER BY cand."updated_at" DESC, cand."id" DESC
    LIMIT 1
  );

UPDATE "customer_email" AS row
SET "is_primary" = false
WHERE row."is_primary"
  AND row."id" <> (
    SELECT cand."id"
    FROM "customer_email" AS cand
    WHERE cand."customer_id" = row."customer_id"
      AND cand."is_primary"
    ORDER BY cand."updated_at" DESC, cand."id" DESC
    LIMIT 1
  );

-- Duplicate open conversation_tag rows: keep the oldest, close the extras.
UPDATE "conversation_tag" AS extra
SET "removed_at" = NOW()
WHERE extra."removed_at" IS NULL
  AND extra."id" <> (
    SELECT keeper."id"
    FROM "conversation_tag" AS keeper
    WHERE keeper."conversation_id" = extra."conversation_id"
      AND keeper."tag_id" = extra."tag_id"
      AND keeper."removed_at" IS NULL
    ORDER BY keeper."created_at" ASC, keeper."id" ASC
    LIMIT 1
  );

-- Duplicate open pendings / duplicate user.email: abort instead of guessing.
DO $$
DECLARE
  dup_count integer;
BEGIN
  SELECT count(*) INTO dup_count FROM (
    SELECT "customer_id", "field_key"
    FROM "customer_reconciliation_pending"
    WHERE "status" = 'open'
    GROUP BY "customer_id", "field_key"
    HAVING count(*) > 1
  ) d;
  IF dup_count > 0 THEN
    RAISE EXCEPTION 'customer_reconciliation_pending has % duplicate open (customer_id, field_key) group(s); fix by hand before migrating', dup_count;
  END IF;

  SELECT count(*) INTO dup_count FROM (
    SELECT "vehicle_id", "field_key"
    FROM "vehicle_reconciliation_pending"
    WHERE "status" = 'open'
    GROUP BY "vehicle_id", "field_key"
    HAVING count(*) > 1
  ) d;
  IF dup_count > 0 THEN
    RAISE EXCEPTION 'vehicle_reconciliation_pending has % duplicate open (vehicle_id, field_key) group(s); fix by hand before migrating', dup_count;
  END IF;

  SELECT count(*) INTO dup_count FROM (
    SELECT "email"
    FROM "user"
    GROUP BY "email"
    HAVING count(*) > 1
  ) d;
  IF dup_count > 0 THEN
    RAISE EXCEPTION '"user" has % duplicate email group(s); fix by hand before migrating', dup_count;
  END IF;
END $$;

-- DropIndex
DROP INDEX "customer_reconciliation_pending_customer_id_field_key_key";

-- DropIndex
DROP INDEX "vehicle_reconciliation_pending_vehicle_id_field_key_key";

-- AlterTable
ALTER TABLE "customer_reconciliation_pending" ADD COLUMN     "reason" TEXT,
ADD COLUMN     "resolved_by_user_id" UUID;

-- AlterTable
ALTER TABLE "service" ALTER COLUMN "odometer_km" SET DATA TYPE INTEGER USING round("odometer_km")::integer;

-- AlterTable
ALTER TABLE "vehicle_reconciliation_pending" ADD COLUMN     "reason" TEXT,
ADD COLUMN     "resolved_by_user_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "customer_email_customer_id_normalized_key" ON "customer_email"("customer_id", "normalized");

-- CreateIndex
CREATE UNIQUE INDEX "customer_phone_customer_id_normalized_key" ON "customer_phone"("customer_id", "normalized");

-- CreateIndex
CREATE INDEX "customer_reconciliation_pending_customer_id_field_key_idx" ON "customer_reconciliation_pending"("customer_id", "field_key");

-- CreateIndex
CREATE INDEX "message_conversation_id_provider_timestamp_idx" ON "message"("conversation_id", "provider_timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE INDEX "vehicle_reconciliation_pending_vehicle_id_field_key_idx" ON "vehicle_reconciliation_pending"("vehicle_id", "field_key");

-- CreateIndex
CREATE INDEX "webhook_event_status_updated_at_idx" ON "webhook_event"("status", "updated_at");

-- Partial uniques (Prisma cannot model these in schema.prisma).
-- conversation_tag_open_apply_key already exists from 20260828120000_tags_templates.
CREATE UNIQUE INDEX "customer_reconciliation_pending_open_field_key" ON "customer_reconciliation_pending"("customer_id", "field_key") WHERE "status" = 'open';

CREATE UNIQUE INDEX "vehicle_reconciliation_pending_open_field_key" ON "vehicle_reconciliation_pending"("vehicle_id", "field_key") WHERE "status" = 'open';

CREATE UNIQUE INDEX IF NOT EXISTS "conversation_tag_open_apply_key" ON "conversation_tag"("conversation_id", "tag_id") WHERE "removed_at" IS NULL;

CREATE UNIQUE INDEX "customer_phone_primary_per_customer_key" ON "customer_phone"("customer_id") WHERE "is_primary";

CREATE UNIQUE INDEX "customer_email_primary_per_customer_key" ON "customer_email"("customer_id") WHERE "is_primary";

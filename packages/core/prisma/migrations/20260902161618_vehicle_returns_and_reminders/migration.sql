-- AlterTable
ALTER TABLE "scheduled_message" ADD COLUMN     "lead_days" INTEGER,
ADD COLUMN     "return_reminder_message_id" TEXT;

-- CreateTable
CREATE TABLE "vehicle_return" (
    "id" TEXT NOT NULL,
    "vehicle_id" TEXT NOT NULL,
    "source_service_id" TEXT NOT NULL,
    "return_date" DATE NOT NULL,
    "status" TEXT NOT NULL,
    "interval_rule_id" TEXT,
    "interval_rule_version" INTEGER,
    "closed_at" TIMESTAMP(3),
    "closed_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vehicle_return_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "return_reminder_message" (
    "id" TEXT NOT NULL,
    "vehicle_return_id" TEXT NOT NULL,
    "template_id" TEXT,
    "body_template" TEXT NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelled_at" TIMESTAMP(3),

    CONSTRAINT "return_reminder_message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "follow_up_closed_entry" (
    "id" TEXT NOT NULL,
    "section" TEXT NOT NULL,
    "unit_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "anchor" TEXT NOT NULL,
    "closed_by_user_id" UUID NOT NULL,
    "closed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "follow_up_closed_entry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "vehicle_return_vehicle_id_idx" ON "vehicle_return"("vehicle_id");

-- CreateIndex
CREATE INDEX "vehicle_return_status_return_date_idx" ON "vehicle_return"("status", "return_date");

-- CreateIndex
CREATE INDEX "return_reminder_message_vehicle_return_id_idx" ON "return_reminder_message"("vehicle_return_id");

-- CreateIndex
CREATE INDEX "follow_up_closed_entry_unit_id_section_idx" ON "follow_up_closed_entry"("unit_id", "section");

-- CreateIndex
CREATE UNIQUE INDEX "follow_up_closed_entry_section_conversation_id_anchor_key" ON "follow_up_closed_entry"("section", "conversation_id", "anchor");

-- AddForeignKey
ALTER TABLE "vehicle_return" ADD CONSTRAINT "vehicle_return_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_return" ADD CONSTRAINT "vehicle_return_source_service_id_fkey" FOREIGN KEY ("source_service_id") REFERENCES "service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_return" ADD CONSTRAINT "vehicle_return_interval_rule_id_fkey" FOREIGN KEY ("interval_rule_id") REFERENCES "interval_rule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_return" ADD CONSTRAINT "vehicle_return_closed_by_user_id_fkey" FOREIGN KEY ("closed_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_reminder_message" ADD CONSTRAINT "return_reminder_message_vehicle_return_id_fkey" FOREIGN KEY ("vehicle_return_id") REFERENCES "vehicle_return"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_reminder_message" ADD CONSTRAINT "return_reminder_message_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "template"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_reminder_message" ADD CONSTRAINT "return_reminder_message_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follow_up_closed_entry" ADD CONSTRAINT "follow_up_closed_entry_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "unit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follow_up_closed_entry" ADD CONSTRAINT "follow_up_closed_entry_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follow_up_closed_entry" ADD CONSTRAINT "follow_up_closed_entry_closed_by_user_id_fkey" FOREIGN KEY ("closed_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_message" ADD CONSTRAINT "scheduled_message_return_reminder_message_id_fkey" FOREIGN KEY ("return_reminder_message_id") REFERENCES "return_reminder_message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
-- Pre-existing drift, unrelated to vehicle returns: the database holds this
-- index under a name truncated differently from what Prisma derives. Swept in
-- because prisma migrate dev emits it against any next migration; it renames an
-- index and changes no data.
ALTER INDEX "service_scheduled_attribution_service_id_scheduled_message_id_k" RENAME TO "service_scheduled_attribution_service_id_scheduled_message__key";

-- ---------------------------------------------------------------------------
-- Uniqueness moves from the service to the reminder trigger.
--
-- A return is generated from ONE service, so "at most one non-cancelled
-- scheduled message per service" forbade the whole point of a reminder plan:
-- one message a month before and another on the day. Prisma cannot express a
-- partial unique index, so both halves are written by hand here, exactly as
-- 20260831200000_optional_name_one_schedule wrote the original.
-- ---------------------------------------------------------------------------

DROP INDEX "scheduled_message_one_non_cancelled_service";

-- Reminder rows: several per return are correct, but only at DIFFERENT instants.
-- Two at the same instant is a double confirm, and this still makes it impossible.
CREATE UNIQUE INDEX "scheduled_message_one_per_reminder_instant"
    ON "scheduled_message" ("return_reminder_message_id", "scheduled_at")
    WHERE "return_reminder_message_id" IS NOT NULL AND "status" <> 'CANCELLED';

-- Rows that belong to no reminder message keep the ORIGINAL per-service
-- guarantee. Without this, dropping the index above would silently remove the
-- guard behind the Conversas rail's "Existing schedule blocks a second Programar
-- mensagem" — that rule is unchanged and still needs enforcing in the database,
-- not only in application code.
CREATE UNIQUE INDEX "scheduled_message_one_non_cancelled_service"
    ON "scheduled_message" ("service_id")
    WHERE "service_id" IS NOT NULL
      AND "return_reminder_message_id" IS NULL
      AND "status" <> 'CANCELLED';

-- Renames closed_at / closed_by_user_id to archived_at / archived_by_user_id and
-- adds scheduled_message.paused_at.
--
-- Prisma emits a data-loss warning for the two dropped columns. There is none:
-- vehicle_return was created hours earlier in
-- 20260902161618_vehicle_returns_and_reminders, nothing writes to it yet, and the
-- table was verified empty (0 rows) before this ran. A drop-and-add is therefore
-- honest here in a way it would not be against populated columns.
--
-- Why the rename at all: the design approved on 2026-09-02 replaced "close" with
-- "archive", and the two are not the same act. Closing was terminal and cancelled
-- the return's reminders; archiving is reversible and PAUSES them, so a name that
-- says "closed" would describe the opposite of what the column now records.
-- DropForeignKey
ALTER TABLE "vehicle_return" DROP CONSTRAINT "vehicle_return_closed_by_user_id_fkey";

-- AlterTable
ALTER TABLE "scheduled_message" ADD COLUMN     "paused_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "vehicle_return" DROP COLUMN "closed_at",
DROP COLUMN "closed_by_user_id",
ADD COLUMN     "archived_at" TIMESTAMP(3),
ADD COLUMN     "archived_by_user_id" UUID;

-- AddForeignKey
ALTER TABLE "vehicle_return" ADD CONSTRAINT "vehicle_return_archived_by_user_id_fkey" FOREIGN KEY ("archived_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- paused_at is bookkeeping, never the decider.
--
-- PAUSED is a status value precisely so that nothing has to remember to check a
-- sibling column before dispatching. paused_at records WHEN the pause happened;
-- this constraint stops the two from drifting into disagreement, which is the
-- failure that made us reject a pausedAt-only design in the first place.
--
-- Note what is deliberately NOT constrained: scheduled_at is untouched by a
-- pause. Resuming compares that original instant to now, and a reminder whose
-- moment passed while paused stays paused rather than dispatching late.
-- ---------------------------------------------------------------------------

ALTER TABLE "scheduled_message"
    ADD CONSTRAINT "scheduled_message_paused_at_matches_status"
    CHECK (("status" = 'PAUSED') = ("paused_at" IS NOT NULL));

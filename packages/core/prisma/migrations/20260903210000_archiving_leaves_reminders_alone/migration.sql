-- ---------------------------------------------------------------------------
-- Archiving a vehicle return no longer touches its reminders.
--
-- Arquivar means "take this off my list", not "stop messaging this customer".
-- A reminder exists only where someone deliberately created one, and stopping
-- it is a separate action on the reminder itself. Archiving now writes status,
-- archived_at and archived_by_user_id, and nothing else.
--
-- That leaves PAUSED with no producer. It existed for exactly one job: holding
-- a return's reminders while the return was set aside, so that unarchiving
-- could tell one still ahead from one whose moment had passed. With archiving
-- decoupled, nothing can create a paused row, so the status, its bookkeeping
-- column and the constraint tying them together all go.
--
-- Verified empty before writing this: zero rows with status = 'PAUSED' and zero
-- with paused_at set, so neither statement below loses data.
-- ---------------------------------------------------------------------------

ALTER TABLE "scheduled_message"
    DROP CONSTRAINT "scheduled_message_paused_at_matches_status";

ALTER TABLE "scheduled_message"
    DROP COLUMN "paused_at";

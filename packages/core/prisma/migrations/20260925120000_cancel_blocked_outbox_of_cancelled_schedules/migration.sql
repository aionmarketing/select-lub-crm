-- One-off data fix (owner rulings, 2026-09-25): an outbox row left `blocked`
-- behind a schedule that is already CANCELLED is set `cancelled`.
--
-- HOW THESE ROWS CAME TO BE. A reminder due while the WhatsApp channel was down
-- got a `blocked` outbox row, and its schedule went back to SCHEDULED. Three
-- paths then cancelled the schedule and touched only `scheduled_message`:
-- cancelling a reminder message, a reminder moment dropped by an edit or pushed
-- into the past, and a superseded return's reminders. (The attendant's own
-- cancel already cancelled the outbox row too.) Those paths now cancel it
-- themselves; this fixes the rows they left before.
--
-- WHY THESE ROWS COULD NEVER BE SENT. The drain claims only `queued` rows, and
-- the only thing that moves a `blocked` row back to `queued` is the due tick,
-- which reaches an outbox row only through a schedule it dispatches, and it
-- dispatches only SCHEDULED schedules. A CANCELLED schedule is never dispatched
-- again, so its `blocked` row stays blocked for ever: no message will go out
-- because of it, and none is stopped by this. What it did do is show in the
-- conversation thread as a " · blocked" bubble for ever; after this, the bubble
-- reads " · cancelled", as an attendant's cancel always has.
--
-- Exactly the columns channel's `cancelOutbound` writes on a cancel: `status`,
-- and `updated_at`, which Prisma stamps through `@updatedAt`. `last_error` and
-- everything else are left as they were. Re-running it matches nothing.
UPDATE "outbox_message" AS o
   SET "status" = 'cancelled',
       "updated_at" = NOW()
  FROM "scheduled_message" AS s
 WHERE s."idempotency_key" = o."idempotency_key"
   AND s."status" = 'CANCELLED'
   AND o."status" = 'blocked';

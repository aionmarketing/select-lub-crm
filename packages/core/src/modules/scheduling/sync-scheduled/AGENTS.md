# scheduling / sync-scheduled

**Purpose.** Copy a sent message's outcome from channel's outbox row back onto its
schedule: confirmed → `SENT`, failed → `FAILED` with the reason.

**Kind.** Worker job step — the SECOND half of the job `scheduling/due-and-sync`,
after `run-due-tick` (3B ruling Q4). Entry points: `syncOutboxOutcomes(db)`,
`syncScheduled(scheduled)`.

**Tables written.** `scheduled_message`. Reads `outbox_message` (channel's,
`readableBy`).

**Invariants.**

- Only `PROCESSING` rows are read, and both writes are compare-and-set from
  `PROCESSING`, so a row the api cancelled meanwhile is not overwritten.
- A row whose outbox row is still in flight stays `PROCESSING`.
- A late delivery is recorded (`hold-unknown-followups`): a `FAILED` schedule whose
  reason is `send_outcome_unknown` moves to `SENT` once its copy is `confirmed`, as a
  compare-and-set on the status and the reason, at most 50 a sync. A refused schedule
  never moves; a `resend:<id>` copy does not stop it.
- One `db.tx` per row. Reads outcomes up to one drain tick old (the due tick and
  the drain are separate jobs, 3A ruling Q1-A).

**Tests.** `tests/sync-late-delivery.integration.test.ts` (4: the late delivery, with a
resend, and the two predicates' controls). `tests/sync-scheduled.integration.test.ts`, 4 new cases (the old file
reached the sync only through a due → drain → sync round trip, now in
`apps/worker/test/scheduling-wiring.test.ts`). The race the compare-and-set guards
needs a second connection mid-call and is not staged; the header says so.

# scheduling / run-due-tick

**Purpose.** Hand due scheduled messages to channel's outbox, and put back rows a
dead tick left `PROCESSING`.

**Kind.** Worker job step — the FIRST half of ONE job, `scheduling/due-and-sync`,
every `WORKER_OUTBOX_POLL_MS`, followed by `sync-scheduled` (3B ruling Q4: both
write `scheduled_message`, so they never run side by side). Entry points:
`recoverStaleProcessing(db, now, staleMs)`, `dispatchDue(db, now)`,
`runDueTick(scheduled, now)`; the module's `createScheduledDue(db)` and
`createJobs(deps)` compose them.

**Tables written.** `scheduled_message`. The outbox row is written by channel's
`enqueueOutbound`, under `module_channel`, joined to each row's transaction.

**Invariants.**

- The outbox is never written directly. `connected` comes from the STORED
  `connection_state` column (the api uses the live probe); `onExisting:
  "reconcile"` never touches a claimed, sent or confirmed outbox row.
- Every `scheduled_message` transition is compare-and-set on status: the claim
  from `SCHEDULED`, both resets from `PROCESSING`.
- The claim also re-checks `scheduled_at <= now`, and the queued text is read
  from the claimed row inside the claim's transaction, not from the due list
  (review of #170). An edit committing between the list and the claim — a
  move later, or new wording — is honoured, never overwritten with the text
  the list read. Cases 8 and 9 of `test/edited-reminder-outbox.test.ts` stage
  that interleaving.
- The stale-`PROCESSING` recovery never resets a schedule whose outbox copy is
  `claimed` (`hold-unknown-outcome-sends`): the send may have gone out, so
  channel's reclaim pass fails the copy as `send_outcome_unknown` and the sync
  marks the schedule `FAILED`. The skip is explicit because the reclaim can
  settle a claim after the 5-minute threshold.
- One `db.tx` per due row: claim, enqueue and a disconnected reset commit
  together. A throw leaves the row `SCHEDULED`, not stranded `PROCESSING`.
- At most `DUE_TICK_CAP` (50) rows a tick, oldest `scheduledAt` first; a row with
  no conversation is never dispatched.
- No provider call: the due tick never sends; the drain does, on its next tick.

**Tests.** `tests/run-due-tick.integration.test.ts`, 4 cases moved from
`apps/worker/src/scheduled/due.test.ts` + 1 new (recovery). The 2 cases that also
drive the drain are in `apps/worker/test/scheduling-wiring.test.ts`.

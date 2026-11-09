# prefill / enqueue-prefill

**Purpose.** Queue one extraction per conversation whose 60-second silence
window has closed.

**Kind.** Worker job step — the FIRST half of ONE job, `prefill/enqueue-and-drain`,
every `WORKER_PREFILL_POLL_MS`, followed by `drain-prefill`. Entry points:
`enqueueClosedWindows(db, now)`, `queueUnlessInFlight(tx, id)`; the module's
`createPrefillJob(db)` and `createJobs(deps)` compose them.

**Tables written.** `cadastro_prefill_job`.

**Invariants.**

- A POLL, not a `message-received` subscription (4C ruling): the window closes on
  silence, and a message arriving is the one moment it can never be closed.
- Only conversations with the switch on; only a window newer than
  `last_prefill_window_closed_at` (the watermark guards a stale scan).
- The in-flight check and the insert share one `db.tx` per conversation; a
  partial unique index refuses a second in-flight job.

**Tests.** `tests/enqueue-prefill.integration.test.ts`, 9 cases moved from
`apps/worker/src/prefill/enqueue.test.ts`.

**Blocked on core.** Nothing.

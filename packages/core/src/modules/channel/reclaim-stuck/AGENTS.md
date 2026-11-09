# reclaim-stuck

**Purpose.** Settle outbox rows abandoned mid-send: a row still `claimed` after the
claim timeout was left by a drain that stopped before recording the outcome. It becomes
`failed` with `send_outcome_unknown`, never `queued` (`hold-unknown-outcome-sends`): the
message may have gone out, and a person decides whether to resend.

**Kind.** Worker job, `channel/reclaim-stuck`, every `WORKER_OUTBOX_CLAIM_TIMEOUT_MS`
(default 180 s, which is also the age cutoff; above the 120 s media send limit, and the
worker warns at start-up when a configured value is not). Entry points: `reclaimStuck(db, timeoutMs)`
and `job(deps)`, registered by the module's `createJobs(deps)`.

**Tables written** (`channel`-owned, one `db.tx("channel", …)`): `outbox_message`.

**Invariants.**

- Only `claimed` rows move, and only when `claimed_at` is older than the cutoff by the
  DATABASE clock; a row with no `claimed_at` never matches.
- No tenancy predicate: it sweeps the whole table, by status and age.
- Never requeues. A failed row whose send later returns an id is recorded `confirmed` by
  the drain's `markConfirmed`.

**Tests.** `tests/reclaim-stuck.integration.test.ts`, 7 cases moved from
`apps/worker/src/outbox/reclaim.test.ts`, assertions unchanged, and
`tests/reclaim-stuck.sql.test.ts`, the 1 reclaim case from
`apps/worker/src/outbox/prisma.test.ts` (the timeout reaches the SQL as a parameter).

**Blocked on core.** Nothing.

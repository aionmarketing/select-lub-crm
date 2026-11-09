# drain-outbox

**Purpose.** Push the writes the CRM owes the ERP: each `erp_outbox` row becomes one
`erp.adapter.put(erpRecordId, fields, integrationCode)`.

**Kind.** Worker job, `erp/drain-outbox`, every 10 s by default. Entry points:
`drainErpOutbox(db, erp, { now, limit })`, one tick, which the tests call, and `job(deps)`,
which the module's `createJobs(deps)` registers. **Not registered by `apps/worker`:**
nothing enqueues until `customers` (4B) calls `enqueue-write`, and that stream registers
the job (3A, W3-C2). `services` never enqueues: its service rows come from the ERP (W3-C8).

**Tables written** (`erp`-owned, every statement in `db.tx("erp", …)`): `erp_outbox`,
`integration_error`. Rows are created only by the contract `enqueueErpWrite`.

**Invariants.**
- A tick is three kinds of transaction: reclaim, claim, and one per row to record its
  outcome. The ERP call happens between claim and record, outside any transaction
  (W2-C12); the test asserts none is open while `put` runs.
- A claimed row is `sending`; `FOR UPDATE SKIP LOCKED` keeps two workers off the same row.
  The claim picks its rows in a **`MATERIALIZED` CTE**, never `WHERE id IN (SELECT … LIMIT n
  FOR UPDATE SKIP LOCKED)`: rescanned on the inner side of a nested loop, that subquery
  skips the rows its own statement already updated and reaches further, so it claimed 3 of
  limit 2 in a root run. The batch-limit test forces that plan.
  A row left `sending` longer than `ERP_OUTBOX_CLAIM_TIMEOUT_MS` is reclaimed, and **the
  reclaim counts as an attempt**: back to `pending` after the retry delay, or `failed` on
  the fifth, so a put that hangs or kills the worker is never retried forever.
- Recording is a **compare-and-set** on `(id, status = 'sending', claimed_at)`, the claim's
  own timestamp. A push that outlives its claim and reports back after a later tick
  re-claimed and re-sent the row changes nothing; the tick counts it `stale`. The same
  pattern as channel's due-tick.
- Every field accepted → `sent`. A field rejected → `failed` at once (resending the same
  value would be rejected again). The call threw → `pending` with a doubling delay (30 s,
  60 s, … capped at an hour), `failed` on the fifth attempt.
- Each failure and each reclaim writes one `integration_error` whose `correlation_id` is
  the row id: `erp_put_rejected` (not retryable), `erp_put_failed` or
  `erp_put_claim_expired` (retryable while attempts remain). A stale result writes none.
- `enqueueErpWrite` is idempotent on `idempotencyKey` via `ON CONFLICT DO NOTHING`, so two
  concurrent enqueues of one key cannot both insert.

**Not decided here.** What the enqueuing module does after a `sent` row — marking its
field-sync versions synced, using the `versions` column — is 4B's. The row carries what it
needs.

**Tests.** `tests/drain-outbox.integration.test.ts`, 10 cases: sent, rejected, thrown,
thrown on the last attempt, reclaim as an attempt, reclaimed to the limit, a push that
outlived its claim, batch limit, idempotent enqueue, and the job declaration. The
no-open-transaction, reclaim-as-attempt, compare-and-set and batch-limit cases are
mutation-checked; every case that drains also proves it moved only its own rows.

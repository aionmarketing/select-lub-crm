# reconcile-connection

**Purpose.** Keep `whatsapp_connection.connection_state` in line with Evolution's live
session state, so the paths that read the stored column (the channel status, the
scheduled due-tick) see a reconnect or a drop without waiting for a webhook.

**Kind.** A function the worker calls, not a job of its own (ruling Q2-A):
`reconcileConnection(db, connectionState, now?)`. `apps/worker` runs it once at start-up
and then on the heartbeat, after the ingest retry pass, inside one worker-level job.

**Tables written** (`channel`-owned, one `db.tx("channel", …)` per write):
`whatsapp_connection` — `connection_state`, and `last_connected_at` /
`last_disconnected_at` for those two states.

**Invariants.**

- Every connection is polled; the list has no `where`.
- A failed or unrecognised lookup (`{ ok: false }`) leaves the stored state alone. A `404`
  whose body says the instance does not exist is not a failed lookup: the client maps it to
  `DISCONNECTED`. Any other `404` (an unknown route, a proxy) is `{ ok: false }` (`outbox-404-marks-disconnected`, owner 2026-10-07). That mapping is tested in
  `internal/evolution.test.ts`, and through this function in
  `apps/worker/test/scheduling-wiring.test.ts`, because a slice test may not import `internal/`.
- Writes no conversation, message or webhook-event row.
- Evolution is awaited outside any transaction (W2-C12).
- Ordered by observation time, not last-writer-wins (owner rulings, 2026-09-25): each
  answer is dated the instant before its own probe, and `updateConnectionState` writes only
  when that is not older than the stored `state_observed_at`. A `connection.update` webhook,
  dated by its receipt, and the drain's 404 write, dated before its send, go through the
  same guard.
- Each lookup is bounded: the production adapter aborts one after
  `EVOLUTION_CONNECTION_STATE_TIMEOUT_MS` (10 s) and reports `{ ok: false }`, so a silent
  Evolution cannot hold the worker's heartbeat, and the ingest retry that shares its tick.

**Tests.** `tests/reconcile-connection.integration.test.ts`, 5 cases moved from
`apps/worker/src/ingest/reconcile.test.ts`, assertions unchanged.

**Blocked on core.** Nothing.

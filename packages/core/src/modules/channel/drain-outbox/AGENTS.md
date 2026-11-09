# drain-outbox

**Purpose.** Send queued WhatsApp messages: claim the oldest claimable `queued` row, send
it through Evolution, and record the outcome by what it proves about delivery
(`hold-unknown-outcome-sends`):
- `confirmed`;
- `blocked` when the instance does not exist (a `404` whose body says so; any other `404` is
  unknown), and the connection is stored as
  `DISCONNECTED` (`outbox-404-marks-disconnected`), so the scheduled due tick stops
  re-releasing the copy until a reconnect is observed;
- back to `queued` with backoff when the request never reached Evolution, until the fifth
  failure makes it `failed`;
- `failed` at once when Evolution refused it, or the outcome is unknown (`send_outcome_unknown`).

**Kind.** Worker job, `channel/drain-outbox`, every `WORKER_OUTBOX_POLL_MS` (default 1 s),
up to 50 sends per tick. Entry points: `drainOnce(deps)` (one row), `drainOutbox(deps)`
(the tick), and `job(deps)`, which the module's `createJobs(deps)` registers. The kernel
registry's per-job flag is the only overlap guard; `drainOutbox` has none of its own.

**Tables written** (`channel`-owned, each statement in its own `db.tx("channel", …)`):
`outbox_message`; and `whatsapp_connection` on a `404` only, through channel's
`contracts/connections.ts` `updateConnectionState` (dated before the send, so a newer
`connection.update` wins). A failed state write is logged, and the tick goes on. Reads `conversation` and `whatsapp_connection` to route the send.

**Events published.** `channel/outbound-sent` (exception W3-C4), once per confirmed send
that returned a provider timestamp, awaited, and AFTER the confirm is written (owner
rulings, 2026-09-25). A publish that throws is logged and never undoes the confirm; the
SEND_MESSAGE webhook for the same provider id then inserts the thread bubble. Its
subscriber is ingest's canonical-message insert, wired by `apps/worker`.

**Invariants.**

- No transaction is open while Evolution is awaited (W2-C12): claim, send, record.
- A `cancelled` row is never claimed, and no result write moves one.
- The backoff compares against the database clock; the attempt bound applies to every
  message type; media bytes are cleared on confirm, block and any `failed`.
- **A send that might have arrived is never resent** (owner rule 2026-09-25). Each send is
  bounded (30 s text, 120 s media) and never throws, and a port that does throw is
  recorded as unknown, so no row is left `claimed` by a failure. Every result write but
  `markConfirmed` is compare-and-set on `claimed`, so none revives a row the reclaim
  pass already failed. `markConfirmed` does write over it: the message went out.
- Message bodies never reach the log.
- **The claim locks what it picks.** A `MATERIALIZED` CTE with `FOR UPDATE SKIP LOCKED`,
  and `status = 'queued'` re-checked on the row the UPDATE writes, so two drains never
  claim one row. Never `WHERE id IN (SELECT … SKIP LOCKED)`: rescanned inside a nested
  loop it claims more than one. `packages/core/test/outbox-claim-race.live.test.ts`
  pins both, on a scratch database: its race commits a `queued` row, which on a
  shared database a real worker could claim and send.
- **The duplicate-send window closes into a held message.** If the process dies after
  Evolution accepted a send but before the confirm commits, the row stays `claimed`, and
  `reclaim-stuck` fails it as `send_outcome_unknown` instead of requeuing it. A person
  decides whether to resend.

**Tests.** `tests/`, 42 cases over a shared `drain-outbox.fixture.ts`:
`drain-outbox.integration.test.ts` (one row, 9 moved + the role case + confirm-before-publish),
`drain-outbox.disconnect.integration.test.ts` (the 404 connection write, 4),
`drain-outbox.loop.integration.test.ts` (the tick and the registry's overlap guard, 9),
`drain-outbox.media.integration.test.ts` (media routing and bytes, 10),
`drain-outbox.queries.test.ts` (the SQL over a fake client, 5),
`drain-outbox.hold.integration.test.ts` (5: each failure class, a throwing port, media
bytes on an unknown outcome; the hung send through the real client is in
`packages/core/test/hold-unknown-outcome.test.ts`), and
`enqueue-race.integration.test.ts` (3: the due-tick race against `enqueueOutbound`'s
compare-and-set, with two positive controls). The claim's 2 live cases (two
connections racing one row, and the forced plan with its IN-form positive control)
are in `packages/core/test/outbox-claim-race.live.test.ts`. 28 are moved from
`apps/worker/src/outbox/drain.test.ts`; its other 2 (a SEND_MESSAGE webhook after the
send) cross into ingest and live in `apps/worker/test/channel-wiring.test.ts`. The 5
query cases are from `apps/worker/src/outbox/prisma.test.ts`.

**Blocked on core.** Nothing.

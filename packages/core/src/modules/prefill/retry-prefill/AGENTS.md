# prefill / retry-prefill

**Purpose.** `POST /conversations/:id/prefill/retry`: queue an extraction now,
unless one is in flight.

**Kind.** HTTP command. Entry points: `route`; `retryPrefill(tx, id)`.

**Tables written.** `cadastro_prefill_job`.

**Invariants.**

- 409 and no job while the extraction switch is off.
- At most one job in flight per conversation. The check and the insert share one
  `db.tx("prefill")`, and a partial unique index (`UNIQUE (conversation_id)
  WHERE status IN ('queued','running')`, invisible to `schema.prisma`) backs it.
- 404 for an unknown or another loja's conversation.
- A retry after a FAILED job re-runs that window (owner rulings, 2026-09-25). The
  failure already closed it, so a plain job would be `skipped` and the error would
  vanish. The new job carries the failed job's `window_latest_inbound_at` (or, for
  a failure from before that column, the conversation's watermark, the same
  instant). The drain extracts now on the current messages, without deriving a
  window, so the attendant's reply or a new inbound does not skip it (review of
  #168). A double press that loses the in-flight index answers like "already
  running". The watermark is never
  written back.

**Tests.** `tests/retry-prefill.integration.test.ts`, 3 cases moved from
`apps/api/src/cadastro.prefill.test.ts`. The retry end to end (fail, retry, the
same LLM input) is `packages/core/test/prefill-retry.test.ts`, since it spans this
slice and `drain-prefill`.

**Blocked on core.** Nothing.

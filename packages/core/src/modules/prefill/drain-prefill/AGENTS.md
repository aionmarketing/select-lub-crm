# prefill / drain-prefill

**Purpose.** Take one queued extraction, re-derive its window, ask the LLM, and
record the suggestion and the window's close.

**Kind.** Worker job step — the SECOND half of ONE job, `prefill/enqueue-and-drain`,
after `enqueue-prefill`; one job per tick. Entry point: `drainPrefill(db,
generate?, now)`; `claimQueued`, `markJob`, `completeWindow`, `failWindow` and
`extractFor` are exported for its tests.

**Tables written.** `cadastro_prefill_job`, `cadastro_prefill_suggestion`. The
`should_reply` labels and the watermark through `conversations`'
`closePrefillWindow`, on `createDb(tx)` inside the same `db.tx("prefill")`.

**Invariants.**

- The LLM call is a provider call and NEVER runs inside a `db.tx`: the context
  is read in one short transaction that closes first.
- The outcome is ONE transaction: suggestion, job status and window close commit
  or fail together. Any failure — extraction or the write — goes to
  `failWindow`, so no job is left `running`.
- The claim is compare-and-set on `queued`; the watermark moves forward only.
- A job whose window has since closed, or whose switch is off, is `skipped`.
- A finished job records its window's `latestInboundAt` (`window_latest_inbound_at`).
  A RETRY job (one carrying a failed window) is "extract now" (owner rulings,
  2026-09-25): it bypasses the window derivation — no watermark gate, no outbound
  or silence check — and extracts on the current messages, so it is not skipped
  because the attendant replied or a new inbound arrived. It labels the failed
  window's inbounds and closes with that window's time through the forward-only
  CAS. It is skipped (`retryIsMoot`) only once a newer window was extracted
  successfully.

**Tests.** 17 cases (18 runs) moved from `apps/worker/src/prefill/extract.test.ts`:
7 in `tests/drain-prefill.integration.test.ts` (whose header is the design for
both; plus 1 new case, the losing side of the claim's compare-and-set), 10 in `tests/drain-prefill.extract.integration.test.ts`, setup shared in
`tests/drain-prefill.fixture.ts`;
`tests/drain-prefill.reads.integration.test.ts`, 5 cases moved from
`apps/worker/src/prefill/store.test.ts` (its 2 pure cases are in
`internal/cadastro-snapshot.test.ts`).

**Blocked on core.** Nothing.

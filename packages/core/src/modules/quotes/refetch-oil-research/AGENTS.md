# refetch-oil-research

**Purpose.** "Buscar novamente" (background-oil-research D16): queue a new research of the
vehicle's identity at the front, searching the web whatever the miss window says, and answer with
the same body as `GET quote-options`, so the dialog shows the new research's progress from it.

**Kind.** HTTP route — `POST /vehicles/:id/oil-research/refetch`, no body. Entry points:
`refetchOilResearch(db, input)` and `route()`, which `createHttpPlugin` mounts. The answer is
`internal/quote-answer/answerQuote`, shared with `get-quote-options`.

**Tables written** (`quotes`-owned, one `db.tx("quotes", …)`): `oil_research`, only through the one
enqueue as a `refetch` at priority 0 (D7): a queued research becomes the refetch; a running one that
is not a refetch takes it as `pending_kind`; a wait whose cycle is not a refetch ends in a queued
refetch; a refetch already under way changes nothing. **Tables read:** as `get-quote-options`.

**Invariants.**
- A POST, never a GET: a window refocus or a query retry cannot re-send it.
- It calls no provider; the runner claims the refetch at its next tick, the budget never holds it.
- 404 alike for an unknown vehicle and another unit's.

**Tests.** `tests/refetch-oil-research.integration.test.ts` (module role `quotes`, rolling back);
the claim, the forced search and the budget pause in `packages/core/test/oil-research-quote-path.live.test.ts`.

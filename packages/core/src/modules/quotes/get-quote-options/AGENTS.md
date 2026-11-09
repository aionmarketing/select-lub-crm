# get-quote-options

**Purpose.** Tell the attendant what can be quoted for one car, from the stored rows and the
identity's background research state (background-oil-research D15): the options, empty or
missing-volume state of the latest cache row, with the Tecfil filter slots from the stored fitment;
or the research state — `researching`, `no_spec` (`incomplete_identity` naming the fields, or
`no_source`), a clarification, a conflict, or `error`. No reuse prompt, and no `mode`.

Since D24 (PR 5) none of the three dead ends is empty-handed: `no_capacity` carries the offerable
cards and filters without `fillLiters`, and a volume the attendant kept for the identity
(`oil_attendant_fill`) prices it as `options` with `attendantFill` while no cited volume exists; a
clarification carries the engines the source named, for the engine pick; and a conflict in the new
payload shape carries a card per disputed grade with its source, and the disputed volumes as
choices. An old-shape conflict payload maps to the no-card state.

**Kind.** HTTP route — `GET /vehicles/:id/quote-options` (a stale `?mode=` is stripped). Entry
points: `getQuoteOptions(db, input)`, the logic a test calls directly, and `route()`, which
`createHttpPlugin` mounts. The answer itself is `internal/quote-answer/answerQuote`, shared with
`refetch-oil-research`.

**Tables written** (all `quotes`-owned, one `db.tx("quotes", …)`): `oil_research`, only through the
one enqueue (D7) — an insert or an adoption, a promotion to priority 0, a re-enqueue of a resting row
D10 allows, a Tecfil promotion — and the stored estimate of a cycle it requests. A repeat read writes
nothing. **Tables read:** `motul_compatibility`, `tecfil_compatibility`, `oil_research`,
`oil_research_runner`, `oil_attendant_fill`, the three catalog tables; and, as foreign reads under `readableBy: "*"`,
`vehicle` and `customer`.

**Invariants.**
- **No provider call.** Not Motul, Tecfil, the web search or any model: research runs in the worker
  (`run-oil-research`). The api needs no provider port for quotes.
- An incomplete identity answers `no_spec` `incomplete_identity` and writes nothing.
- A quote-open with an adoptable row to show promotes no queued research (a manual upgrade at 1
  stays at 1); `refresh` appears only while research is attended; a Tecfil claim is not research.
- A vehicle that does not exist and one owned by another unit both answer 404, so neither is
  confirmed.

**Tests.** `tests/`: `states` (D15's rows over HTTP), `enqueue` (the writes, the re-run policy, the
`paused` order, the 404s, a trapped `fetch` across every status), `rows` (what a cache row yields:
cards, liters, provenance, filter slots), all under module role `quotes` on the rolling-back
transaction. What a research run writes onto the row is the runner's:
`packages/core/test/oil-research-quote-path.live.test.ts`.

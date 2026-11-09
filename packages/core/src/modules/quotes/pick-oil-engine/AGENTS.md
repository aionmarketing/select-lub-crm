# pick-oil-engine

**Purpose.** The attendant picks the engine a clarification named (background-oil-research D24.2):
the corrected identity's re-read of the stored passages is queued, and the vehicle's version is
corrected with the engine.

**Kind.** HTTP route — `POST /vehicles/:id/oil-research/engine-pick`, body `{ engine }`. Entry
points: `pickOilEngine(db, omieAdapter, input)` and `route({ omieAdapter })`, which
`createHttpPlugin(ports)` mounts.

**Order** (orchestrator, 2026-09-30): the check (409 `not_clarification` / `engine_not_named`, 422
`version_too_long`); the enqueue of the corrected identity as `engine_pick` at priority 0 with the
copied passages (a `full` research when the clarification kept none, G1), in the same transaction;
then the version write through `customers/contracts/correct-vehicle-version` (500 when it fails,
leaving the queued row); then the quote-options answer for the corrected identity.

**Tables written:** `oil_research` (`quotes`, only through the one enqueue); the vehicle's version
and its `vehicle_field_sync` origin through the customers contract (`customers` role).
**Tables read:** `vehicle`, `customer`, `oil_research`, the caches and the catalog.

**Invariants.** No provider call. The earlier identity's row and every other vehicle carrying it are
untouched. G2 lives in the enqueue (`internal/research/enqueue.ts`); the one-extraction re-read in
`run-oil-research/run-research.ts`.

**Tests.** `tests/pick-oil-engine.integration.test.ts` (rolling back); the run in
`packages/core/test/oil-research-engine-pick.live.test.ts`.

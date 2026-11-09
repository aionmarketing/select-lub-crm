# sweep-oil-research

**Purpose.** Find what background oil research should do next: every settled, complete vehicle
identity (the backfill on the first sweep), the manual upgrades, and the manual waits that have
ended; and keep the runner's heartbeat while a long run skips the runner's own ticks
(background-oil-research D7, D9, D11).

**Kind.** Worker job — `quotes/sweep-oil-research`, every `OIL_RESEARCH_SWEEP_MS` (60 s). Entry
points: `sweepOilResearch(deps)` and `job(deps)`, registered by `createOilResearchJobs`, only
with a database and `OIL_RESEARCH_ENABLED=true`.

**Tables written** (under `db.tx("quotes", …)`): `oil_research` (through the one enqueue, and the
end of a wait), `oil_research_runner` (heartbeat, watermark). **Tables read:** `vehicle`
(`readableBy: "*"`), `motul_compatibility` and `tecfil_compatibility` (adoption),
`oil_manual_reading` and `oil_manual_ingestion`.

**Invariants.**
- Only a vehicle unchanged for `OIL_RESEARCH_SETTLE_MS` is read, so an identity mid-edit is not
  researched; an incomplete identity never is.
- Every enqueue goes through `enqueueResearch`: one row per identity key, a repeat writes nothing.
- Priority 1 when a vehicle carrying the key was created in the last 24 h, else 2 (the backfill). An update alone does not promote: the ERP pull and prefill bump `updated_at` on old cars (orchestrator ruling, review of #186).
- The watermark only moves forward.
- It calls no provider.

**Tests.** `packages/core/test/oil-research-sweep.live.test.ts`, on a scratch database (the first
sweep reads every vehicle).

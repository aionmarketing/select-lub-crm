# run-oil-research

**Purpose.** Research one vehicle identity's oil specification per tick, in the background, so a
quote opens on stored results (background-oil-research D8–D13, D19).

**Kind.** Worker job — `quotes/run-oil-research`, every `OIL_RESEARCH_TICK_MS` (10 s). Entry
points: `runOilResearchTick(deps, stop)`, the logic a test calls, and `job(deps)`, which
`createOilResearchJobs` registers. `apps/worker` registers it only with a database and
`OIL_RESEARCH_ENABLED=true`.

**Tables written** (all `quotes`-owned, all under `db.tx("quotes", …)`): `oil_research`,
`oil_research_run`, `oil_research_runner`, `motul_compatibility` and `tecfil_compatibility`
(insert-only, with the recorded state), `oil_source_candidate` and `oil_spec_search_miss`
(insert-only evidence), `oil_manual_ingestion` and `oil_manual_reading` (the manuals a stage-1
miss queues). **Tables read:** those, and `vehicle` (`readableBy: "*"`, the claim's abandonment
check).

**Invariants.**
- **No transaction spans a provider call.** The claim commits first; the pipeline runs between
  short transactions; every port call goes through `step`, which renews the lease and flushes the
  meter in its own compare-and-set transaction.
- **One ports object, injected** (D21): `createProductionResearchPorts(db)` in the worker, fakes in
  tests. No per-port fallback to a production client.
- **Record or release is decided by the signals** — stop, lost, ceiling — never by what the
  pipeline returned. A stop writes the release as soon as the calls in flight have settled their
  spend (bounded by `RELEASE_SETTLE_MS`, 10 s, under the worker's 30 s `kill_timeout`), so an
  aborted call's US$ 0.25 charge and search fees reach `oil_research_run.cost_usd`; the tick
  settles only after it committed.
- **A provider-wide refusal** (401, 403, the balance 429) releases the run and pauses research;
  a rate limit releases it due at `Retry-After`; a refused parameter (400/1210) is this run's
  outage. The outage breaker pauses research after three outages in a row on different identities.
- **Nothing is claimed** without the key, or while research is paused for the provider.
- **A run that ends as an outage (or `failed`) still queues the manual it found** (oil-research-web-retrieval D5): `queueIdentityManuals` runs in the recording transaction for a `transient` record when manual ingestion is on and the run searched, without entering `waiting_manual`; the candidates were persisted before, whatever the outcome.
- **Motul degrades** (D6): the runner reads `motul_failing_since` before building the ports and tells the Motul adapter whether it is degraded; the adapter reports whether it answered, and after the record the runner stamps or clears the moment (nothing on a release or a lost claim). The run's log line carries `motul`.
- **Tecfil** runs after every verified record, on the claim the record took over, whatever the
  catalog holds; a picker failure is `unavailable`, never `unmatched`.

**Tests.** `packages/core/test/oil-research-stop-spend.test.ts` (a stop books the in-flight call's spend),
`packages/core/test/oil-research-runner.live.test.ts` and
`oil-research-manuals.live.test.ts`, each on a scratch database (a claim takes any due row);
`oil-research-transient-manuals.live.test.ts` and `oil-research-motul-degraded.live.test.ts` for the manual queued by an outage and the Motul degrade; `apps/worker/test/oil-research.test.ts` for the registration and the shutdown order.

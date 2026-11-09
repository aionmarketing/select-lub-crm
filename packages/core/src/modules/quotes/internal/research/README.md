# quotes/internal/research

Background oil research (background-oil-research). PR 2 adds the research tables' store and state; PR 3 the pieces the runner (`../../run-oil-research/`) and the sweep (`../../sweep-oil-research/`) jobs run on; the quote path (`../quote-answer/`) reads the state from PR 4. Everything here runs on a client already inside `db.tx("quotes", …)` and calls no provider.

In short: one row per identity (`oil_research`), claimed one at a time across processes, in the order quote-open or refetch (priority 0), a car registered in the last 24 h or a manual upgrade (1), the backfill (2). Only priority 2 is paced (`OIL_RESEARCH_BACKFILL_PACE_MS`), and only a priority-2 claim that spends is held by the daily budget (`OIL_RESEARCH_DAILY_BUDGET_USD`, US$ 1.00); attended research is exempt, but every run's spend (`oil_research_run.cost_usd`) counts toward the day's total. Each run row records its path, stages, tokens, effort and cost, and the X–Y estimate the dialog shows is stored on the identity when a cycle is requested, claimed or enters a manual wait — never recomputed on a poll.

| File | What it is |
|---|---|
| `identity-key.ts` | Re-exports the contract's `identityKey` (`../../contracts/oil-research-attention.ts` since PR 4): `year|make|model|version` under the caches' own normalization (D6), or `null` for an incomplete identity. Two identities share a key exactly when the caches would match them. |
| `research-states.ts` | The row's vocabulary: states, kinds (`refetch` > `engine_pick` > `full` > `manual_resolve`; `engine_pick` re-reads a clarification's stored passages for the engine the attendant picked, D24), triggers, priorities, Tecfil states, the attempts and both backoff schedules. |
| `research-store.ts` | The store's one import path, re-exporting the five files below. |
| `enqueue.ts` | The one enqueue (`INSERT … ON CONFLICT … DO UPDATE … WHERE`, adoption on insert, D7's table by state), the queue position, and the estimate stored when a cycle is requested or moved up. |
| `claim.ts` | The claim: runner-row lock, MATERIALIZED CTE with `FOR UPDATE` (no `SKIP LOCKED`: the runner lock serialises claimers, and an enqueue's row lock must not make the claim skip an attended row), pace and budget, adoption and abandonment first, then a research or a Tecfil claim with its run row. |
| `record.ts` | The compare-and-set writes of a live claim: renew-and-flush, the outcome (with the pending cycle and the Tecfil takeover), and the Tecfil outcome. |
| `release.ts` | Releases (attempt refunded), the expired-lease sweep (attempt kept; Tecfil back to `pending`), and the end of a manual wait. |
| `run-progress.ts` | A run row's meter and per-stage milliseconds, as every write flushes them. |
| `kinds-sql.ts` | SQL for a kind's strength: `refetch` > `engine_pick` > `full` > `manual_resolve`, and the clearing of the `engine_pick_*` columns whenever a new cycle starts. |
| `runner-row.ts` | `oil_research_runner`: the lock, the heartbeat (day, spend, budget, pause), the provider pause and since when Motul has been failing (`motul_failing_since`; a run stamps its first `unavailable` and any answer clears it, and after `MOTUL_DEGRADED_AFTER_MS` Motul is degraded: it no longer makes a run incomplete); D15's `stopped` and its reads are re-exported from `../../contracts/oil-research-attention.ts`, where the rail's `readActiveOilResearch` applies them too. |
| `budget.ts` | The America/Sao_Paulo day, the day's spend from the run rows, and the budget predicate (it holds only the backfill). |
| `estimate.ts` | The X–Y estimate (D14): per-path P25–P90 from the last 200 runs once there are 20, else the defaults task 1.13 measured (search 1–5 min, manual 1–6 min, P50(search) 60 s); the queue term in whole minutes; the stored bounds and their minutes. An `engine_pick` is in neither population: its 1–2 min is fixed and not shown. |
| `manual-candidates.ts` | `persistManualCandidates`: the documents a run found and did not read, insert-only. |
| `ports.ts` | PR 3: `OilResearchPorts`, the ONE ports object the runner is given (fakes in tests), the per-run `ResearchRunContext` (meter, signal, lease-renewing `step`, refusal report), and `createProductionResearchPorts`. |
| `provider-events.ts` | what a refused OpenAI request means — provider-wide (401, 403, `insufficient_quota`, `billing_not_active`, `model_not_found`), a rate limit, a refused parameter (400 `unsupported_value`) — and the transport tap that reports it. |
| `outcome.ts` | PR 3: D10's mapping of a pipeline result to what is recorded (the cache row, the payloads, transient with a fallback). Pure. |
| `manual-wait.ts` | PR 3: queueing an identity's manuals, whether one is still to come, ending the waits, and the manual-upgrade check. |
| `current-answer.ts` | PR 3: the re-resolve's second source, the web page behind the current answer, from its stored passage. |
| `settings.ts` | PR 3: `OilResearchSettings`, and the lease and the run ceiling, computed in one place. |
| `store-per-call.ts` | The quote's store with one short transaction per call, shared by the quote route and the runner. |

Two rules every caller keeps:

- **One enqueue.** Every caller that wants an identity researched goes through `enqueueResearch`; nobody reads the research row and then writes it. A repeat enqueue that changes nothing writes nothing.
- **Compare-and-set after a claim.** Research writes compare `(id, state = running, attempts, current_run_id)`, Tecfil writes `(id, tecfil_state = running, current_run_id)`. A `false` / `lost` means the claim is gone: write nothing more.

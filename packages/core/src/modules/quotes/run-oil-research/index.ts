/**
 * Slice `quotes/run-oil-research`: the worker job that researches one vehicle identity per tick
 * in the background (background-oil-research D8–D13, D19; `oil-research`).
 *
 * One tick:
 *   1. **Heartbeat** on `oil_research_runner`: last seen, the key flag, the day's spend, the
 *      budget, the pause.
 *   2. **No key**: without the model key it claims nothing and says it waits for the key.
 *   3. **Provider pause**: while a refused key, an exhausted balance or the outage breaker holds
 *      research, nothing is claimed.
 *   4. **Manual waits** that have ended move on (D11).
 *   5. **The claim** — under the runner-row lock, one at a time across processes, paced and capped
 *      for the backfill only — then the run outside any transaction: a research claim, or a Tecfil
 *      claim on a verified identity.
 *
 * The run's ports are ONE injected object (D21): tests pass fakes, the worker the production
 * ones. The job is registered only with a database and `OIL_RESEARCH_ENABLED=true`.
 */
import type { Db } from "../../../kernel/db.js";
import type { Job } from "../../../kernel/jobs.js";
import type { OilResearchPorts } from "../internal/research/ports.js";
import { claimNextResearch, type ClaimResult } from "../internal/research/research-store.js";
import { settleManualWaits } from "../internal/research/manual-wait.js";
import { writeRunnerHeartbeat } from "../internal/research/runner-row.js";
import { researchLeaseMs, runCeilingMs, type OilResearchSettings } from "../internal/research/settings.js";
import { createOutageBreaker, type OutageBreaker } from "./outage-breaker.js";
import { runResearchClaim, type ResearchRunResult } from "./run-research.js";
import { runTecfilClaim, type TecfilRunOutcome } from "./run-tecfil.js";

export { createOutageBreaker, type OutageBreaker } from "./outage-breaker.js";
export { tecfilRecordOf } from "./run-tecfil.js";
export type { ResearchRunResult } from "./run-research.js";

/** The job's name. */
export const RUN_OIL_RESEARCH_JOB = "quotes/run-oil-research";

/** What the job is built on. */
export type RunOilResearchDeps = {
  db: Db;
  ports: OilResearchPorts;
  settings: OilResearchSettings;
  now?: () => Date;
  /** Per process; the job builds one when absent. */
  breaker?: OutageBreaker;
};

/** What one tick did, for tests and logs. */
export type RunTickResult =
  | { outcome: "no_key" | "paused" | "stopped" | "busy" | "idle" }
  | { outcome: "adopted" | "abandoned"; identityKey: string }
  | { outcome: "research"; identityKey: string; run: ResearchRunResult }
  | { outcome: "tecfil"; identityKey: string; tecfil: TecfilRunOutcome };

/**
 * Runs one tick.
 *
 * @param deps - The job's dependencies; `breaker` keeps its streak across ticks.
 * @param stop - Aborted when the worker stops: a run in progress releases its claim at once, and
 *   the tick settles only once that release has committed.
 */
export async function runOilResearchTick(deps: RunOilResearchDeps & { breaker: OutageBreaker }, stop: AbortSignal): Promise<RunTickResult> {
  const now = deps.now ?? (() => new Date());
  const { db, settings } = deps;
  const keySet = deps.ports.keySet();
  const status = await db.tx("quotes", (tx) => writeRunnerHeartbeat(tx, { now: now(), keySet, searchAvailable: deps.ports.searchAvailable(), budgetUsd: settings.dailyBudgetUsd }));
  if (!keySet) {
    console.warn("oil-research", JSON.stringify({ outcome: "no_key", why: "OPENAI_API_KEY is not set; research waits for the key" }));
    return { outcome: "no_key" };
  }
  // The claim does not read the pause; the runner holds off while it lasts (review of #185).
  if (status.pausedReason === "provider") return { outcome: "paused" };
  if (stop.aborted) return { outcome: "stopped" };

  await db.tx("quotes", (tx) => settleManualWaits(tx, now()));
  const claim: ClaimResult = await db.tx("quotes", (tx) =>
    claimNextResearch(tx, {
      now: now(),
      leaseMs: researchLeaseMs(),
      budgetUsd: settings.dailyBudgetUsd,
      paceMs: settings.backfillPaceMs,
      maxAttempts: settings.maxAttempts,
    }),
  );
  switch (claim.type) {
    case "busy":
    case "idle":
      return { outcome: claim.type };
    case "adopted":
    case "abandoned":
      console.info("oil-research", JSON.stringify({ identity: claim.identityKey, outcome: claim.type }));
      return { outcome: claim.type, identityKey: claim.identityKey };
    case "tecfil": {
      const tecfil = await runTecfilClaim({ db, ports: deps.ports, now, ceilingMs: runCeilingMs(settings) }, claim, stop);
      return { outcome: "tecfil", identityKey: claim.identityKey, tecfil };
    }
    case "research": {
      const run = await runResearchClaim({ db, ports: deps.ports, settings, now, breaker: deps.breaker }, claim, stop);
      return { outcome: "research", identityKey: claim.identityKey, run };
    }
  }
}

/** @returns The registered job: `quotes/run-oil-research`, every `OIL_RESEARCH_TICK_MS`. */
export function job(deps: RunOilResearchDeps): Job {
  const breaker = deps.breaker ?? createOutageBreaker(deps.settings.outageBreaker);
  return {
    name: RUN_OIL_RESEARCH_JOB,
    everyMs: deps.settings.tickMs,
    run: async (stop) => {
      await runOilResearchTick({ ...deps, breaker }, stop);
    },
  };
}

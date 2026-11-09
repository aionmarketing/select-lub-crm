/**
 * A Tecfil consultation for a verified identity (background-oil-research D12), on its own claim:
 * a `tecfil_only` claim, or the one a verified record took over in the same run. It never touches
 * the spec's state or attempts; a lost claim writes no Tecfil row; a stop releases it back to
 * Tecfil `pending` with its Tecfil attempt refunded.
 */
import type { Db } from "../../../kernel/db.js";
import type { TecfilCompatibility } from "../contracts/http.js";
import type { ResearchTecfilAnswer } from "../internal/catalog/tecfil-lookup.js";
import type { UsageMeter } from "../internal/model-calls/meter.js";
import type { OilResearchPorts } from "../internal/research/ports.js";
import { collectRefusals } from "../internal/research/provider-events.js";
import { recordTecfil, releaseTecfil, renewTecfilLease, type TecfilClaim, type TecfilRecord } from "../internal/research/research-store.js";
import { researchLeaseMs } from "../internal/research/settings.js";
import { guardRun } from "./guarded-run.js";

/** What a Tecfil consultation ended as. */
export type TecfilRunOutcome = "ok" | "unmatched" | "unavailable" | "released" | "lost";

/** What a Tecfil run needs. */
export type TecfilRunDeps = { db: Db; ports: OilResearchPorts; now: () => Date; ceilingMs: number };

/**
 * Maps a Tecfil answer to what is recorded: `ok` with its row; `unmatched` only for a genuine
 * no-match; an outage, and an `unmatched` that followed a picker failure, as `unavailable`.
 */
export function tecfilRecordOf(claim: TecfilClaim, answer: ResearchTecfilAnswer | null, now: Date): TecfilRecord {
  if (!answer) return { state: "unavailable" };
  const { result } = answer;
  if (result.status === "ok") {
    const row: Omit<TecfilCompatibility, "id"> = {
      ...claim.identity,
      application: result.fitment.application,
      matchedBy: result.fitment.matchedBy,
      oilFilters: result.fitment.oilFilters,
      fuelFilters: result.fitment.fuelFilters,
      consultedAt: now.toISOString(),
      rawPayload: null,
    };
    return { state: "ok", row };
  }
  if (result.status === "unmatched" && !answer.pickerFailed) return { state: "unmatched", field: result.field };
  return { state: "unavailable" };
}

/**
 * Consults Tecfil for a claimed identity and records the outcome with the claim's compare-and-set.
 *
 * @param shared - The research run's meter and stage times, when this is the Tecfil step of a
 *   verified run: the picker lands on the same run row.
 */
export async function runTecfilClaim(
  deps: TecfilRunDeps,
  claim: TecfilClaim,
  stop: AbortSignal,
  shared?: { meter: UsageMeter; stageMs: Record<string, number> },
): Promise<TecfilRunOutcome> {
  const leaseMs = researchLeaseMs();
  const run = guardRun(
    deps.db,
    {
      renew: (tx, now, progress) => renewTecfilLease(tx, claim, now, leaseMs, progress),
      release: (tx, now, progress) => releaseTecfil(tx, claim, { now, ...progress }),
    },
    { stop, ceilingMs: deps.ceilingMs, now: deps.now, ...(shared ? { meter: shared.meter, stageMs: shared.stageMs } : {}) },
  );
  try {
    const refusals = collectRefusals();
    const lookup = deps.ports.tecfil({ meter: run.meter, signal: run.signal, step: run.step, report: refusals.report, skipWebSearch: false, motulDegraded: false, reportMotul: () => {} });
    let answer: ResearchTecfilAnswer | null = null;
    try {
      answer = await run.step("tecfil", () => lookup(claim.identity));
    } catch {
      answer = null;
    }
    const why = run.interrupted();
    if (why === "stopped") return (await run.settle()).released ? "released" : "lost";
    if (why === "lost") return "lost";
    const record = tecfilRecordOf(claim, answer, deps.now());
    const held = await deps.db.tx("quotes", (tx) => recordTecfil(tx, claim, record, { now: deps.now(), ...run.progress() }));
    console.info("oil-research", JSON.stringify({ identity: claim.identityKey, run: claim.runId, tecfil: held ? record.state : "lost" }));
    return held ? record.state : "lost";
  } finally {
    await run.settle();
  }
}

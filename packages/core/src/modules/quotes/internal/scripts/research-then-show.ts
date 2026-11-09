/**
 * The manual scripts' one research of an identity (background-oil-research task 4.6): the
 * runner's pipeline — `resolveOilSpec`, then D10's `mapPipelineResult` — over the ports the
 * script builds, then what the quote would show for the row it verified.
 *
 * It replaces `loadQuoteOptions`, which the quote path no longer has (D15). No research row is
 * written, no lease is taken and nothing is metered on a run row: a script is not the runner.
 * What it writes — the cache rows, the candidates, a remembered miss — goes through the store
 * it is handed, as the runner writes them.
 */
import type { QuoteOptionsResult } from "../../contracts/http.js";
import type { TecfilFitmentLookup } from "../catalog/tecfil-lookup.js";
import { resolveOilSpec, type OilSpecPorts } from "../pipeline/oil-spec.js";
import { shownRowResult, storedFilters } from "../quote-answer/shown-row.js";
import { persistManualCandidates } from "../research/manual-candidates.js";
import { mapPipelineResult } from "../research/outcome.js";
import { UNVERIFIED_SEARCH_REASON } from "../retrieval/sources.js";
import type { OilQuoteStore, VehicleIdentity } from "../store/store.js";

/** What one research showed, or why it showed no row. */
export type ResearchShown = QuoteOptionsResult | { status: "transient" };

/**
 * @param forceWebSearch - A refetch: the miss window does not spare the search.
 * @returns The row the research verified, as the quote shows it; its clarification or conflict;
 *   `no_spec`; or `transient` for an outage the runner would retry.
 */
export async function researchThenShow(
  identity: VehicleIdentity,
  ports: OilSpecPorts,
  store: OilQuoteStore,
  lookupTecfil: TecfilFitmentLookup,
  forceWebSearch: boolean,
): Promise<ResearchShown> {
  const now = new Date();
  const resolved = await resolveOilSpec(identity, ports, { forceWebSearch });
  await persistManualCandidates(store, identity, resolved.manualCandidates);
  if (resolved.webFoundUnverified) {
    await store.recordSearchMiss({ ...identity, reason: UNVERIFIED_SEARCH_REASON, searchedAt: resolved.webFoundUnverified.searchedAt });
  }
  const mapped = mapPipelineResult(resolved, identity, now);
  switch (mapped.kind) {
    case "transient":
      return { status: "transient" };
    case "no_spec":
      return { status: "no_spec", reason: "no_source" };
    case "needs_clarification":
      return { status: "needs_clarification", ...mapped.payload };
    case "conflicting_sources":
      return { status: "conflicting_sources", ...mapped.payload };
    case "verified":
      break;
  }
  const row = await store.insertCompatibility(mapped.cacheRow);
  const looked = await lookupTecfil(identity);
  const fitment =
    looked.status === "ok"
      ? await store.insertTecfilCompatibility({ ...identity, ...looked.fitment, consultedAt: now.toISOString(), rawPayload: null })
      : null;
  const tecfil = { researchState: "verified", state: looked.status === "ok" ? "ok" : looked.status, unmatchedField: looked.status === "unmatched" ? looked.field : null };
  const catalog = await store.listCatalog();
  return shownRowResult(row, catalog, () => storedFilters(fitment, tecfil, false, catalog));
}

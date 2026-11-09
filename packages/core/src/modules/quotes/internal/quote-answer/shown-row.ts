/**
 * What a stored cache row yields (background-oil-research D15; oil-quote-liters-pricing D10;
 * tecfil-filter-pricing D9): cards for every active catalog oil matching any listed SAE grade,
 * priced against the service-fill liters, and the filter slots from the stored Tecfil fitment.
 * Pure over what the caller read: no provider is called, and nothing is written.
 *
 * A card is only ever priced from liters some cited source stated or an attendant typed (D24), so
 * a row with no verified capacity is `no_capacity` — its cards carrying only the per-liter price,
 * for the client to price from a typed volume — or `options` priced from a stored attendant
 * volume, never a card priced from the unit price alone.
 */
import type { AttendantFill, FilterType, PricedFillCondition, QuoteCitedSource, QuoteFilters, QuoteFilterSlot, QuoteOptionsResult, TecfilCompatibility, TecfilFilterCandidate } from "../../contracts/http.js";
import { filterCandidatesFor } from "../catalog/filters.js";
import { filterCompatibleCatalogItems } from "../catalog/match.js";
import { litersSourceOf, shownSource } from "../cited-source.js";
import type { CachedCompatibility, CatalogRow } from "../store/store.js";

/** The row-level results a cache row can yield. */
export type ShownRow = Extract<QuoteOptionsResult, { status: "options" | "empty" | "no_capacity" }>;

/** The identity's Tecfil state, as the research row records it (D12), and the spec's state. */
export type TecfilView = { researchState: string | null; state: string | null; unmatchedField: string | null };

/**
 * One type's slot: nothing fitted is `no_fitment`, a fitment the catalog cannot fill is
 * `no_catalog_match` naming the numbers looked for, anything else `matched`.
 */
function slotFor(type: FilterType, candidates: TecfilFilterCandidate[], catalog: CatalogRow[]): QuoteFilterSlot {
  if (candidates.length === 0) {
    return { status: "no_fitment" };
  }
  const offered = filterCandidatesFor(type, candidates, catalog);
  if (offered.length === 0) {
    return { status: "no_catalog_match", tecfilNumbers: candidates.map((candidate) => candidate.tecfilNumber) };
  }
  return { status: "matched", candidates: offered };
}

const UNMATCHED_FIELDS = ["manufacturer", "vehicle", "engine", "year"] as const;

/**
 * The filter half (D15): a stored fitment is `cached`; otherwise the identity's Tecfil state —
 * `unmatched` with its field; `pending` (with `stopped`) only while a Tecfil claim can still
 * happen, i.e. the spec is `verified` and Tecfil is `pending` or `running`; and `unavailable` for
 * everything else — a failed consultation retried in the background, a spec that is not verified
 * (no Tecfil state yet), or `ok` with no matching row. `unavailable` does not poll, so a dialog
 * never waits on filters that no claim will bring (orchestrator ruling, review of #188). The quote
 * never calls Tecfil.
 *
 * @param stopped - D15's rule 1: whether background research is running at all.
 */
export function storedFilters(fitment: TecfilCompatibility | null, tecfil: TecfilView, stopped: boolean, catalog: CatalogRow[]): QuoteFilters {
  if (fitment) {
    return {
      source: "cached",
      consultedAt: fitment.consultedAt,
      application: fitment.application,
      oil: slotFor("OLEO", fitment.oilFilters, catalog),
      fuel: slotFor("COMBUSTIVEL", fitment.fuelFilters, catalog),
    };
  }
  const none = { consultedAt: null, application: null, oil: { status: "unavailable" }, fuel: { status: "unavailable" } } as const;
  const field = UNMATCHED_FIELDS.find((name) => name === tecfil.unmatchedField);
  if (tecfil.state === "unmatched") {
    return { source: "unmatched", ...(field ? { unmatchedField: field } : {}), ...none };
  }
  // A conflict with card data is claimed for Tecfil like a verified spec (D12, amended by D24 F1);
  // an old-shape conflict never gets a Tecfil state, so it stays `unavailable`.
  const specDone = tecfil.researchState === "verified" || tecfil.researchState === "conflicting_sources";
  const claimable = specDone && (tecfil.state === "pending" || tecfil.state === "running");
  return claimable ? { source: "pending", stopped, ...none } : { source: "unavailable", ...none };
}

/**
 * The capacity type of a row's priced liters (D5), as the store's column reader
 * (`readFillCondition`) decided it — from the column, else from the legend on a row written
 * before it. The legend is read here only for a row that did not come through that reader.
 */
function pricedConditionOf(spec: CachedCompatibility): PricedFillCondition {
  if (spec.fillCondition === "with_filter" || spec.fillCondition === "unlabeled") return spec.fillCondition;
  return spec.fillKind === "unlabeled" ? "unlabeled" : "with_filter";
}

/**
 * The row's own result. Each carries the row's date.
 *
 * - No active catalog oil has a listed grade: `empty`.
 * - No verified liters, and an attendant volume kept for the identity: `options` priced from it,
 *   carrying `attendantFill` in place of `litersSource`, as an in-service volume (D24).
 * - No verified liters otherwise: `no_capacity`, with the offerable cards and the filters, so the
 *   attendant can type the volume (D24), and no `fillLiters`.
 * - Otherwise `options` with its cards, priced from the cited liters, and the filters.
 *
 * @param attendantFill - The identity's latest stored volume; read by the caller only when the row
 *   has no usable liters, so a cited volume always wins.
 */
export function shownRowResult(spec: CachedCompatibility, catalog: CatalogRow[], filters: () => QuoteFilters, attendantFill: AttendantFill | null = null): ShownRow {
  const grades = { viscosityGrades: spec.viscosityGrades, viscosity: spec.viscosity, classification: spec.classification, consultedAt: spec.consultedAt };
  const options = filterCompatibleCatalogItems(catalog, spec);
  if (options.length === 0) {
    return { status: "empty", ...grades };
  }
  const primary: QuoteCitedSource = {
    sourcePublisher: spec.sourcePublisher,
    sourceDocument: spec.sourceDocument,
    sourcePage: spec.sourcePage,
    sourceAuthority: spec.sourceAuthority ?? null,
    sourceUrl: spec.sourceUrl ?? null,
  };
  const gradeSources = spec.gradeSources.map(({ grade, ...source }) => ({ grade, ...shownSource(source) }));
  if (spec.fillLiters == null || spec.fillKind == null) {
    if (attendantFill) {
      return {
        status: "options",
        ...grades,
        fillLiters: attendantFill.liters,
        fillKind: "em_servico",
        fillCondition: "with_filter",
        ...primary,
        gradeSources,
        attendantFill,
        options,
        filters: filters(),
      };
    }
    // D5: a volume the source did give that a change does not use is named, not hidden.
    const condition = spec.fillCondition ?? null;
    const unusable =
      spec.unusableFillLiters != null && spec.unusableFillLiters > 0 && (condition === "without_filter" || condition === "dry")
        ? { unusableFill: { liters: spec.unusableFillLiters, condition } }
        : {};
    return { status: "no_capacity", ...grades, ...unusable, options, filters: filters() };
  }
  return {
    status: "options",
    ...grades,
    fillLiters: spec.fillLiters,
    fillKind: spec.fillKind,
    fillCondition: pricedConditionOf(spec),
    ...primary,
    gradeSources,
    litersSource: litersSourceOf(spec, primary),
    options,
    filters: filters(),
  };
}

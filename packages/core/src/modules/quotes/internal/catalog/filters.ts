/**
 * Catalog matching for Tecfil filter candidates (tecfil-filter-pricing D8): an active
 * catalog item with a filter-detail of the requested type is offerable when its own part
 * number equals a fitted Tecfil number, or one of that Tecfil part's cross-reference
 * numbers, after normalization. The brand is never compared, so a workshop item sold under
 * another brand still matches through the cross-reference list.
 */
import type { FilterDetail, FilterType, TecfilFilterCandidate } from "../../contracts/http.js";
import type { CatalogRow } from "../store/store.js";

/**
 * Uppercases a part number and drops every non-alphanumeric character, so `GI50/7`,
 * `gi 50-7` and `GI507` are the same number.
 * @param value - Part number as Tecfil or the catalog writes it.
 * @returns The comparison key; empty string when `value` has no letters or digits.
 */
export function normalizePartNumber(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Every number one fitted Tecfil part can be recognised by: its own, plus each
 * cross-reference's, all normalized.
 */
function numbersOf(candidate: TecfilFilterCandidate): string[] {
  return [
    normalizePartNumber(candidate.tecfilNumber),
    ...candidate.crossReferences.map((reference) => normalizePartNumber(reference.number)),
  ].filter((number) => number !== "");
}

/**
 * Picks the catalog items offerable for one filter type given Tecfil's fitted candidates.
 *
 * @param type - Which filter slot is being filled (`OLEO` or `COMBUSTIVEL`).
 * @param candidates - Tecfil's fitted parts for that type; an empty list yields no items.
 * @param catalog - Full catalog (active and inactive, lubricants, filters and neither).
 * @returns The matching rows, `filter` narrowed to non-null, in catalog order. Inactive
 * items, items with no filter-detail, and filter-details of the other type never match.
 */
export function filterCandidatesFor(
  type: FilterType,
  candidates: TecfilFilterCandidate[],
  catalog: CatalogRow[],
): Array<CatalogRow & { filter: FilterDetail }> {
  const wanted = new Set(candidates.flatMap(numbersOf));
  if (wanted.size === 0) {
    return [];
  }
  return catalog.filter((row): row is CatalogRow & { filter: FilterDetail } => {
    if (!row.active || row.filter == null || row.filter.filterType !== type) {
      return false;
    }
    return wanted.has(normalizePartNumber(row.filter.partNumber));
  });
}

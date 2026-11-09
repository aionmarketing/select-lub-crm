/**
 * Catalog compatibility: active items whose lubricant-detail matches the verified spec
 * after trim + case-insensitive compare (oil-quote D3, D12, D13).
 *
 * Matching is on **SAE viscosity only**. A cited source may list more than one grade for
 * the same engine, and an item matching ANY listed grade is offerable — collapsing the list
 * to one grade would hide oils the workshop can legally sell for that car.
 *
 * Classification (`API SP`, `ILSAC GF-7A`, `VW 502.00`) is carried on the row and shown to
 * the attendant, but it never gates a card (owner decision 2026-09-09). Two reasons it
 * could not stay a gate as written: most cited sources state a viscosity and a fill volume
 * and no certification at all, so equality against an empty spec rejected every oil in the
 * catalog; and API grades are cumulative, so an `API SP` oil more than satisfies a car
 * asking for `API SN` while literal equality still says no. Judging a certification is the
 * attendant's call, with the string in front of them.
 *
 * An item with no lubricant-detail row is not an oil and is never offered.
 */
import type { CatalogItem, LubricantDetail } from "../../contracts/http.js";

/** A catalog row plus the oil spec it carries, or `null` when the item is not a lubricant. */
type CatalogItemWithLubricant = Pick<CatalogItem, "active"> & {
  lubricant: Pick<LubricantDetail, "viscosity" | "classification"> | null;
};

function norm(value: string) {
  return value.trim().toLowerCase();
}

/**
 * Returns whether one catalog row may be offered for a verified spec.
 *
 * @param item - Catalog row with its `active` flag and its lubricant-detail (`null` when not an oil).
 * @param spec - Every SAE grade the cited source listed. Classification is not read here.
 * @returns `true` when the item is active, is a lubricant, and its viscosity equals any listed grade.
 */
export function catalogItemMatchesSpec(
  item: CatalogItemWithLubricant,
  spec: { viscosityGrades: readonly string[] },
) {
  if (!item.active || item.lubricant == null) return false;
  const viscosity = norm(item.lubricant.viscosity);
  return spec.viscosityGrades.some((grade) => norm(grade) === viscosity);
}

/**
 * Filters catalog rows down to the offerable set for a verified spec.
 *
 * @param items - Full catalog (active and inactive, oils and non-oils).
 * @param spec - Every listed SAE grade.
 * @returns Active matching lubricants only; empty when none match. Rows come back with
 * `lubricant` narrowed to non-null, since an item without one can never match.
 */
export function filterCompatibleCatalogItems<T extends CatalogItemWithLubricant>(
  items: T[],
  spec: { viscosityGrades: readonly string[] },
): Array<T & { lubricant: NonNullable<T["lubricant"]> }> {
  return items.filter(
    (item): item is T & { lubricant: NonNullable<T["lubricant"]> } =>
      catalogItemMatchesSpec(item, spec),
  );
}

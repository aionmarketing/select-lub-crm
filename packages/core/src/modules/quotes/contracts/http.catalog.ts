/**
 * Zod contracts for the internal product catalog used when building oil-change quotes.
 *
 * A catalog item is a generic workshop product. Oil-only fields live on the separate
 * lubricant-detail row and filter-only fields on the separate filter-detail row; an item
 * is a lubricant exactly when the first row exists and a filter exactly when the second
 * does. An item never carries both.
 *
 * Moved from `packages/shared-types/src/catalog.ts` (5.1d) with declarations unchanged.
 */
import { z } from "zod";

/** Response body for a single catalog row returned by the catalog API. */
export const catalogItemSchema = z.object({
  id: z.string(),
  brand: z.string().trim().min(1),
  description: z.string().trim().min(1),
  price: z.number().nonnegative(),
  stock: z.number().nonnegative(),
  active: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/**
 * The base-oil type a catalog lubricant can carry (add-lubricant-oil-type, rulings of
 * 2026-10-10): the stored value, never its pt-BR label — "Sintético", "Semissintético" and
 * "Mineral" are the web's. Informative only: no offer is filtered, ordered or priced by it.
 */
export const oilTypeSchema = z.enum(["SINTETICO", "SEMISSINTETICO", "MINERAL"]);

/**
 * Oil spec for one catalog item — at most one per item. Its presence is what makes the
 * item a lubricant. `classification` may be empty, which matches on viscosity alone.
 * `oilType` is always present: one of {@link oilTypeSchema}'s values, or `null` when the
 * lubricant has no recorded type (a row from before the field, or an ERP product without one).
 */
export const lubricantDetailSchema = z.object({
  catalogItemId: z.string(),
  viscosity: z.string().trim().min(1),
  classification: z.string(),
  oilType: oilTypeSchema.nullable(),
});

/**
 * The two filter kinds the oil-change quote prices. `OLEO` is the oil filter and
 * `COMBUSTIVEL` the fuel filter; air and cabin filters are out of scope.
 */
export const filterTypeSchema = z.enum(["OLEO", "COMBUSTIVEL"]);

/**
 * Fitment key for one catalog item — at most one per item, and never alongside a
 * lubricant-detail. Its presence is what makes the item a filter. `partNumber` is the
 * item's own number as the workshop stocks it, which the quote compares against the
 * Tecfil numbers and their cross-references; it is not a price and not a Tecfil cache row.
 */
export const filterDetailSchema = z.object({
  catalogItemId: z.string(),
  filterType: filterTypeSchema,
  partNumber: z.string().trim().min(1),
});

const SAE_GRADE = /^\d{1,2}W-\d{1,2}$/;

/**
 * Normalizes one SAE grade to the hyphenated form the catalog stores.
 *
 * A leading `SAE` — any case, with or without spaces or a hyphen after it — is dropped first
 * (background-oil-research D23): `SAE 0W 30` was kept as `SAE0W-30`, failed the pattern and was
 * dropped, so a source that wrote every grade that way stated nothing.
 *
 * Moved here from `internal/pipeline/oil-spec.ts` (which re-exports it) by
 * add-lubricant-oil-type, so the web can use the same rule through the contract.
 *
 * @param grade - A grade as written in the source, for example ` 5w30 `, `5W-30` or `SAE 5W 30`.
 * @returns `5W-30`, or `null` when the string is not an SAE multigrade.
 */
export function normalizeSaeGrade(grade: string): string | null {
  const compact = grade.trim().toUpperCase().replace(/\s+/g, "").replace(/^SAE-?/, "");
  const hyphenated = compact.includes("-") ? compact : compact.replace(/W/, "W-");
  return SAE_GRADE.test(hyphenated) ? hyphenated : null;
}

/** A grade-shaped run of text inside a product description: `5W-30`, `5w30`, `SAE 0W 20`. */
const GRADE_IN_TEXT = /(?<!\d)(?:SAE[\s-]*)?\d{1,2}\s*W\s*-?\s*\d{1,2}(?!\d)/gi;

/**
 * Whether a catalog description already names a lubricant's SAE grade, under
 * {@link normalizeSaeGrade} — so a card titled from brand, description and viscosity does not
 * print the grade twice (add-lubricant-oil-type, "A grade already in the description is not
 * repeated").
 *
 * @param description - The catalog item's description, for example `Super 3000 0W-20`.
 * @param grade - The lubricant-detail's viscosity, for example `0W-20`.
 * @returns `true` when some grade written in the description normalizes to the same grade.
 */
export function descriptionNamesGrade(description: string, grade: string): boolean {
  const target = normalizeSaeGrade(grade) ?? grade.trim().toUpperCase();
  for (const match of description.matchAll(GRADE_IN_TEXT)) {
    if (normalizeSaeGrade(match[0]) === target) return true;
  }
  return false;
}

/** Single generic catalog row returned by the catalog API. */
export type CatalogItem = z.infer<typeof catalogItemSchema>;

/** Oil spec attached to a catalog item that is a lubricant. */
export type LubricantDetail = z.infer<typeof lubricantDetailSchema>;

/** A catalog lubricant's base-oil type, as stored. */
export type OilType = z.infer<typeof oilTypeSchema>;

/** Which filter kind a filter-detail describes. */
export type FilterType = z.infer<typeof filterTypeSchema>;

/** Fitment key attached to a catalog item that is a filter. */
export type FilterDetail = z.infer<typeof filterDetailSchema>;

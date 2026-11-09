/**
 * How the quote tables' loosely-typed columns are read back into the contract.
 *
 * Several columns are wider on disk than in the contract — JSON, free TEXT, a
 * nullable half of a pair — because older or hand-edited rows exist. Each reader
 * here narrows one of them, and says what an unrecognised value becomes.
 */
import type { FillCondition, FillKind } from "../../contracts/http.js";
import type { SourceClassification } from "../../../../shared/web/source-classification.js";

/** Prisma's `Decimal`, as far as the readers need it. */
export type DecimalLike = { toNumber(): number };

/**
 * @param value - A timestamp column.
 * @returns Its ISO-8601 string.
 */
export function iso(value: Date): string {
  return value.toISOString();
}

/**
 * Reads the stored SAE grade list, falling back to the single `viscosity` column.
 *
 * Rows written before the grounded pipeline have no `viscosities`, and D2 reads those as a
 * one-entry list rather than as a row with no grade at all.
 *
 * @param viscosities - The JSON column, `null` on a pre-grounding row.
 * @param viscosity - The first-grade column, always populated.
 * @returns A non-empty list of trimmed SAE strings.
 */
export function readGrades(viscosities: unknown, viscosity: string): string[] {
  if (Array.isArray(viscosities)) {
    const grades = viscosities.filter(
      (grade): grade is string => typeof grade === "string" && grade.trim() !== "",
    );
    if (grades.length > 0) {
      return grades;
    }
  }
  return [viscosity];
}

/**
 * Narrows the stored capacity legend to the two kinds a quote may multiply by.
 *
 * Dry fill is never written by this app, so an unrecognised legend is read as `unlabeled`
 * (the volume is real, its legend is not trustworthy) rather than silently dropping liters.
 *
 * @param fillKind - The stored legend, or `null`.
 * @returns `em_servico` when the row says so, otherwise `unlabeled`.
 */
export function readFillKind(fillKind: string | null): FillKind {
  return fillKind === "em_servico" ? "em_servico" : "unlabeled";
}

/**
 * Reads the capacity type (D5) consistently with the liters: priced liters are `with_filter` or
 * `unlabeled` (from the column, else from the legend, on a row written before it); with no
 * liters, an unusable volume is `without_filter` or `dry` with liters above zero, else there is
 * none — a priced type with no liters is no capacity type at all. A value the column should not
 * hold is not trusted. This is the one rule the quote's answer reads (`quote-answer/shown-row.ts`).
 */
export function readFillCondition(
  liters: number | null,
  fillKind: string | null,
  fillCondition: string | null,
  unusableLiters: number | null,
): { fillCondition: FillCondition | null; unusableFillLiters: number | null } {
  if (liters != null) {
    const fromLegend = readFillKind(fillKind) === "em_servico" ? "with_filter" : "unlabeled";
    return { fillCondition: fillCondition === "with_filter" || fillCondition === "unlabeled" ? fillCondition : fromLegend, unusableFillLiters: null };
  }
  if (unusableLiters != null && unusableLiters > 0 && (fillCondition === "without_filter" || fillCondition === "dry")) {
    return { fillCondition, unusableFillLiters: unusableLiters };
  }
  return { fillCondition: null, unusableFillLiters: null };
}

/** The five classes the contract allows; anything else on the row reads as absent. */
const SOURCE_CLASSES: readonly SourceClassification[] = [
  "manufacturer_manual",
  "manufacturer_technical",
  "licensed_database",
  "lubricant_maker_guide",
  "aftermarket_catalog",
];

/**
 * Narrows the stored document class to one the contract accepts.
 *
 * `source_classification` is a TEXT column, so a legacy or hand-written value could hold
 * anything — including `other`, which the searching model can emit but which must never
 * describe a stored source. An unrecognised value is read as absent rather than passed on.
 *
 * @param value - The stored column, or `null`.
 * @returns One of the five classes, or `null`.
 */
export function readClassification(value: string | null): SourceClassification | null {
  return SOURCE_CLASSES.find((cls) => cls === value) ?? null;
}

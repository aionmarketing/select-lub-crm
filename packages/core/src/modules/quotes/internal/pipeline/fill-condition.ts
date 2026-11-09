/**
 * The capacity type of an extracted volume (ingest-harvested-manuals D5), shared by the validator,
 * the Motul reader and the conflict resolution: what an extraction states, or what its older
 * legend implies, and which volumes may price.
 */
import type { FillCondition, FillKind } from "../../contracts/http.js";

/**
 * @param spec - An extraction: its `fillCondition` when it states one, else its `fillKind`.
 * @returns The capacity type; an extraction that predates D5 reads `em_servico` as `with_filter`.
 */
export function fillConditionOf(spec: { fillCondition?: FillCondition | null; fillKind: FillKind | null }): FillCondition | null {
  if (spec.fillCondition !== undefined) return spec.fillCondition;
  if (spec.fillKind === "em_servico") return "with_filter";
  return spec.fillKind === "unlabeled" ? "unlabeled" : null;
}

/** The volume fields a validated extraction carries. */
export type ValidatedFill = {
  fillLiters: number | null;
  fillKind: FillKind | null;
  fillCondition: FillCondition | null;
  unusableFillLiters: number | null;
};

/**
 * Which volume prices (the owner, 2026-09-26): `with_filter`, or `unlabeled` when it is the single
 * volume the source gives — the extractor is told so, and Motul's picker enforces it. A
 * `without_filter` or `dry` volume never prices and is kept aside as `unusableFillLiters`.
 *
 * @param liters - A plausible volume, or null.
 * @param condition - Its capacity type, or null when it has none.
 */
export function validatedFill(liters: number | null, condition: FillCondition | null): ValidatedFill {
  if (liters == null || condition == null) {
    return { fillLiters: null, fillKind: null, fillCondition: null, unusableFillLiters: null };
  }
  if (condition === "with_filter" || condition === "unlabeled") {
    return { fillLiters: liters, fillKind: condition === "with_filter" ? "em_servico" : "unlabeled", fillCondition: condition, unusableFillLiters: null };
  }
  return { fillLiters: null, fillKind: null, fillCondition: condition, unusableFillLiters: liters };
}

/**
 * A Motul payload's volume: the picked service fill as `with_filter` (in service) or `unlabeled`;
 * with neither, the dry volume as `dry`, still worth telling the attendant about (D5).
 *
 * @param picked - What `pickEngineFillLiters` chose, or null.
 * @param dry - Reads the dry volume; called only when nothing was picked.
 */
export function motulFill(
  picked: { liters: number; kind: FillKind } | null,
  dry: () => number | null,
): { fillLiters: number | null; fillKind: FillKind | null; fillCondition: FillCondition | null } {
  if (picked) {
    return { fillLiters: picked.liters, fillKind: picked.kind, fillCondition: picked.kind === "em_servico" ? "with_filter" : "unlabeled" };
  }
  const liters = dry();
  return { fillLiters: liters, fillKind: null, fillCondition: liters == null ? null : "dry" };
}

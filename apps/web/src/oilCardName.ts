/**
 * How an oil card and its message option name the lubricant (add-lubricant-oil-type).
 *
 * The signed-off canvas titles a card `Motul 5100 5W-30` and writes `➡️ Tipo: Sintético` under
 * it: the viscosity is in the name and the oil type in the "Tipo" line. Catalog descriptions
 * rarely carry the grade ("8100 Eco-nergy"), so the name is brand, description and viscosity,
 * leaving the viscosity out only when the description already names that grade.
 */
import { descriptionNamesGrade, type OilType } from "@select-lub/shared-types";

/** pt-BR label of each stored oil type. The contract carries the value; the label is the screen's. */
export const OIL_TYPE_LABEL: Record<OilType, string> = {
  SINTETICO: "Sintético",
  SEMISSINTETICO: "Semissintético",
  MINERAL: "Mineral",
};

/**
 * @param oilType - The lubricant's stored oil type, or `null` when it has none.
 * @returns The pt-BR label, or `null` — an untyped lubricant shows no type at all, never a dash
 * or its viscosity in the type's place.
 */
export function oilTypeLabel(oilType: OilType | null): string | null {
  return oilType == null ? null : OIL_TYPE_LABEL[oilType];
}

/**
 * The card title and the message option line for one lubricant.
 *
 * @param row - The catalog item's brand and description and its lubricant's viscosity.
 * @returns `{brand} {description} {viscosity}`, without the viscosity when the description already
 * names that grade under the SAE normalization.
 */
export function oilCardName(row: { brand: string; description: string; lubricant: { viscosity: string } }): string {
  const base = `${row.brand} ${row.description}`;
  return descriptionNamesGrade(row.description, row.lubricant.viscosity) ? base : `${base} ${row.lubricant.viscosity}`;
}

/**
 * Grid-column → filter-type map for Tecfil's catalogue (`codigoCatalogo`
 * 133), recorded from `tecfil-catalog-config.json`'s
 * `listaResultado.resultadoHorizontal.grid.grupos[0].colunas` on 2026-09-03:
 * `ComplementoAplicacao3_11` / `3_12` are "Filtro Lubrificante 1 / 2" and
 * `3_13` / `3_14` are "Filtro de Combustível 1 / 2". This is a recorded
 * constant, not a runtime lookup — the configuration lives in the front
 * end's RSC payload, not on a documented endpoint. A re-ordered grid shows
 * up as a wrong `pnpm demo` run rather than a silently wrong price; see
 * design.md D3.
 */

import type { TecfilAplicacaoRow } from "./wire.js";

/** Filter type the resolver prices: oil filter or fuel filter, no others in scope. */
export type TecfilFilterKind = "oil" | "fuel";

/** Date the column map below was verified against the live tenant configuration. */
export const TECFIL_COLUMNS_CONFIGURED_AT = "2026-09-03";

/** APLICACAO grid columns whose fitted parts are oil filters ("Filtro Lubrificante 1 / 2"). */
export const OIL_FILTER_COLUMNS = [
  "ComplementoAplicacao3_11",
  "ComplementoAplicacao3_12",
] as const satisfies readonly (keyof TecfilAplicacaoRow & string)[];

/** APLICACAO grid columns whose fitted parts are fuel filters ("Filtro de Combustível 1 / 2"). */
export const FUEL_FILTER_COLUMNS = [
  "ComplementoAplicacao3_13",
  "ComplementoAplicacao3_14",
] as const satisfies readonly (keyof TecfilAplicacaoRow & string)[];

/** Grid columns for each filter type, in the order candidates should be read. */
export const FILTER_TYPE_COLUMNS: Record<
  TecfilFilterKind,
  readonly string[]
> = {
  oil: OIL_FILTER_COLUMNS,
  fuel: FUEL_FILTER_COLUMNS,
};

/**
 * GRUPOPRODUTO code for "Filtros" (the product group the resolver's PRODUTO
 * search filters by), verified via a live `GRUPOPRODUTO` options call on the
 * same date as the column map above — the label travels with the code
 * instead of being retranslated, so this pair is never split into a
 * hard-coded label matched against a separately-hard-coded code.
 */
export const FILTERS_PRODUCT_GROUP = { code: 1, label: "FILTROS" } as const;

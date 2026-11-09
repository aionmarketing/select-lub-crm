/**
 * Building the fitment's candidates from Tecfil's APLICACAO rows: which grid
 * columns hold which part numbers, each joined to its PRODUTO row's
 * cross-references. Pure — no request, no picker.
 *
 * Split out of `resolver.ts` (wave 5.1a) when the package moved into core,
 * whose files are capped at 300 lines; the functions are unchanged.
 */
import type { TecfilCrossReference, TecfilFilterCandidate } from "./resolver.js";
import type { TecfilAplicacaoRow, TecfilFittedPart, TecfilProdutoRow } from "./wire.js";

/** A row with no engine name is a wiper-blade row (or similar non-vehicle fitment), never a vehicle fitment. */
export function isWiperRow(row: TecfilAplicacaoRow): boolean {
  return (row.ComplementoAplicacao3_2 ?? "").trim() === "";
}

function partsInColumns(
  row: TecfilAplicacaoRow,
  columns: readonly string[],
): TecfilFittedPart[] {
  const parts: TecfilFittedPart[] = [];
  for (const column of columns) {
    const value = row[column as keyof TecfilAplicacaoRow];
    if (Array.isArray(value)) parts.push(...(value as TecfilFittedPart[]));
  }
  return parts;
}

/** Same as `partsInColumns`, but paired with the specific column each part came from. */
function partsWithColumn(
  row: TecfilAplicacaoRow,
  columns: readonly string[],
): { part: TecfilFittedPart; column: string }[] {
  const pairs: { part: TecfilFittedPart; column: string }[] = [];
  for (const column of columns) {
    const value = row[column as keyof TecfilAplicacaoRow];
    if (Array.isArray(value)) {
      for (const part of value as TecfilFittedPart[]) pairs.push({ part, column });
    }
  }
  return pairs;
}

export function numberSet(rows: TecfilAplicacaoRow[], columns: readonly string[]): Set<string> {
  const set = new Set<string>();
  for (const row of rows) {
    for (const part of partsInColumns(row, columns)) set.add(part.TituloProduto);
  }
  return set;
}

export function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

/** Distinct part numbers across `columns` for `rows`, each joined to its PRODUTO row's cross-references (when one exists) and the grid column(s) it came from. */
export function buildCandidates(
  rows: TecfilAplicacaoRow[],
  columns: readonly string[],
  productsByNumber: Map<string, TecfilProdutoRow>,
): TecfilFilterCandidate[] {
  const byNumber = new Map<string, TecfilFittedPart>();
  const columnsByNumber = new Map<string, Set<string>>();
  for (const row of rows) {
    for (const { part, column } of partsWithColumn(row, columns)) {
      if (!byNumber.has(part.TituloProduto)) byNumber.set(part.TituloProduto, part);
      const cols = columnsByNumber.get(part.TituloProduto) ?? new Set<string>();
      cols.add(column);
      columnsByNumber.set(part.TituloProduto, cols);
    }
  }

  return [...byNumber.entries()].map(([partNumber, part]) => {
    const product = productsByNumber.get(partNumber);
    const crossReferences: TecfilCrossReference[] = product
      ? product.ReferenciasCruzada.flatMap((brand) =>
          brand.NumerosProduto.map((n) => ({
            brand: brand.DescricaoFabricante,
            partNumber: n.NumeroProduto,
          })),
        )
      : [];
    return {
      partNumber,
      productCode: product?.CodigoProduto ?? part.CodigoProduto,
      description: product?.DescricaoProduto ?? part.TituloProduto,
      crossReferences,
      sourceColumns: [...(columnsByNumber.get(partNumber) ?? [])],
    };
  });
}

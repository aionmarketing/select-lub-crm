/**
 * Types matching the Tecfil Catálogo Expresso JSON, decoded from the
 * obfuscated response body. Only the fields the resolver reads are typed —
 * the live API returns many more per-tenant `CpoAuxProd*` columns; see
 * `docs/tecfil-catalogo-expresso-api.md` for the full shape.
 */

/** One row of `quantidadeDetalhada`: a facet count on a search response. */
export interface TecfilFacetRow {
  Descricao: string;
  Tipo: string;
  Codigo?: number;
  Quantidade: number;
}

/** Response envelope for an `idConsulta=PESQUISA` search (`tipoRetorno` decides the row shape in `data`). */
export interface TecfilSearchEnvelope<T> {
  success: boolean;
  data: T[];
  totalResultado: string;
  quantidadeDetalhada: TecfilFacetRow[];
}

/** One row from a filter-options call (`idConsulta=<filter ID>`), e.g. Montadora or Veículo options. Some filters return `Descricao` only, with no `Codigo`. */
export interface TecfilOption {
  Codigo?: number;
  Descricao: string;
}

/** Response envelope for a filter-options call: a bare list, no paging or facets. */
export interface TecfilOptionsEnvelope {
  success: boolean;
  data: TecfilOption[];
}

/** One fitted part entry inside an APLICACAO row's grid-column array. */
export interface TecfilFittedPart {
  CodigoProduto: number;
  TituloProduto: string;
  CpoAuxProd53?: string;
}

/**
 * One vehicle-fitment row (`tipoRetorno=APLICACAO`). `ComplementoAplicacao3_1`
 * through `3_5` are emission standard, engine, start year, end-year marker,
 * and fuel; `3_6` and upward are each an array of fitted parts for one grid
 * column (the column-to-filter-type mapping lives in `columns.ts`). A row
 * with no engine and no filter columns is a wiper-blade row, not a vehicle
 * fitment, and is excluded by the resolver.
 */
export interface TecfilAplicacaoRow {
  DescricaoFabricante: string;
  CodigoAplicacao: number;
  DescricaoAplicacao: string;
  ComplementoAplicacao3_1?: string;
  ComplementoAplicacao3_2?: string;
  ComplementoAplicacao3_3?: string;
  ComplementoAplicacao3_4?: string;
  ComplementoAplicacao3_5?: string;
  [key: `ComplementoAplicacao3_${number}`]:
    | string
    | TecfilFittedPart[]
    | undefined;
}

/** One cross-reference brand entry on a PRODUTO row's `ReferenciasCruzada`. */
export interface TecfilCrossReferenceBrand {
  DescricaoFabricante: string;
  NumerosProduto: { NumeroProduto: string }[];
}

/** One product row (`tipoRetorno=PRODUTO`), joined to fitment rows by `NumeroProduto`. */
export interface TecfilProdutoRow {
  CodigoProduto: number;
  NumeroProduto: string;
  DescricaoProduto: string;
  ReferenciasCruzada: TecfilCrossReferenceBrand[];
}

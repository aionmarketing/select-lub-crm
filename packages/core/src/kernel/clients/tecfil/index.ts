/**
 * Public entry point for the Tecfil client (`kernel/clients/tecfil`, moved from `packages/tecfil` in wave 5.1a) — HTTP client, wire types,
 * filter encoding/decoding, the column map, and the fitment resolver.
 */

export { tecfilGet, TecfilError, TECFIL_DEFAULT_BASE_URL } from "./client.js";

export { encodeFiltros } from "./filtros.js";
export type { TecfilFilterValue, TecfilFilters } from "./filtros.js";

export { decodeTecfilBody, TecfilDecodeError } from "./decode.js";

export {
  FILTER_TYPE_COLUMNS,
  FILTERS_PRODUCT_GROUP,
  FUEL_FILTER_COLUMNS,
  OIL_FILTER_COLUMNS,
  TECFIL_COLUMNS_CONFIGURED_AT,
} from "./columns.js";
export type { TecfilFilterKind } from "./columns.js";

export {
  normalizeTecfilName,
  resolveFilters,
} from "./resolver.js";
export type {
  MatchedByKind,
  PickableField,
  ResolveField,
  ResolveFiltersResult,
  TecfilCrossReference,
  TecfilFilterCandidate,
  TecfilFitment,
  TecfilIdentity,
  TecfilOptionPicker,
} from "./resolver.js";

export type {
  TecfilAplicacaoRow,
  TecfilCrossReferenceBrand,
  TecfilFacetRow,
  TecfilFittedPart,
  TecfilOption,
  TecfilOptionsEnvelope,
  TecfilProdutoRow,
  TecfilSearchEnvelope,
} from "./wire.js";

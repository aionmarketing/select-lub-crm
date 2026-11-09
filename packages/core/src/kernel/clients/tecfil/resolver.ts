/**
 * Deterministic Tecfil catalogue resolver: walks Montadora → Veículo →
 * fitment rows → cross-references (the four-request chain, design D2),
 * matching a CRM vehicle identity to Tecfil oil-filter and fuel-filter
 * candidates. Manufacturer and vehicle match exact-then-picker; engine
 * matches exact → unanimity → picker (design D4). No LLM SDK — the picker
 * is a callback the caller injects.
 */

import { FILTERS_PRODUCT_GROUP, FUEL_FILTER_COLUMNS, OIL_FILTER_COLUMNS } from "./columns.js";
import { tecfilGet } from "./client.js";
import { encodeFiltros } from "./filtros.js";
import { buildCandidates, isWiperRow, numberSet, sameSet } from "./candidates.js";
import type {
  TecfilAplicacaoRow,
  TecfilOption,
  TecfilOptionsEnvelope,
  TecfilProdutoRow,
  TecfilSearchEnvelope,
} from "./wire.js";

/** CRM vehicle identity the resolver matches against Tecfil's catalogue. */
export interface TecfilIdentity {
  make: string;
  year: string;
  model: string;
  version: string;
}

/** Identity field the resolver still needs, or could not match against Tecfil's catalogue. */
export type ResolveField = "manufacturer" | "year" | "vehicle" | "engine";

/** Fields the injected picker is ever asked to disambiguate; `"year"` is a search filter and is never picked. */
export type PickableField = Exclude<ResolveField, "year">;

/** How one identity field was matched: normalized-name equality, engine unanimity, or an injected picker. */
export type MatchedByKind = "exact" | "unanimous" | "picked";

/**
 * Callback the caller injects to disambiguate a name Tecfil's option list
 * has no exact match for. Must resolve to one of `options` verbatim to
 * count as a pick — any other string, or `null`, counts as no pick.
 *
 * @param field - Which identity field is being disambiguated.
 * @param query - The CRM value that matched no Tecfil option exactly.
 * @param context - The full CRM identity, for the picker's own context.
 * @param options - Tecfil's own option labels for `field`, verbatim.
 */
export type TecfilOptionPicker = (
  field: PickableField,
  query: string,
  context: TecfilIdentity,
  options: string[],
) => Promise<string | null>;

/** One cross-reference: another brand's number for the same physical part. */
export interface TecfilCrossReference {
  brand: string;
  partNumber: string;
}

/** One fitted filter candidate: the Tecfil number, its product identity, cross-references, and which grid column(s) it came from. */
export interface TecfilFilterCandidate {
  partNumber: string;
  productCode: number;
  description: string;
  crossReferences: TecfilCrossReference[];
  /** APLICACAO grid columns (e.g. `ComplementoAplicacao3_11`) this number was found in — design D3: a re-ordered grid shows up here, not as a silently wrong price. */
  sourceColumns: string[];
}

/** A resolved fitment: the Tecfil application used, how each field matched, and the filter candidates. */
export interface TecfilFitment {
  manufacturerLabel: string;
  vehicleLabel: string;
  engineLabel: string | null;
  matchedBy: {
    manufacturer: Exclude<MatchedByKind, "unanimous">;
    vehicle: Exclude<MatchedByKind, "unanimous">;
    engine: MatchedByKind;
  };
  oilFilters: TecfilFilterCandidate[];
  fuelFilters: TecfilFilterCandidate[];
}

/** Outcome of `resolveFilters`. */
export type ResolveFiltersResult =
  | { status: "needs"; field: ResolveField }
  | { status: "unmatched"; field: ResolveField; options: string[] }
  | { status: "ok"; fitment: TecfilFitment }
  | { status: "unavailable" };

/**
 * Strips diacritics and non-alphanumeric characters, then uppercases, for
 * Tecfil name comparison. Same algorithm as the Motul client's
 * `normalizeMotulName`, re-implemented locally to keep this package
 * dependency-free (design D4).
 *
 * @param s - Display name from the CRM or from Tecfil.
 * @returns Uppercase alphanumeric-only key; empty string when `s` has no letters or digits.
 */
export function normalizeTecfilName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function findExact(options: TecfilOption[], query: string): TecfilOption | undefined {
  const target = normalizeTecfilName(query);
  return options.find((o) => normalizeTecfilName(o.Descricao) === target);
}

/** Asks the injected picker, if any, and resolves its reply back to the matching option (or `undefined` for no pick). */
async function pickFromOptions(
  pickOption: TecfilOptionPicker | undefined,
  field: PickableField,
  query: string,
  context: TecfilIdentity,
  options: TecfilOption[],
): Promise<TecfilOption | undefined> {
  if (!pickOption || options.length === 0) return undefined;
  const labels = options.map((o) => o.Descricao);
  const reply = await pickOption(field, query, context, labels);
  if (reply === null) return undefined;
  return options.find((o) => o.Descricao === reply);
}

/**
 * Resolves a CRM vehicle identity to Tecfil oil-filter and fuel-filter
 * candidates via the four-request Tecfil chain.
 *
 * @param identity - `make`/`model`/`version` are matched by name (exact,
 *   then the injected picker; `version` also tries unanimity across engine
 *   variants before the picker); `year` is sent as a search filter and is
 *   never picked.
 * @param opts.pickOption - Injected disambiguation callback; when omitted, a
 *   field that fails exact matching (and, for the engine, unanimity) is `unmatched`.
 * @returns `needs` when an identity field is empty; `unmatched` when a
 *   provided field matches no Tecfil option (carrying Tecfil's own options
 *   for that field); `ok` with the fitment; `unavailable` when a Tecfil
 *   request fails after retries or a response cannot be decoded. Never throws.
 */
export async function resolveFilters(
  identity: TecfilIdentity,
  opts: { pickOption?: TecfilOptionPicker } = {},
): Promise<ResolveFiltersResult> {
  const { make, year, model, version } = identity;
  const { pickOption } = opts;

  if (!make) return { status: "needs", field: "manufacturer" };
  if (!year) return { status: "needs", field: "year" };
  if (!model) return { status: "needs", field: "vehicle" };
  if (!version) return { status: "needs", field: "engine" };

  try {
    // Call 1: Montadora options -> match manufacturer.
    const manufacturers = await tecfilGet<TecfilOptionsEnvelope>("consulta", {
      idConsulta: "FABRICANTEAPLICACAO",
      tabAtiva: "0",
      filtros: "",
    });
    let manufacturer = findExact(manufacturers.data, make);
    let manufacturerMatchedBy: Exclude<MatchedByKind, "unanimous"> = "exact";
    if (!manufacturer) {
      const picked = await pickFromOptions(
        pickOption,
        "manufacturer",
        make,
        identity,
        manufacturers.data,
      );
      if (!picked) {
        return {
          status: "unmatched",
          field: "manufacturer",
          options: manufacturers.data.map((o) => o.Descricao),
        };
      }
      manufacturer = picked;
      manufacturerMatchedBy = "picked";
    }

    // Call 2: Veículo options filtered by the matched Montadora -> match vehicle.
    const vehicles = await tecfilGet<TecfilOptionsEnvelope>("consulta", {
      idConsulta: "APLICACAO",
      tabAtiva: "0",
      filtros: encodeFiltros({
        FABRICANTEAPLICACAO: { value: manufacturer.Descricao, code: manufacturer.Codigo },
      }),
    });
    let vehicle = findExact(vehicles.data, model);
    let vehicleMatchedBy: Exclude<MatchedByKind, "unanimous"> = "exact";
    if (!vehicle) {
      const picked = await pickFromOptions(pickOption, "vehicle", model, identity, vehicles.data);
      if (!picked) {
        return {
          status: "unmatched",
          field: "vehicle",
          options: vehicles.data.map((o) => o.Descricao),
        };
      }
      vehicle = picked;
      vehicleMatchedBy = "picked";
    }

    // Call 3: fitment rows (APLICACAO) for Montadora + Veículo + year.
    const fitmentSearch = await tecfilGet<TecfilSearchEnvelope<TecfilAplicacaoRow>>(
      "consulta",
      {
        idConsulta: "PESQUISA",
        tabAtiva: "0",
        filtros: encodeFiltros({
          FABRICANTEAPLICACAO: { value: manufacturer.Descricao, code: manufacturer.Codigo },
          APLICACAO: { value: vehicle.Descricao, code: vehicle.Codigo },
          AplicacaoAnoDeAte: { value: year },
        }),
        ordenacao: "filtros",
        tipoRetorno: "APLICACAO",
        limit: "30",
        offset: "0",
      },
    );
    const fitmentRows = fitmentSearch.data.filter((row) => !isWiperRow(row));
    if (fitmentRows.length === 0) {
      return { status: "unmatched", field: "year", options: [] };
    }

    // Engine: exact -> unanimity -> picker.
    let engineRows: TecfilAplicacaoRow[];
    let engineLabel: string | null;
    let engineMatchedBy: MatchedByKind;

    const exactEngineRow = fitmentRows.find(
      (row) =>
        normalizeTecfilName(row.ComplementoAplicacao3_2 ?? "") === normalizeTecfilName(version),
    );
    if (exactEngineRow) {
      const label = exactEngineRow.ComplementoAplicacao3_2 as string;
      engineRows = fitmentRows.filter((row) => row.ComplementoAplicacao3_2 === label);
      engineLabel = label;
      engineMatchedBy = "exact";
    } else {
      const groups = new Map<string, TecfilAplicacaoRow[]>();
      for (const row of fitmentRows) {
        const key = row.ComplementoAplicacao3_2 as string;
        const list = groups.get(key) ?? [];
        list.push(row);
        groups.set(key, list);
      }
      const groupEntries = [...groups.entries()];
      const oilSets = groupEntries.map(([, rows]) => numberSet(rows, OIL_FILTER_COLUMNS));
      const fuelSets = groupEntries.map(([, rows]) => numberSet(rows, FUEL_FILTER_COLUMNS));
      const unanimous =
        oilSets.length > 0 &&
        oilSets.every((s) => sameSet(s, oilSets[0])) &&
        fuelSets.every((s) => sameSet(s, fuelSets[0]));

      if (unanimous) {
        engineRows = fitmentRows;
        engineLabel = null;
        engineMatchedBy = "unanimous";
      } else {
        const engineOptions: TecfilOption[] = groupEntries.map(([label]) => ({
          Descricao: label,
        }));
        const picked = await pickFromOptions(pickOption, "engine", version, identity, engineOptions);
        if (!picked) {
          return {
            status: "unmatched",
            field: "engine",
            options: engineOptions.map((o) => o.Descricao),
          };
        }
        engineRows = groups.get(picked.Descricao) ?? [];
        engineLabel = picked.Descricao;
        engineMatchedBy = "picked";
      }
    }

    // Call 4: PRODUTO search (same Montadora + Veículo + year, Filtros group) for cross-references.
    const produtoSearch = await tecfilGet<TecfilSearchEnvelope<TecfilProdutoRow>>("consulta", {
      idConsulta: "PESQUISA",
      tabAtiva: "0",
      filtros: encodeFiltros({
        FABRICANTEAPLICACAO: { value: manufacturer.Descricao, code: manufacturer.Codigo },
        APLICACAO: { value: vehicle.Descricao, code: vehicle.Codigo },
        AplicacaoAnoDeAte: { value: year },
        GRUPOPRODUTO: {
          value: FILTERS_PRODUCT_GROUP.label,
          code: FILTERS_PRODUCT_GROUP.code,
        },
      }),
      ordenacao: "produtos",
      tipoRetorno: "PRODUTO",
      limit: "60",
      offset: "0",
    });
    const productsByNumber = new Map(
      produtoSearch.data.map((p) => [p.NumeroProduto, p] as const),
    );

    return {
      status: "ok",
      fitment: {
        manufacturerLabel: manufacturer.Descricao,
        vehicleLabel: vehicle.Descricao,
        engineLabel,
        matchedBy: {
          manufacturer: manufacturerMatchedBy,
          vehicle: vehicleMatchedBy,
          engine: engineMatchedBy,
        },
        oilFilters: buildCandidates(engineRows, OIL_FILTER_COLUMNS, productsByNumber),
        fuelFilters: buildCandidates(engineRows, FUEL_FILTER_COLUMNS, productsByNumber),
      },
    };
  } catch {
    return { status: "unavailable" };
  }
}

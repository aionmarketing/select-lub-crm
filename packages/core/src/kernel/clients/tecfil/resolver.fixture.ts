/**
 * The recorded Tecfil responses the `resolveFilters` suites replay
 * (`resolver.test.ts`, `resolver.unmatched.test.ts`), and `dispatch`, which
 * routes the mocked `tecfilGet` to them by `idConsulta` / `tipoRetorno`.
 *
 * Split out of `resolver.test.ts` (wave 5.1a) when `packages/tecfil` moved into
 * `packages/core`, whose files are capped at 300 lines; unchanged but for
 * `export`. Reads files only — no network.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  TecfilAplicacaoRow,
  TecfilOptionsEnvelope,
  TecfilProdutoRow,
  TecfilSearchEnvelope,
} from "./wire.js";

export const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "./fixtures");

export function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(fixturesDir, name), "utf8")) as T;
}

export const manufacturers = loadFixture<TecfilOptionsEnvelope>("manufacturers.json");
export const peugeotVehicles = loadFixture<TecfilOptionsEnvelope>("peugeot-vehicles.json");
export const sampleAplicacao = loadFixture<TecfilSearchEnvelope<TecfilAplicacaoRow>>(
  "peugeot-207-2011-aplicacao.json",
);
export const sampleProduto = loadFixture<TecfilSearchEnvelope<TecfilProdutoRow>>(
  "peugeot-207-2011-produto.json",
);
export const divergentEngines = loadFixture<TecfilSearchEnvelope<TecfilAplicacaoRow>>(
  "divergent-engines-aplicacao.json",
);
export const bothFuelColumns = loadFixture<TecfilSearchEnvelope<TecfilAplicacaoRow>>(
  "both-fuel-columns-aplicacao.json",
);
export const peugeotVehicleLabels = peugeotVehicles.data.map((o) => o.Descricao);
export const emptyProduto: TecfilSearchEnvelope<TecfilProdutoRow> = {
  success: true,
  data: [],
  totalResultado: "0",
  quantidadeDetalhada: [],
};

export interface Fixtures {
  manufacturers?: TecfilOptionsEnvelope;
  vehicles?: TecfilOptionsEnvelope;
  aplicacao?: TecfilSearchEnvelope<TecfilAplicacaoRow>;
  produto?: TecfilSearchEnvelope<TecfilProdutoRow>;
}

/** Routes the mocked `tecfilGet` to canned fixtures by `idConsulta`/`tipoRetorno`, mirroring the four-call chain. */
export function dispatch(fixtures: Fixtures) {
  return async (_path: string, params: Record<string, string>) => {
    if (params.idConsulta === "FABRICANTEAPLICACAO") return fixtures.manufacturers;
    if (params.idConsulta === "APLICACAO") return fixtures.vehicles;
    if (params.idConsulta === "PESQUISA" && params.tipoRetorno === "APLICACAO") {
      return fixtures.aplicacao;
    }
    if (params.idConsulta === "PESQUISA" && params.tipoRetorno === "PRODUTO") {
      return fixtures.produto;
    }
    throw new Error(`resolver.test.ts fake tecfilGet: unexpected call ${JSON.stringify(params)}`);
  };
}

export const sampleIdentity = { make: "PEUGEOT", year: "2011", model: "207", version: "1.4 8V" };

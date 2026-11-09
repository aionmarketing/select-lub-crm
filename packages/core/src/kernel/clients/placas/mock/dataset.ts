/**
 * Canned plate → vehicle rows for `PLACAS_MOCK=1`. Several plates resolve to
 * different cars; additional rows exercise the same omissions as the hand-derived
 * `agregados-propria` fixtures.
 */
import { mapAgregadosPropriaData } from "../map-agregados.js";
import type { LookupResult, PlateFields } from "../port.js";
import { foundOrNotFound } from "../port.js";

/** One canned vehicle, keyed by already-normalized plate. */
export type MockPlateRow = {
  plate: string;
  /** Inner `agregados-propria` `data` object, or `null` for a canned miss. */
  data: Record<string, unknown> | null;
};

const GOL_BASE = {
  marca: "VW",
  modelo: "GOL 1.0",
  modeloDetalhes: { sintetico: "GOL" },
  versao: "1.0 FLEX 12V 4P",
  ano_modelo: 2021,
  ano_fabricacao: 2020,
  cilindradas: 999,
  combustivel: "ALCOOL/GASOLINA",
} as const;

/**
 * Returns a fresh copy of the canned dataset.
 *
 * @returns Rows cloned so callers cannot mutate the module catalog.
 */
export function mockPlacasDataset(): MockPlateRow[] {
  return structuredClone([
    { plate: "ABC1D23", data: { ...GOL_BASE } },
    {
      plate: "DEF2E34",
      data: {
        marca: "HONDA",
        modelo: "FIT 1.5",
        modeloDetalhes: { sintetico: "FIT" },
        versao: "EXL 1.5 16V",
        ano_modelo: 2019,
        cilindradas: 1497,
        combustivel: "GASOLINA",
      },
    },
    {
      plate: "GHI1234",
      data: {
        marca: "FIAT",
        modelo: "ARGO 1.0",
        modeloDetalhes: { sintetico: "ARGO" },
        ano_modelo: 2022,
        cilindradas: 999,
        combustivel: "FLEX",
      },
    },
    {
      plate: "JKL1A23",
      data: {
        marca: "GM",
        modelo: "ONIX 1.0",
        versao: "LT 1.0 12V",
        ano_modelo: 2020,
        cilindradas: 999,
        combustivel: "FLEX",
      },
    },
    {
      plate: "MNO4B56",
      data: {
        marca: "TOYOTA",
        modelo: "COROLLA",
        modeloDetalhes: { sintetico: "   ", nome: "" },
        versao: "",
        ano_modelo: 2018,
        cilindradas: 0,
        combustivel: "00000000000",
      },
    },
    { plate: "PQR5678", data: null },
  ] satisfies MockPlateRow[]);
}

/**
 * Maps one canned row through the same `agregados-propria` mapper production uses.
 *
 * @param row - Dataset row; `data: null` is a miss.
 * @returns A mock-sourced `found` or `not_found` result, never billed.
 */
export function mockRowOutcome(row: MockPlateRow): LookupResult {
  if (row.data === null) {
    return foundOrNotFound({}, { source: "mock", provider: "mock", billed: false });
  }
  return foundOrNotFound(mapAgregadosPropriaData(row.data), {
    source: "mock",
    provider: "mock",
    billed: false,
  });
}

/**
 * Expected mapped fields for tests, derived from the same mapper as production.
 *
 * @param plate - Normalized plate present in {@link mockPlacasDataset}.
 * @returns Mapped fields, possibly empty for a canned miss.
 */
export function mockExpectedFields(plate: string): PlateFields {
  const row = mockPlacasDataset().find((item) => item.plate === plate);
  if (!row?.data) {
    return {};
  }
  return mapAgregadosPropriaData(row.data);
}

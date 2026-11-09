/**
 * Test design (testing-strategy)
 *
 * Setup: temp JSON via mkdtempSync. createMockOmie(env). fetch stubbed.
 *   Package tests MUST NOT read `tid_archive`.
 *
 * Oracle: omie-mock — unset flag lists omie-mock-linked; missing file throws;
 *   tiny generated fixture lists a digits-only client id; no network.
 *
 * Axes: A1 OMIE_MOCK_DATASET unset / tidsci; A2 file present / missing.
 * Outputs: O1 fixture linked id; O2 TidsciDatasetMissingError; O3 digits id.
 *
 * Decision: flag unset → mockOmieDataset; set + missing → throw (no fixture
 *   fallback); set + present → JSON; fetch never called.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createMockOmie } from "../source.js";
import { TidsciDatasetMissingError } from "./load.js";

async function withFetchGuard(run: () => Promise<void>) {
  const fetchSpy = vi.fn();
  const previous = globalThis.fetch;
  globalThis.fetch = fetchSpy as typeof fetch;
  try {
    await run();
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    globalThis.fetch = previous;
  }
}

describe("createMockOmie dataset selection", () => {
  it("lists the fixture linked client when the TIDSCI opt-in is unset", async () => {
    await withFetchGuard(async () => {
      const mock = createMockOmie({});
      const page = await mock.clients.listPage(1);
      expect(page.clients.some((row) => row.omieId === "omie-mock-linked")).toBe(true);
      expect(page.clients.some((row) => /^\d{10,12}$/.test(row.omieId))).toBe(false);
    });
  });

  it("throws when OMIE_MOCK_DATASET=tidsci and the generated file is missing", async () => {
    await withFetchGuard(async () => {
      expect(() =>
        createMockOmie({
          OMIE_MOCK_DATASET: "tidsci",
          OMIE_MOCK_TIDSCI_PATH: join(tmpdir(), "select-lub-missing-tidsci.json"),
        }),
      ).toThrow(TidsciDatasetMissingError);
    });
  });

  it("serves a tiny generated fixture with a digits-only client id and no network", async () => {
    await withFetchGuard(async () => {
      const dir = mkdtempSync(join(tmpdir(), "tidsci-ds-"));
      const path = join(dir, "dataset.json");
      writeFileSync(
        path,
        JSON.stringify({
          clients: [
            {
              omieId: "1234567890",
              alteredAt: "1970-01-01T00:00:00.000Z",
              snapshot: { razao_social: "TIDSCI Tiny", cnpj_cpf: null, telefone: null, email: null, endereco: null, endereco_numero: null, bairro: null, complemento: null, cidade: null, estado: null, cep: null, codigo_pais: "1058", caracteristicas: [] },
            },
          ],
          serviceOrders: [],
          products: [],
          vehicleIds: [],
          duplicatePairs: [],
        }),
      );

      const mock = createMockOmie({
        OMIE_MOCK_DATASET: "tidsci",
        OMIE_MOCK_TIDSCI_PATH: path,
      });
      const page = await mock.clients.listPage(1);
      expect(page.clients.map((row) => row.omieId)).toEqual(["1234567890"]);
      expect(page.clients.some((row) => row.omieId === "omie-mock-linked")).toBe(false);
    });
  });
});

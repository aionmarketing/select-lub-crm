/**
 * Test design (testing-strategy) — `resolveFilters`: rows it must exclude, and
 * the unmatched and unavailable outcomes
 *
 * Split out of `resolver.test.ts` (wave 5.1a) when `packages/tecfil` moved into
 * `packages/core`, whose files are capped at 300 lines; cases and assertions
 * unchanged, under the same describe title and `afterEach`. The file's full
 * test-design header (oracle, partitions, decision map) stays in
 * `resolver.test.ts`; the recorded responses are `resolver.fixture.ts`.
 * `tecfilGet` is mocked, so no case reaches Tecfil.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { tecfilGet } from "./client.js";
import { resolveFilters } from "./resolver.js";
import type { TecfilAplicacaoRow, TecfilSearchEnvelope } from "./wire.js";
import {
  dispatch,
  divergentEngines,
  emptyProduto,
  manufacturers,
  peugeotVehicles,
  sampleIdentity,
} from "./resolver.fixture.js";

vi.mock("./client.js", () => ({ tecfilGet: vi.fn() }));

const mockedGet = vi.mocked(tecfilGet);
describe("resolveFilters", () => {
  afterEach(() => {
    mockedGet.mockReset();
  });

  it("excludes a wiper-blade row from engine options and from candidates", async () => {
    const withWiperRow: TecfilSearchEnvelope<TecfilAplicacaoRow> = {
      ...divergentEngines,
      data: [
        ...divergentEngines.data,
        {
          DescricaoFabricante: "FIAT",
          CodigoAplicacao: 900099,
          DescricaoAplicacao: "UNO",
          ComplementoAplicacao3_2: "",
          ComplementoAplicacao3_33: "TG",
        } as TecfilAplicacaoRow,
      ],
    };
    mockedGet.mockImplementation(
      dispatch({
        manufacturers,
        vehicles: peugeotVehicles,
        aplicacao: withWiperRow,
        produto: emptyProduto,
      }),
    );
    const pickOption = vi.fn(async (field: string) =>
      field === "engine" ? "1.4 8V FLEX" : null,
    );

    const result = await resolveFilters(
      { ...sampleIdentity, version: "1.4 FLEX" },
      { pickOption },
    );

    expect(pickOption).toHaveBeenCalledWith(
      "engine",
      "1.4 FLEX",
      expect.anything(),
      ["1.0 8V FLEX", "1.4 8V FLEX"],
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.fitment.oilFilters.map((f) => f.partNumber)).toEqual(["PSL456"]);
  });

  it("is unmatched with field year and makes no PRODUTO call when the year has zero fitment rows", async () => {
    const emptyAplicacao: TecfilSearchEnvelope<TecfilAplicacaoRow> = {
      success: true,
      data: [],
      totalResultado: "0",
      quantidadeDetalhada: [],
    };
    mockedGet.mockImplementation(
      dispatch({ manufacturers, vehicles: peugeotVehicles, aplicacao: emptyAplicacao }),
    );

    const result = await resolveFilters(sampleIdentity);

    expect(result).toEqual({ status: "unmatched", field: "year", options: [] });
    expect(mockedGet).toHaveBeenCalledTimes(3);
  });

  it("is unavailable, and does not throw, when a Tecfil call fails after retries", async () => {
    mockedGet.mockImplementation(async () => {
      throw new Error("tecfil consulta status:502");
    });

    const result = await resolveFilters(sampleIdentity);

    expect(result).toEqual({ status: "unavailable" });
  });

  it.each([
    ["make", { ...sampleIdentity, make: "" }, "manufacturer"],
    ["year", { ...sampleIdentity, year: "" }, "year"],
    ["model", { ...sampleIdentity, model: "" }, "vehicle"],
    ["version", { ...sampleIdentity, version: "" }, "engine"],
  ] as const)("needs field %s when %s is empty, with no Tecfil calls", async (_label, identity, field) => {
    const result = await resolveFilters(identity);

    expect(result).toEqual({ status: "needs", field });
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it("is unmatched with field manufacturer when the picker declines a manufacturer that matches no option exactly", async () => {
    mockedGet.mockImplementation(
      dispatch({ manufacturers, vehicles: peugeotVehicles }),
    );
    const pickOption = vi.fn(async () => null);

    const result = await resolveFilters(
      { ...sampleIdentity, make: "Peugeau" },
      { pickOption },
    );

    expect(result).toEqual({
      status: "unmatched",
      field: "manufacturer",
      options: manufacturers.data.map((o) => o.Descricao),
    });
    expect(pickOption).toHaveBeenCalledWith(
      "manufacturer",
      "Peugeau",
      { ...sampleIdentity, make: "Peugeau" },
      manufacturers.data.map((o) => o.Descricao),
    );
    expect(mockedGet).toHaveBeenCalledTimes(1);
  });

  it("is unmatched with field engine when divergent engines and the picker declines", async () => {
    mockedGet.mockImplementation(
      dispatch({
        manufacturers,
        vehicles: peugeotVehicles,
        aplicacao: divergentEngines,
      }),
    );
    const pickOption = vi.fn(async () => null);

    const result = await resolveFilters(
      { ...sampleIdentity, version: "1.4 FLEX" },
      { pickOption },
    );

    expect(result).toEqual({
      status: "unmatched",
      field: "engine",
      options: ["1.0 8V FLEX", "1.4 8V FLEX"],
    });
    // 3 calls: manufacturer options, vehicle options, fitment search — no PRODUTO call.
    expect(mockedGet).toHaveBeenCalledTimes(3);
  });
});

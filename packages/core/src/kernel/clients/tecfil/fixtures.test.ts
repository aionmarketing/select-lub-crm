/**
 * Test design (testing-strategy)
 *
 * Setup: reads every file in `fixtures/`, no HTTP. Four are recorded from
 * the live Catálogo Expresso API on 2026-09-04 for `PEUGEOT` / `207` / 2011
 * (manufacturers, PEUGEOT vehicles, the APLICACAO search, the PRODUTO
 * search); two are hand-built for shapes that vehicle doesn't exercise —
 * `divergent-engines-aplicacao.json` (engines with different oil filters,
 * for the picker path) and `both-fuel-columns-aplicacao.json` (both fuel
 * grid columns filled).
 *
 * Spec: openspec/changes/tecfil-filter-pricing/specs/tecfil-fitment/spec.md
 * — every scenario `resolver.test.ts` (a later task) will exercise reads
 * one of these fixtures; this file guards that the recorded/hand-built JSON
 * still matches the `wire.ts` contract those tests assume.
 *
 * Techniques: EP per fixture kind — options envelope, APLICACAO search
 * envelope, PRODUTO search envelope with cross-references. The package has
 * no runtime schema validator (design D1: no dependency beyond Node), so
 * "parses against wire.ts types" here means plain-assertion shape checks
 * mirroring the fields `wire.ts` declares, on the real recorded JSON.
 *
 * Out of scope: fields `wire.ts` does not type (the live API returns many
 * more per-tenant columns; only the fields the resolver reads are covered).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type {
  TecfilAplicacaoRow,
  TecfilFittedPart,
  TecfilOptionsEnvelope,
  TecfilProdutoRow,
  TecfilSearchEnvelope,
} from "./wire.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "./fixtures");

function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(fixturesDir, name), "utf8")) as T;
}

function expectOption(option: { Codigo?: number; Descricao: string }) {
  expect(typeof option.Descricao).toBe("string");
  if (option.Codigo !== undefined) {
    expect(typeof option.Codigo).toBe("number");
  }
}

function expectFittedPart(part: { CodigoProduto: number; TituloProduto: string }) {
  expect(typeof part.CodigoProduto).toBe("number");
  expect(typeof part.TituloProduto).toBe("string");
}

function expectAplicacaoRow(row: TecfilAplicacaoRow) {
  expect(typeof row.DescricaoFabricante).toBe("string");
  expect(typeof row.CodigoAplicacao).toBe("number");
  expect(typeof row.DescricaoAplicacao).toBe("string");
}

describe("fixtures match wire.ts", () => {
  it("manufacturers.json is a TecfilOptionsEnvelope with PEUGEOT (code 144)", () => {
    const envelope = loadFixture<TecfilOptionsEnvelope>("manufacturers.json");

    expect(envelope.success).toBe(true);
    expect(Array.isArray(envelope.data)).toBe(true);
    envelope.data.forEach(expectOption);

    const peugeot = envelope.data.find((o) => o.Descricao === "PEUGEOT");
    expect(peugeot?.Codigo).toBe(144);
  });

  it("peugeot-vehicles.json is a TecfilOptionsEnvelope with 207 (code 184842)", () => {
    const envelope = loadFixture<TecfilOptionsEnvelope>("peugeot-vehicles.json");

    expect(envelope.success).toBe(true);
    envelope.data.forEach(expectOption);

    const vehicle207 = envelope.data.find((o) => o.Descricao === "207");
    expect(vehicle207?.Codigo).toBe(184842);
  });

  it("peugeot-207-2011-aplicacao.json is a TecfilSearchEnvelope<TecfilAplicacaoRow> with the sample vehicle's fitment", () => {
    const envelope =
      loadFixture<TecfilSearchEnvelope<TecfilAplicacaoRow>>(
        "peugeot-207-2011-aplicacao.json",
      );

    expect(envelope.success).toBe(true);
    expect(typeof envelope.totalResultado).toBe("string");
    envelope.data.forEach(expectAplicacaoRow);

    const engineRows = envelope.data.filter(
      (row) => (row.ComplementoAplicacao3_2 ?? "") !== "",
    );
    expect(engineRows.length).toBeGreaterThan(0);
    for (const row of engineRows) {
      const oil1 = row.ComplementoAplicacao3_11 as TecfilFittedPart[];
      expect(Array.isArray(oil1)).toBe(true);
      oil1.forEach(expectFittedPart);
      expect(oil1[0]?.TituloProduto).toBe("PEL108");

      const fuel1 = row.ComplementoAplicacao3_13 as TecfilFittedPart[];
      expect(fuel1[0]?.TituloProduto).toBe("GI50/7");
    }

    // The fitment search includes a wiper-blade row: no engine, no filter columns.
    const wiperRow = envelope.data.find(
      (row) => (row.ComplementoAplicacao3_2 ?? "") === "",
    );
    expect(wiperRow?.ComplementoAplicacao3_11).toBeUndefined();
  });

  it("peugeot-207-2011-produto.json is a TecfilSearchEnvelope<TecfilProdutoRow> with PEL108's cross-references", () => {
    const envelope =
      loadFixture<TecfilSearchEnvelope<TecfilProdutoRow>>(
        "peugeot-207-2011-produto.json",
      );

    expect(envelope.success).toBe(true);
    for (const row of envelope.data) {
      expect(typeof row.CodigoProduto).toBe("number");
      expect(typeof row.NumeroProduto).toBe("string");
      expect(typeof row.DescricaoProduto).toBe("string");
      expect(Array.isArray(row.ReferenciasCruzada)).toBe(true);
      for (const brand of row.ReferenciasCruzada) {
        expect(typeof brand.DescricaoFabricante).toBe("string");
        expect(Array.isArray(brand.NumerosProduto)).toBe(true);
      }
    }

    const oilProduct = envelope.data.find((p) => p.NumeroProduto === "PEL108");
    const authomixCrossRef = oilProduct?.ReferenciasCruzada.find(
      (b) => b.DescricaoFabricante === "Authomix",
    );
    expect(authomixCrossRef?.NumerosProduto[0]?.NumeroProduto).toBe("FOL0108");
  });

  it("divergent-engines-aplicacao.json has two engines with different oil filters", () => {
    const envelope =
      loadFixture<TecfilSearchEnvelope<TecfilAplicacaoRow>>(
        "divergent-engines-aplicacao.json",
      );

    envelope.data.forEach(expectAplicacaoRow);
    const oilNumbers = envelope.data.map(
      (row) =>
        (row.ComplementoAplicacao3_11 as TecfilFittedPart[])[0]?.TituloProduto,
    );
    expect(new Set(oilNumbers).size).toBe(envelope.data.length);
  });

  it("both-fuel-columns-aplicacao.json fills both fuel grid columns with different numbers", () => {
    const envelope =
      loadFixture<TecfilSearchEnvelope<TecfilAplicacaoRow>>(
        "both-fuel-columns-aplicacao.json",
      );

    const row = envelope.data[0] as TecfilAplicacaoRow;
    expectAplicacaoRow(row);
    const fuel1 = (row.ComplementoAplicacao3_13 as TecfilFittedPart[])[0]
      ?.TituloProduto;
    const fuel2 = (row.ComplementoAplicacao3_14 as TecfilFittedPart[])[0]
      ?.TituloProduto;
    expect(fuel1).toBeTruthy();
    expect(fuel2).toBeTruthy();
    expect(fuel1).not.toBe(fuel2);
  });

  it("raw-obfuscated-body.decoded.json is a TecfilSearchEnvelope<TecfilAplicacaoRow>", () => {
    const envelope =
      loadFixture<TecfilSearchEnvelope<TecfilAplicacaoRow>>(
        "raw-obfuscated-body.decoded.json",
      );

    expect(envelope.success).toBe(true);
    envelope.data.forEach(expectAplicacaoRow);
  });
});

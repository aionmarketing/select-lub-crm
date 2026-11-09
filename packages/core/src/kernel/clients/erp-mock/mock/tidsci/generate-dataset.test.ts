/**
 * Test design (testing-strategy)
 *
 * Setup: generateTidsciDataset with an in-memory archive, stub parser, temp
 *   cache+output. No OpenAI, no tid_archive, fetch stubbed.
 *
 * Oracle: omie-mock catalog — RADNAQ → brand+viscosity (lubricant on product);
 *   filter → brand, no viscosity; second generate does not call stub for a
 *   cached key; cache entry stores source DESCRICAO; --limit 2 takes
 *   highest-frequency keys; next --limit 2 continues; limited dataset omits
 *   unparsed materials; refresh reports kind flips both ways.
 *
 * Axes
 *   A1 parse — oil / filter / cached / uncached
 *   A2 limit — none / 2 of 5
 *   A3 refresh — off / on with kind flip
 *   A4 api key — stub present / absent (cache hits only)
 *
 * Outputs: O1 oil product with viscosity; O2 filter without viscosity; O3 stub
 *   call count; O4 cache description; O5 loadable JSON missing unparsed keys;
 *   O6 kindChanges named with code+description
 *
 * Decision map (generate-dataset + catalog)
 *   D1 cache hit skip           T second generate; F first
 *   D2 --limit uncached cap     T limit-2 its; F unlimited first
 *   D3 frequency not code order T high-freq first; F would pick A-code first
 *   D4 refresh re-parse         T kind-flip it; F cached skip
 *   D5 missing parser           T skip uncached it
 *
 * Out of scope: live OpenAI; live archive SQL; Prisma catalog migration.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readTidsciDatasetFile } from "./load.js";
import { generateTidsciDataset } from "./generate-dataset.js";
import type { CatalogMaterialParser } from "./catalog.js";
import type { TidsciArchive } from "./archive-rows.js";

const DATE = 80400;

function archiveWithMaterials(
  materials: Array<{ code: string; description: string; copies: number }>,
): TidsciArchive {
  const items = materials.flatMap((material) =>
    Array.from({ length: material.copies }, () => ({
      schema: "emp01",
      nrPedido: "1",
      codigoMaterial: material.code,
      descricao: material.description,
      qtdeItem: 1,
      valorUnitario: 50,
      valorTotalItem: 50,
    })),
  );
  return {
    snaps: [
      {
        schema: "emp01",
        codigoCliente: "1",
        razaoSocial: "Oficina",
        cpf: "11144477735",
        cgc: null,
        endereco: null,
        bairro: null,
        cidade: null,
        codigoUf: null,
        cep: null,
        dateInteger: DATE,
      },
    ],
    nfs: [
      {
        schema: "emp01",
        nrPedido: "1",
        codigoCliente: "1",
        valorTotalNota: 50,
        dataEmissao: DATE,
        telefoneContatoVenda: null,
        emailContatoVenda: null,
      },
    ],
    items,
    autos: [],
    stock: materials.map((material) => ({
      schema: "emp01",
      codigoMaterial: material.code,
      estoque: 7,
    })),
  };
}

function stubParser(): { parse: CatalogMaterialParser; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    parse: async (input) => {
      calls.push(input.codigoMaterial);
      if (input.description.includes("RADNAQ") || input.description.includes("OLEO")) {
        return { brand: "Radnaq", viscosity: "5W30", classification: null, kind: "oil" };
      }
      if (input.description.toLowerCase().includes("filtro")) {
        return { brand: "Tecfil", viscosity: null, classification: null, kind: "filter" };
      }
      return { brand: "Gen", viscosity: null, classification: null, kind: "other" };
    },
  };
}

describe("generateTidsciDataset catalog parse", () => {
  it("maps RADNAQ to a viscosity product and a filter to brand with no lubricant fields, reuses cache, and stores the source description", async () => {
    const fetchSpy = vi.fn();
    const previous = globalThis.fetch;
    globalThis.fetch = fetchSpy as typeof fetch;
    const dir = mkdtempSync(join(tmpdir(), "tidsci-cat-"));
    const stub = stubParser();
    const archive = archiveWithMaterials([
      { code: "RAD", description: "OLEO RADNAQ 5W30 1L", copies: 3 },
      { code: "FIL", description: "Filtro de oleo PSL560", copies: 1 },
    ]);

    const first = await generateTidsciDataset({
      archive,
      cachePath: join(dir, "cache.json"),
      outputPath: join(dir, "out.json"),
      parseMaterial: stub.parse,
    });
    const second = await generateTidsciDataset({
      archive,
      cachePath: join(dir, "cache.json"),
      outputPath: join(dir, "out.json"),
      parseMaterial: stub.parse,
    });

    const oil = first.products.find((row) => row.description === "OLEO RADNAQ 5W30 1L");
    const filter = first.products.find((row) => row.description === "Filtro de oleo PSL560");
    expect(oil?.brand).toBe("Radnaq");
    expect(oil?.viscosity).toBe("5W30");
    expect(oil?.classification).toBeUndefined();
    expect(filter?.brand).toBe("Tecfil");
    expect(filter?.viscosity).toBeUndefined();
    expect(stub.calls).toEqual(["RAD", "FIL"]);
    expect(second.parsed).toBe(0);
    const cache = JSON.parse(readFileSync(join(dir, "cache.json"), "utf8")) as Record<
      string,
      { description: string }
    >;
    expect(cache["RAD\tOLEO RADNAQ 5W30 1L"]?.description).toBe("OLEO RADNAQ 5W30 1L");
    expect(fetchSpy).not.toHaveBeenCalled();
    globalThis.fetch = previous;
  });

  it("parses the two highest-frequency uncached keys on --limit 2, then the next two, and omits unparsed materials from the dataset", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tidsci-lim-"));
    const stub = stubParser();
    const archive = archiveWithMaterials([
      { code: "A", description: "A rare", copies: 1 },
      { code: "B", description: "B mid", copies: 4 },
      { code: "C", description: "C low", copies: 2 },
      { code: "D", description: "D top", copies: 9 },
      { code: "E", description: "E second", copies: 6 },
    ]);

    const first = await generateTidsciDataset({
      archive,
      cachePath: join(dir, "cache.json"),
      outputPath: join(dir, "out.json"),
      parseMaterial: stub.parse,
      limit: 2,
    });
    expect(stub.calls).toEqual(["D", "E"]);
    const loaded = readTidsciDatasetFile(join(dir, "out.json"));
    expect(loaded.products.some((row) => row.description === "D top")).toBe(true);
    expect(loaded.products.some((row) => row.description === "A rare")).toBe(false);
    expect(first.skippedUncached).toBe(3);

    const second = await generateTidsciDataset({
      archive,
      cachePath: join(dir, "cache.json"),
      outputPath: join(dir, "out.json"),
      parseMaterial: stub.parse,
      limit: 2,
    });
    expect(stub.calls).toEqual(["D", "E", "B", "C"]);
    expect(second.parsed).toBe(2);
    expect(readTidsciDatasetFile(join(dir, "out.json")).products.some((row) => row.description === "A rare")).toBe(
      false,
    );
  });

  it("reports a refresh kind flip in either direction with code and description", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tidsci-ref-"));
    const archive = archiveWithMaterials([{ code: "X", description: "Item X", copies: 1 }]);
    await generateTidsciDataset({
      archive,
      cachePath: join(dir, "cache.json"),
      outputPath: join(dir, "out.json"),
      parseMaterial: async () => ({ brand: "Acme", viscosity: "5W30", classification: null, kind: "oil" }),
    });
    const toFilter = await generateTidsciDataset({
      archive,
      cachePath: join(dir, "cache.json"),
      outputPath: join(dir, "out.json"),
      refreshCatalog: true,
      parseMaterial: async () => ({ brand: "Acme", viscosity: null, classification: null, kind: "filter" }),
    });
    expect(toFilter.kindChanges).toEqual([
      { codigoMaterial: "X", description: "Item X", from: "oil", to: "filter" },
    ]);
    const toOil = await generateTidsciDataset({
      archive,
      cachePath: join(dir, "cache.json"),
      outputPath: join(dir, "out.json"),
      refreshCatalog: true,
      parseMaterial: async () => ({ brand: "Acme", viscosity: "5W30", classification: null, kind: "oil" }),
    });
    expect(toOil.kindChanges).toEqual([
      { codigoMaterial: "X", description: "Item X", from: "filter", to: "oil" },
    ]);
  });

  it("skips uncached keys when no parser and no API key, keeping Motul seed products", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tidsci-nop-"));
    const archive = archiveWithMaterials([{ code: "Z", description: "Unknown", copies: 1 }]);
    const result = await generateTidsciDataset({
      archive,
      cachePath: join(dir, "cache.json"),
      outputPath: join(dir, "out.json"),
    });
    expect(result.parsed).toBe(0);
    expect(result.products.some((row) => row.omieId === "cat-motul-8100-5w30")).toBe(true);
    expect(result.products.some((row) => row.description === "Unknown")).toBe(false);
  });
});

/**
 * Test design (testing-strategy) — what a cache row's capacity type yields
 *
 * SUT: shownRowResult, pure, over rows read through the store's column reader
 *   (`readFillCondition`), as `toCacheDto` builds them.
 *
 * Oracle: ingest-harvested-manuals D5 and its shared-types delta; review of #189: the answer and
 *   the column reader agree on one rule — `options.fillCondition` is the reader's; an unusable
 *   volume of zero or less is absent; a priced type with no liters and no unusable volume is no
 *   capacity type, so the answer is a plain `no_capacity`.
 */
import { describe, expect, it } from "vitest";
import type { CatalogRow, CachedCompatibility } from "../store/store.js";
import { readFillCondition } from "../store/column-readers.js";
import { shownRowResult } from "./shown-row.js";

const source = { sourcePublisher: "vw.com.br", sourceDocument: "Manual Gol 2021", sourcePage: "p. 301", sourceAuthority: 1, sourceUrl: null };
const catalog = [
  {
    id: "oil",
    brand: "Motul",
    description: "8100",
    price: 50,
    stock: 10,
    active: true,
    lubricant: { catalogItemId: "oil", viscosity: "5W-40", classification: "" },
    filter: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  },
] as unknown as CatalogRow[];
const noFilters = () => ({ source: "unavailable", consultedAt: null, application: null, oil: { status: "unavailable" }, fuel: { status: "unavailable" } }) as const;

/** A row as the store reads it: liters, legend, and the raw column pair through the reader. */
function row(liters: number | null, fillKind: "em_servico" | "unlabeled" | null, column: string | null, unusable: number | null): CachedCompatibility {
  return {
    id: "row",
    make: "Volkswagen",
    year: 2021,
    model: "Gol",
    version: "1.0",
    viscosityGrades: ["5W-40"],
    viscosity: "5W-40",
    classification: "",
    fillLiters: liters,
    fillKind,
    ...readFillCondition(liters, fillKind, column, unusable),
    consultedAt: "2026-09-27T12:00:00.000Z",
    rawPayload: null,
    ...source,
    gradeSources: [{ grade: "5W-40", ...source }],
    litersSource: liters == null ? null : source,
  };
}

describe("shownRowResult and the column reader agree", () => {
  it("takes options.fillCondition from the reader: the column, else the legend", () => {
    expect(shownRowResult(row(3.3, "unlabeled", "unlabeled", null), catalog, noFilters)).toMatchObject({ status: "options", fillCondition: "unlabeled" });
    expect(shownRowResult(row(4, "em_servico", null, null), catalog, noFilters)).toMatchObject({ status: "options", fillCondition: "with_filter" });
    // The column decides over the legend, as the reader does.
    expect(shownRowResult(row(4, "em_servico", "unlabeled", null), catalog, noFilters)).toMatchObject({ status: "options", fillCondition: "unlabeled" });
  });

  it.each([0, -1])("answers a plain no_capacity for an unusable volume of %s liters", (liters) => {
    const result = shownRowResult(row(null, null, "dry", liters), catalog, noFilters);

    expect(result).toMatchObject({ status: "no_capacity" });
    expect(result).not.toHaveProperty("unusableFill");
  });

  it("answers a plain no_capacity for a priced type with no liters and no unusable volume", () => {
    const result = shownRowResult(row(null, null, "with_filter", null), catalog, noFilters);

    expect(result).toMatchObject({ status: "no_capacity" });
    expect(result).not.toHaveProperty("unusableFill");
  });

  it("names a dry volume the reader kept", () => {
    expect(shownRowResult(row(null, null, "dry", 3.6), catalog, noFilters)).toMatchObject({ status: "no_capacity", unusableFill: { liters: 3.6, condition: "dry" } });
  });
});

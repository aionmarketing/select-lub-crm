/**
 * Test design (testing-strategy) — `litersSourceOf`
 *
 * Oracle: orchestrator ruling 2026-09-25 on oil (a) — a cache row with liters and no liters
 *   source must not break the attendant's quote: the quote falls back to the primary source
 *   and logs a warning naming the compatibility row id, with no excerpt.
 *
 * Cells: liters source present → it, no warning | absent → primary, one warning naming the
 *   row, the excerpt nowhere in it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { litersSourceOf } from "./cited-source.js";

const PRIMARY = {
  sourcePublisher: "Volkswagen do Brasil",
  sourceDocument: "Manual do Proprietário Polo 2021",
  sourcePage: "p. 287",
  sourceAuthority: 1,
  sourceUrl: null,
};
const EXCERPT = "5W-40 ou 5W-30, 4,0 L com filtro";
const CATALOG = {
  sourcePublisher: "CarroRac",
  sourceDocument: "Tabela de aplicação",
  sourcePage: "Polo AW",
  sourceAuthority: 5,
  sourceUrl: null,
  sourceClassification: "aftermarket_catalog" as const,
  sourceExcerpt: EXCERPT,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("litersSourceOf", () => {
  it("shows the row's liters source, without its excerpt, and warns about nothing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const shown = litersSourceOf({ id: "cmp-1", litersSource: CATALOG }, PRIMARY);

    expect(shown).toEqual({
      sourcePublisher: "CarroRac",
      sourceDocument: "Tabela de aplicação",
      sourcePage: "Polo AW",
      sourceAuthority: 5,
      sourceUrl: null,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("falls back to the primary source and warns, naming the row and not its passage", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const shown = litersSourceOf({ id: "cmp-42", litersSource: null }, PRIMARY);

    expect(shown).toEqual(PRIMARY);
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = warn.mock.calls[0]!.join(" ");
    expect(logged).toContain('"compatibilityId":"cmp-42"');
    expect(logged).toContain("liters_source_missing");
    expect(logged).not.toContain(EXCERPT);
  });
});

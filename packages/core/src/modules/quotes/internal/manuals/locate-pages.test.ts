/**
 * Test design (testing-strategy) — locating the engine-oil pages in a stored manual (D4)
 *
 * SUT: engineWords, scorePage, locatePages, pagesForLines and citePages — pure, no model.
 *
 * Oracle: ingest-harvested-manuals D4 and oil-manual-ingestion "The capacities page is found in a
 *   long manual": a deterministic prefilter scores pages by the words a capacities table uses,
 *   with a bonus for the identity's engine words, and keeps the top K; the K pages are joined
 *   with a marker per page so the passage the selector picks maps back to the page (or pages)
 *   the citation names. Review of #182: the pages are those of the selector's LINE RANGE, never
 *   found by searching the text, only pages that were sent, and a page that prints a marker of
 *   its own cannot move a citation.
 */
import { describe, expect, it } from "vitest";
import { citePages, engineWords, locatePages, pagesForLines, scorePage, type ManualPage } from "./locate-pages.js";

const GOL_10 = { make: "Volkswagen", year: 2021, model: "Gol", version: "1.0 FLEX 12V 4P" };
const GOL_16 = { make: "Volkswagen", year: 2021, model: "Gol", version: "1.6 MSI TOTALFLEX" };

/** A 400-page manual: noise everywhere, two capacities tables (1.0 on p. 287, 1.6 on p. 288). */
function longManual(): ManualPage[] {
  const pages: ManualPage[] = [];
  for (let n = 1; n <= 400; n += 1) pages.push({ pageNumber: n, text: `Página ${n}. Ajuste dos bancos, cintos de segurança e espelhos.` });
  pages[141] = { pageNumber: 142, text: "Verifique o nível de óleo do motor com o veículo nivelado. Use óleo recomendado." };
  pages[286] = {
    pageNumber: 287,
    text: "Capacidades — Motor 1.0 12V\nÓleo do motor: SAE 5W-40\nCapacidade com filtro: 4,0 litros\nCapacidade sem filtro: 3,6 litros",
  };
  pages[287] = {
    pageNumber: 288,
    text: "Capacidades — Motor 1.6 MSI\nÓleo do motor: SAE 5W-40\nCapacidade com filtro: 4,5 litros\nCapacidade sem filtro: 4,2 litros",
  };
  return pages;
}

describe("engineWords", () => {
  it("names the displacement both ways and the valve count, not the fuel or the body", () => {
    expect(engineWords(GOL_10).sort()).toEqual(["1,0", "1.0", "12v"]);
  });

  it("keeps an engine code, and drops a trim or fuel word", () => {
    expect(engineWords(GOL_16).sort()).toEqual(["1,6", "1.6", "msi"]);
  });

  it("takes the displacement from the plate lookup when the version has none", () => {
    expect(engineWords({ ...GOL_10, version: "TRENDLINE", displacementCc: 1598 }).sort()).toEqual(["1,6", "1.6"]);
  });
});

describe("scorePage", () => {
  it("scores nothing for a page with no oil word, whatever engine words it has", () => {
    expect(scorePage("Motor 1.0 12V: correia dentada", engineWords(GOL_10))).toBe(0);
  });

  it("scores the identity's own capacities table above another engine's", () => {
    const pages = longManual();
    const words = engineWords(GOL_10);

    expect(scorePage(pages[286]!.text, words)).toBeGreaterThan(scorePage(pages[287]!.text, words));
  });
});

describe("locatePages", () => {
  it("finds the capacities page in a 400-page manual, and hands on at most K pages in page order", () => {
    const located = locatePages(longManual(), GOL_10, 2);

    expect(located.pageNumbers).toEqual([287, 288]);
    expect(located.text).toContain("=== página 287 ===\nCapacidades — Motor 1.0 12V");
  });

  it("ranks the identity's own table first when only one page fits", () => {
    expect(locatePages(longManual(), GOL_10, 1).pageNumbers).toEqual([287]);
    expect(locatePages(longManual(), GOL_16, 1).pageNumbers).toEqual([288]);
  });

  it("hands on nothing when no page mentions oil", () => {
    expect(locatePages([{ pageNumber: 1, text: "Cintos de segurança" }], GOL_10, 6)).toEqual({ pageNumbers: [], text: "", lineToPage: [] });
  });
});

describe("pagesForLines and citePages", () => {
  const located = locatePages(longManual(), GOL_10, 3);
  /** The 0-based index of the first joined line containing `needle`. */
  const lineOf = (needle: string) => located.text.split("\n").findIndex((line) => line.includes(needle));

  it("maps lines inside one page to that page", () => {
    const from = lineOf("Óleo do motor: SAE 5W-40");

    expect(located.pageNumbers).toEqual([142, 287, 288]);
    expect(citePages(pagesForLines(located, [{ from, to: from + 2 }]))).toBe("p. 287");
  });

  it("maps lines that run across a page break to both pages", () => {
    const from = lineOf("Capacidade sem filtro: 3,6 litros");

    expect(citePages(pagesForLines(located, [{ from, to: lineOf("Capacidades — Motor 1.6 MSI") + 1 }]))).toBe("pp. 287–288");
  });

  it("cites every page sent when there is no line range, or one outside the text", () => {
    expect(pagesForLines(located)).toEqual([142, 287, 288]);
    expect(pagesForLines(located, [{ from: 0, to: 10_000 }])).toEqual([142, 287, 288]);
  });

  it("does not let a page's own marker-like line move a citation", () => {
    const forged: ManualPage[] = [
      { pageNumber: 3, text: "Óleo do motor: SAE 5W-40\n=== página 99 ===\nCapacidade com filtro: 4,0 litros" },
    ];
    const joined = locatePages(forged, GOL_10, 6);

    // Only the joiner writes markers; the page's own is defused.
    expect(joined.text.split("\n").filter((line) => line.startsWith("==="))).toEqual(["=== página 3 ==="]);
    expect(joined.text).toContain("[página 99]");
    expect(pagesForLines(joined, [{ from: 0, to: joined.lineToPage.length }])).toEqual([3]);
  });

  it("cites non-contiguous pages by list", () => {
    expect(citePages([7, 3])).toBe("pp. 3, 7");
    expect(citePages([])).toBe("");
  });
});

/**
 * background-oil-research D4 (task 1.7) and the `research-model-calls` delta "The model reads a
 * narrowed passage of a long text": each located page is narrowed to ±12-line windows around its
 * oil, grade and engine-word lines, the rest elided with `[…]`, under OIL_SELECTOR_MAX_CHARS with
 * the best-scoring pages' windows kept first; every kept and elision line keeps its page.
 */
describe("locatePages narrows the pages it hands on", () => {
  const prose = (count: number, from = 1) =>
    Array.from({ length: count }, (_unused, index) => `Texto corrido sobre bancos e espelhos, trecho ${from + index}.`);

  it("keeps a capacities table 150 lines into a page, and elides most of the prose", () => {
    const table = ["Capacidades — Motor 1.0 12V", "Óleo do motor: SAE 5W-40", "Capacidade com filtro: 4,0 litros"];
    const pages: ManualPage[] = [{ pageNumber: 236, text: [...prose(150), ...table, ...prose(150, 151)].join("\n") }];

    const located = locatePages(pages, GOL_10, 6);

    expect(located.text).toContain(table.join("\n"));
    expect(located.text).not.toContain("trecho 1.");
    expect(located.text).not.toContain("trecho 300.");
    expect(located.text.split("\n").length).toBeLessThan(60);
  });

  it("holds the cap, keeping the best-scoring pages first", () => {
    const table = (engine: string) => [`Capacidades — Motor ${engine}`, "Óleo do motor: SAE 5W-40", "Capacidade com filtro: 4,0 litros"];
    const pages: ManualPage[] = [
      { pageNumber: 10, text: [...prose(30), "Verifique o óleo.", ...prose(30)].join("\n") },
      { pageNumber: 287, text: [...prose(30), ...table("1.0 12V"), ...prose(30)].join("\n") },
      { pageNumber: 288, text: [...prose(30), ...table("1.6 MSI"), ...prose(30)].join("\n") },
    ];
    const whole = locatePages(pages, GOL_10, 6);
    const cap = Math.ceil(whole.text.length / 2);

    const capped = locatePages(pages, GOL_10, 6, cap);

    expect(whole.pageNumbers).toEqual([10, 287, 288]);
    expect(capped.text.length).toBeLessThanOrEqual(cap);
    // p. 287 names the identity's engine: it scores highest and is kept first.
    expect(capped.pageNumbers).toContain(287);
    expect(capped.pageNumbers.length).toBeLessThan(3);
  });

  it("cites the page a passage chosen on the narrowed text is on", () => {
    const pages: ManualPage[] = [
      { pageNumber: 235, text: [...prose(40), "Verifique o nível do óleo.", ...prose(40)].join("\n") },
      { pageNumber: 236, text: [...prose(40), "Capacidade com filtro: 4,0 litros", "Óleo do motor: SAE 5W-40", ...prose(40)].join("\n") },
    ];
    const located = locatePages(pages, GOL_10, 6);
    const lines = located.text.split("\n");
    const from = lines.indexOf("Capacidade com filtro: 4,0 litros");

    expect(citePages(pagesForLines(located, [{ from, to: from + 2 }]))).toBe("p. 236");
  });

  it("gives each elision line to the page it elides from", () => {
    const pages: ManualPage[] = [
      { pageNumber: 5, text: [...prose(40), "Óleo do motor: SAE 5W-40", ...prose(40)].join("\n") },
      { pageNumber: 9, text: [...prose(40), "Capacidade com filtro: 4,0 litros", ...prose(40)].join("\n") },
    ];
    const located = locatePages(pages, GOL_10, 6);
    const lines = located.text.split("\n");
    const elisions = lines.flatMap((line, index) => (line === "[…]" ? [index] : []));

    expect(elisions).toHaveLength(4);
    expect(elisions.map((index) => located.lineToPage[index])).toEqual([5, 5, 9, 9]);
  });
});

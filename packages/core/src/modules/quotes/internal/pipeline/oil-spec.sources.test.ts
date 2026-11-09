/**
 * Test design (testing-strategy)
 *
 * SUT: how resolveOilSpec treats the source it is handed (internal/pipeline/oil-spec.ts) — a
 * web-found page obeys the same rules as any other source, and passage selection narrows a
 * long page before the extractor reads it.
 *
 * Split by topic under the 300-line cap (adopt-modular-vertical-slices 2B.1) from
 * oil-spec.test.ts, which holds the core resolution and the shared axes. Each section below
 * keeps the design block it had there.
 *
 * Setup: both ports are injected fakes (D8). No HTTP, no Motul, no model, no web search.
 */
import { describe, expect, it, vi } from "vitest";
import type { FlatRecommendation } from "../../../../kernel/clients/motul/index.js";
import { resolveOilSpec } from "./oil-spec.js";
import type {
  AuthoritativeSourceRetriever,
  ExtractedOilSpec,
  OilSpecExtractor,
  OilSpecPorts,
  RetrieveResult,
  RetrievedSource,
} from "./oil-spec.js";
import type { VehicleIdentity } from "../store/store.js";
import type { PassageSelection, PassageSelector } from "./passage-selector.js";

const identity: VehicleIdentity = {
  make: "Volkswagen",
  year: 2014,
  model: "Polo",
  version: "1.6 MSI",
};

const citation = {
  publisher: "Volkswagen do Brasil",
  document: "Manual do Proprietário Polo (2014)",
  page: "Seção 10 — Capacidades",
};

function textSource(text: string): RetrievedSource {
  return { ...citation, content: { kind: "text", text } };
}

function flattenSource(parts: FlatRecommendation["parts"]): RetrievedSource {
  return {
    ...citation,
    content: { kind: "motul_flatten", recommendation: { vehicle: "fixture", parts } },
  };
}

function retrieverReturning(result: RetrieveResult) {
  return vi.fn<AuthoritativeSourceRetriever>().mockResolvedValue(result);
}

function extractorReturning(spec: ExtractedOilSpec | null) {
  return vi.fn<OilSpecExtractor>().mockResolvedValue(spec);
}


/**
 * Added by web-search-source-adapter task 5.3.
 *
 * Oracle: specs/quotes/oil-spec-web-search/spec.md — a web-found source is an ordinary source. It
 * enters the same authority order, the same conflict detection and the same engine-coverage
 * refusal as a fixture or a Motul payload. Nothing about arriving from a search buys it an
 * exemption, and nothing about it being a web page costs it its rank.
 *
 * Axes
 *   E1 the two sources agree — yes / no (liters)
 *   E2 the web page's engine coverage — one engine / several
 *
 * Outputs: O1 status; O2 which citation wins, and whether it keeps its class and passage;
 *          O3 the conflict, in authority order
 *
 * Sampled cells (one row per `it`)
 *   agree, one engine    | E1,E2 | O2 the tier-1 page wins over the tier-5 catalog AND
 *      carries its classification and excerpt through — the row must stay auditable
 *   disagree, one engine | E1    | O1 conflicting, O3 the page's value first | fails if a
 *      web source is quietly treated as weaker than a committed one at equal tier
 *   several engines      | E2    | O1 needs_clarification | THE case: a search that lands on
 *      a page covering the whole model line must not price the first engine it lists
 *
 * Out of scope: how the page was found or admitted (web-search.test.ts, admit.test.ts);
 * whether the web adapter runs (sources.test.ts); persistence (options.test.ts task 5.2).
 */
describe("a web-found source obeys the shared rules", () => {
  const PASSAGE = "Polo 1.6 MSI — óleo 0W-20 / 5W-30 — capacidade em serviço 4,3 L";

  const webPage: RetrievedSource = {
    publisher: "vw.com.br",
    document: "Capacidades — Polo 2014",
    page: "Capacidades — Polo 2014",
    authority: 1,
    url: "https://vw.com.br/pos-venda/polo-2014/capacidades",
    classification: "manufacturer_manual",
    excerpt: PASSAGE,
    content: { kind: "text", text: PASSAGE },
  };

  const catalogPage: RetrievedSource = {
    publisher: "CarroRac",
    document: "tabela de aplicação",
    page: "Polo 2014, 1.6 MSI",
    authority: 5,
    url: "https://carrorac.com/oleo-motor/volkswagen/polo.html",
    classification: "aftermarket_catalog",
    content: { kind: "text", text: "catálogo: 0W-20 / 5W-30 — 4,3 L" },
  };

  const agreed: ExtractedOilSpec = {
    viscosityGrades: ["0W-20", "5W-30"],
    classification: "",
    fillLiters: 4.3,
    fillKind: "em_servico",
  };

  function webPorts(
    byPage: Record<string, ExtractedOilSpec | null>,
    sources: RetrievedSource[] = [catalogPage, webPage],
  ): OilSpecPorts {
    return {
      retrieve: async () => ({ status: "found", sources }),
      extract: async (source) => byPage[source.page] ?? null,
    };
  }

  it("verifies citing the page, keeping its class and the passage it read", async () => {
    const result = await resolveOilSpec(
      identity,
      webPorts({ [catalogPage.page]: agreed, [webPage.page]: agreed }),
    );

    expect(result.status).toBe("verified");
    if (result.status !== "verified") throw new Error("expected verified");
    expect(result.citation).toMatchObject({
      authority: 1,
      url: webPage.url,
      classification: "manufacturer_manual",
      excerpt: PASSAGE,
    });
    expect(result.fillLiters).toBe(4.3);
  });

  it("takes a disagreement with the catalog down the ordinary conflict path", async () => {
    const result = await resolveOilSpec(
      identity,
      webPorts({
        [catalogPage.page]: { ...agreed, fillLiters: 4 },
        [webPage.page]: agreed,
      }),
    );

    expect(result.status).toBe("conflicting_sources");
    if (result.status !== "conflicting_sources") throw new Error("expected conflict");
    expect(result.conflicts[0]!.field).toBe("fillLiters");
    expect(result.conflicts[0]!.values.map((entry) => entry.value)).toEqual(["4.3", "4"]);
    expect(result.conflicts[0]!.values[0]!.citation.url).toBe(webPage.url);
  });

  it("asks for clarification when the page covers several engines", async () => {
    const result = await resolveOilSpec(
      identity,
      webPorts(
        {
          [webPage.page]: {
            ...agreed,
            engineCoverage: "several",
            enginesNamed: ["1.0 TSI", "1.6 MSI"],
          },
        },
        [webPage],
      ),
    );

    expect(result).toEqual({
      status: "needs_clarification",
      coverage: "several",
      options: ["1.0 TSI", "1.6 MSI"],
      // The page read is kept with its URL, tier and class, for an engine pick (D24).
      passages: [{ publisher: webPage.publisher, document: webPage.document, page: webPage.page, authority: 1, url: webPage.url, classification: "manufacturer_manual", excerpt: PASSAGE }],
    });
  });
});

/**
 * Added with the passage selector (web-search-source-adapter, owner decision 2026-09-13).
 *
 * Oracle: specs/quotes/oil-spec-web-search/spec.md — the extractor receives the part of the page
 * about the resolved vehicle; a page with nothing about it is not extracted; the stored
 * excerpt is the passage read.
 *
 * Axes
 *   V1 selection outcome — selected / none / unavailable / port absent
 *   V2 source kind — text / motul_flatten
 *
 * Outputs: O1 what the extractor received; O2 whether it was called; O3 the citation excerpt
 *
 * Sampled cells (one row per `it`)
 *   selected     | V1 | O1 the narrowed text, O3 excerpt = passage | fails if the citation
 *      still points at the whole page after the narrowing — the audit would store 20k chars
 *   none         | V1 | O2 extractor never called, result no_spec | THE case: a menu page
 *      fetched successfully must not reach the extractor just because it was fetched
 *   unavailable  | V1 | O1 the whole page, as before the selector existed
 *   port absent  | V1 | O1 the whole page — today's callers keep today's behaviour
 *   motul        | V2 | selector never called; a payload has no passage to choose
 *
 * Decision map (the selector block in resolveOilSpec)
 *   ports.selectPassage && kind === "text"   true: selected/none/unavailable; false: absent,
 *      motul
 *   status === "none"       true: none test; false: the others
 *   status === "selected"   true: selected test; false: unavailable test
 */
describe("resolveOilSpec — passage selection", () => {
  const wholePage = "menu\nmenu\nÓleo do motor 0W-20 — 4,0 L\nrodapé";
  const passage = "Óleo do motor 0W-20 — 4,0 L";
  const grounded: ExtractedOilSpec = {
    viscosityGrades: ["0W-20"],
    classification: "",
    fillLiters: 4,
    fillKind: "em_servico",
  };

  function selectorReturning(selection: PassageSelection) {
    return vi.fn<PassageSelector>().mockResolvedValue(selection);
  }

  it("hands the extractor the passage and cites it as the excerpt", async () => {
    const source = textSource(wholePage);
    const extract = extractorReturning(grounded);
    const narrowed = { ...source, excerpt: passage, content: { kind: "text" as const, text: passage } };

    const result = await resolveOilSpec(identity, {
      retrieve: retrieverReturning({ status: "found", sources: [source] }),
      extract,
      selectPassage: selectorReturning({ status: "selected", source: narrowed }),
    });

    expect(extract.mock.calls[0]![0].content).toEqual({ kind: "text", text: passage });
    if (result.status !== "verified") throw new Error("expected verified");
    expect(result.citation.excerpt).toBe(passage);
  });

  it("does not extract a page the selector says has nothing about the vehicle", async () => {
    const extract = extractorReturning(grounded);

    const result = await resolveOilSpec(identity, {
      retrieve: retrieverReturning({ status: "found", sources: [textSource(wholePage)] }),
      extract,
      selectPassage: selectorReturning({ status: "none" }),
    });

    expect(extract).not.toHaveBeenCalled();
    expect(result).toEqual({ status: "no_spec" });
  });

  it("reads the whole page when the selector is unavailable", async () => {
    const extract = extractorReturning(grounded);

    await resolveOilSpec(identity, {
      retrieve: retrieverReturning({ status: "found", sources: [textSource(wholePage)] }),
      extract,
      selectPassage: selectorReturning({ status: "unavailable" }),
    });

    expect(extract.mock.calls[0]![0].content).toEqual({ kind: "text", text: wholePage });
  });

  it("reads the whole page when no selector is configured", async () => {
    const extract = extractorReturning(grounded);

    await resolveOilSpec(identity, {
      retrieve: retrieverReturning({ status: "found", sources: [textSource(wholePage)] }),
      extract,
    });

    expect(extract.mock.calls[0]![0].content).toEqual({ kind: "text", text: wholePage });
  });

  it("never asks the selector about a Motul payload", async () => {
    const select = selectorReturning({ status: "none" });

    await resolveOilSpec(identity, {
      retrieve: retrieverReturning({ status: "found", sources: [flattenSource({})] }),
      extract: extractorReturning(grounded),
      selectPassage: select,
    });

    expect(select).not.toHaveBeenCalled();
  });
});

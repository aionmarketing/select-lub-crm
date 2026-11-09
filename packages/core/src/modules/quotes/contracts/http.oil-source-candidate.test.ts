/**
 * Test design (testing-strategy)
 *
 * SUT: sourceCandidateSchema / searchMissSchema (packages/shared-types). Pure parsing.
 *
 * Oracle: specs/quotes/oil-source-candidates/spec.md — a candidate carries the identity, url,
 * publisher, classification, the tier derived from it, when it was found, and whether it
 * came from a page; a harvested one also carries its label and the reason it was kept.
 *
 * Axes
 *   D1 provenance — search result (no `discoveredVia`) / harvested (page url, label, reason)
 *   D2 classification — one of the five / `other` / absent
 *   D3 tier — 1 / 5 / 0 / 6 / non-integer
 *   D4 identity — complete / a field blank after trim
 *   D5 miss — complete / blank reason
 *
 * Outputs: O1 parse succeeds and the optional fields are readable; O2 parse fails
 *
 * Sampled cells (one row per `it` / `it.each` row)
 *   harvested row              | D1    | O1 label, selectionReason and discoveredVia all present
 *   search-result row          | D1    | O1 parses with none of the three | fails if the
 *      harvested-only fields were made required, which would erase the distinction between
 *      a document the model classified and one that inherited its page's class
 *   classification `other`     | D2    | O2 — `other` is rejected before a source exists,
 *      so it can never reach the ledger either
 *   classification absent      | D2    | O2
 *   tier 0 / 6 / 1.5           | D3    | O2 at both boundaries and off the integer domain
 *   tier 1 and 5               | D3    | O1 — the inclusive ends of the map
 *   blank model                | D4    | O2
 *   miss row                   | D5    | O1
 *   miss with blank reason     | D5    | O2 — a miss with no reason cannot be tuned against
 *
 * Out of scope: the table shape (migration.oil-source-candidates.test.ts), the store's
 * insert/list behaviour (oil-quote memory tests), how a tier is derived (source-tier.test.ts).
 */
import { describe, expect, it } from "vitest";
import { searchMissSchema, sourceCandidateSchema, type SourceCandidateRow } from "./http.oil-source-candidate.js";

const harvested: SourceCandidateRow = {
  id: "cand-1",
  make: "Volkswagen",
  year: 2021,
  model: "Polo",
  version: "1.0 TSI",
  url: "https://www.vw.com.br/dam/manual-novo-polo/Polo_MY2021.pdf",
  publisher: "vw.com.br",
  classification: "manufacturer_manual",
  tier: 1,
  discoveredVia: "https://www.vw.com.br/pt/manuais.html",
  label: "Manual Novo Polo 2021",
  selectionReason: "o rótulo nomeia o modelo e o ano",
  foundAt: "2026-09-14T12:00:00.000Z",
};

const fromSearch = {
  id: "cand-2",
  make: "Honda",
  year: 2021,
  model: "HR-V",
  version: "EX CVT",
  url: "https://www.honda.com.br/manual-hrv-2021.pdf",
  publisher: "honda.com.br",
  classification: "manufacturer_manual",
  tier: 1,
  foundAt: "2026-09-14T12:00:00.000Z",
};

describe("sourceCandidateSchema", () => {
  it("parses a harvested document with its label, reason and originating page", () => {
    const row = sourceCandidateSchema.parse(harvested);

    expect(row.discoveredVia).toBe("https://www.vw.com.br/pt/manuais.html");
    expect(row.label).toBe("Manual Novo Polo 2021");
    expect(row.selectionReason).toContain("rótulo");
  });

  it("parses a search result with none of the harvested-only fields", () => {
    // These three must stay optional: their absence is what says the model classified this
    // document itself rather than inheriting the class of a page that linked it.
    const row = sourceCandidateSchema.parse(fromSearch);

    expect(row.discoveredVia).toBeUndefined();
    expect(row.label).toBeUndefined();
  });

  it.each(["other", "forum", undefined])("rejects classification %s", (classification) => {
    expect(() => sourceCandidateSchema.parse({ ...fromSearch, classification })).toThrow();
  });

  it.each([0, 6, 1.5])("rejects tier %s", (tier) => {
    expect(() => sourceCandidateSchema.parse({ ...fromSearch, tier })).toThrow();
  });

  it.each([1, 5])("accepts tier %i, an inclusive end of the map", (tier) => {
    expect(sourceCandidateSchema.parse({ ...fromSearch, tier }).tier).toBe(tier);
  });

  it("rejects an identity field that is blank after trim", () => {
    expect(() => sourceCandidateSchema.parse({ ...fromSearch, model: "  " })).toThrow();
  });
});

describe("searchMissSchema", () => {
  const miss = {
    id: "miss-1",
    make: "Fiat",
    year: 2021,
    model: "Argo",
    version: "1.0 Firefly",
    reason: "nenhum resultado admitido",
    searchedAt: "2026-09-14T12:00:00.000Z",
  };

  it("parses a miss for one identity", () => {
    expect(searchMissSchema.parse(miss).reason).toBe("nenhum resultado admitido");
  });

  it("rejects a miss with no reason, which could not be tuned against", () => {
    expect(() => searchMissSchema.parse({ ...miss, reason: "   " })).toThrow();
  });
});

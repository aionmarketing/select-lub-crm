/**
 * Test design (testing-strategy)
 *
 * SUT: admitCandidate (apps/api/src/oil-quote/admit.ts). Pure; no HTTP, no model.
 *
 * Oracle: specs/quotes/oil-spec-web-search/spec.md "The searching model classifies each page and
 * that classification sets its tier" — the tier comes from the class through a fixed map, a
 * page classified `other` is rejected, the blocklist rejects regardless of classification,
 * and the model MUST NOT output a tier that has any effect.
 *
 * Axes
 *   A1 classification — one of five / `other` / absent / unknown string
 *   A2 domain — clean / blocklisted
 *   A3 candidate carries a `tier` field of its own — yes / no
 *   A4 url — present / empty
 *
 * Outputs: O1 admitted with a derived tier; O2 rejected with a reason naming the cause
 *
 * Sampled cells (one row per `it`)
 *   manual + clean            | A1,A2 | O1 tier 1
 *   catalog + clean           | A1,A2 | O1 tier 5
 *   `other` + clean           | A1    | O2 — an unplaceable page is not a source
 *   absent class + clean      | A1    | O2
 *   manual + blocklisted      | A1,A2 | O2 blocked. THE precedence case: the highest class
 *      the model can give must not launder a forum through the gate
 *   manual + own tier 5 field | A3    | O1 tier 1 — the model's number is not read at all
 *   empty url                 | A4    | O2
 *
 * Out of scope: fetching (fetcher tests), ordering and budget (adapter tests), whether the
 * class is factually right for the page (human review, task 8.2).
 */
import { describe, expect, it } from "vitest";
import { admitCandidate, isSiteRoot } from "../retrieval/admit.js";

describe("admitCandidate", () => {
  it("admits a manufacturer manual at tier 1", () => {
    const result = admitCandidate({
      url: "https://vw.com.br/manual-polo",
      classification: "manufacturer_manual",
      reason: "página do manual do proprietário no site da VW",
      title: "Manual do Proprietário — Polo",
    });

    expect(result).toMatchObject({
      admitted: true,
      tier: 1,
      classification: "manufacturer_manual",
      title: "Manual do Proprietário — Polo",
    });
  });

  it("admits an aftermarket catalog at tier 5", () => {
    const result = admitCandidate({
      url: "https://carrorac.com/oleo-motor/volkswagen/polo.html",
      classification: "aftermarket_catalog",
      reason: "tabela de aplicação de catálogo de reposição",
    });

    expect(result).toMatchObject({ admitted: true, tier: 5 });
  });

  it("rejects a page the model could not place", () => {
    const result = admitCandidate({
      url: "https://example.test/x",
      classification: "other",
      reason: "não consegui identificar o tipo de documento",
    });

    expect(result.admitted).toBe(false);
    if (result.admitted) throw new Error("expected rejection");
    expect(result.rejection).toContain("other");
  });

  it("rejects a candidate with no classification at all", () => {
    const result = admitCandidate({ url: "https://example.test/x" });

    expect(result.admitted).toBe(false);
  });

  it("rejects a blocklisted domain even when classified as a manual", () => {
    // The precedence that matters: no class the model can emit launders a forum through.
    const result = admitCandidate({
      url: "https://reddit.com/r/carros/thread",
      classification: "manufacturer_manual",
      reason: "usuário colou a tabela do manual",
    });

    expect(result.admitted).toBe(false);
    if (result.admitted) throw new Error("expected rejection");
    expect(result.rejection).toContain("blocked");
    expect(result.rejection).toContain("forum");
  });

  it("ignores a tier the model supplies and derives it from the class", () => {
    const result = admitCandidate({
      url: "https://vw.com.br/manual-polo",
      classification: "manufacturer_manual",
      reason: "manual",
      // A model that volunteers a number must not be able to demote or promote itself.
      ...({ tier: 5 } as Record<string, unknown>),
    });

    expect(result).toMatchObject({ admitted: true, tier: 1 });
  });

  it("rejects a third-party manual mirror classified as the manufacturer's manual", () => {
    // Measured on the 2026-09-10 showcase run: the searching model called these tier 1,
    // and only the fetch cap kept them out. A copy of a manual on someone else's site is
    // not the manufacturer's document, and nothing on the page says so.
    for (const url of [
      "https://www.opinautos.com.br/pt/fiat/argo/info/manuais/2021",
      "https://ownersmanuals2.com/volkswagen/polo-2021-manual-do-proprietario-96806",
      "https://www.manualslib.com/manual/2531123/Honda-Hr-V-2021.html",
    ]) {
      const result = admitCandidate({ url, classification: "manufacturer_manual", reason: "manual" });
      expect(result.admitted).toBe(false);
      if (result.admitted) throw new Error(`expected rejection for ${url}`);
      expect(result.rejection).toContain("manual mirror");
    }
  });

  it("rejects a parts-shop product listing on the manufacturer own domain", () => {
    // Measured 2026-09-10: pecas.vw.com.br is VW own shop, so no authority argument
    // excludes it, but the page sells one 5W-40 bottle. prompt.md calls retailer
    // descriptions non-authoritative, and a single-SKU page is the surest way to make an
    // extractor report that product grade as the car specification.
    const result = admitCandidate({
      url: "https://pecas.vw.com.br/produto/oleo-lubrificante-de-motor-5w-40-sintetico/29784",
      classification: "manufacturer_technical",
      reason: "pagina tecnica da loja oficial",
    });

    expect(result.admitted).toBe(false);
    if (result.admitted) throw new Error("expected rejection");
    expect(result.rejection).toContain("parts shop");
  });

  it("rejects a lubricant retailer's blog classified as a maker's application guide", () => {
    // Measured 2026-09-14 (task 8.2): the model called Fast Óleo's "qual óleo usar" post a
    // lubricant_maker_guide. It is a shop's blog; the class is for Motul/Shell/Castrol's own
    // application tables.
    const result = admitCandidate({
      url: "https://www.fastoleo.com.br/qual-oleo-usar-no-fiat-argo-qual-oleo-usar",
      classification: "lubricant_maker_guide",
      reason: "guia de aplicacao",
    });

    expect(result.admitted).toBe(false);
    if (result.admitted) throw new Error("expected rejection");
    expect(result.rejection).toContain("lubricant retailer blog");
  });

  it("rejects an empty URL", () => {
    const result = admitCandidate({ url: "   ", classification: "manufacturer_manual" });

    expect(result.admitted).toBe(false);
  });

  it("records a placeholder when the model gave no reason", () => {
    const result = admitCandidate({
      url: "https://vw.com.br/manual-polo",
      classification: "manufacturer_manual",
    });

    expect(result).toMatchObject({ admitted: true, reason: "no reason given" });
  });
});

describe("site roots (oil-research-web-retrieval D2)", () => {
  it.each([
    "https://www.chevrolet.com.br",
    "https://www.chevrolet.com.br/",
    "https://www.chevrolet.com.br//",
    "https://www.chevrolet.com.br/index.html",
    "https://x.com.br/INDEX.PHP",
    "https://x.com.br/default.aspx",
    "https://x.com.br/?model=onix",
    "https://x.com.br/#manuais",
  ])("rejects %s whatever the model calls it", (url) => {
    const result = admitCandidate({ url, classification: "manufacturer_manual", reason: "página dos manuais" });

    expect(result).toEqual({ admitted: false, url, rejection: "site root" });
  });

  it.each([
    "https://www.renault.com.br/manuais/kwid.html",
    "https://x.com.br/pt",
    "https://x.com.br/index/manuais",
    "https://x.com.br/files/index.pdf",
  ])("admits the deeper page %s", (url) => {
    expect(admitCandidate({ url, classification: "manufacturer_manual", reason: "r" })).toMatchObject({ admitted: true, tier: 1 });
  });

  it("keeps the blocklist's precedence over the root check", () => {
    const result = admitCandidate({ url: "https://www.facebook.com/", classification: "manufacturer_manual", reason: "r" });

    expect(result).toMatchObject({ admitted: false, rejection: expect.stringContaining("blocked") });
  });

  it("is false for a string that is not a URL", () => {
    expect(isSiteRoot("not a url")).toBe(false);
  });
});

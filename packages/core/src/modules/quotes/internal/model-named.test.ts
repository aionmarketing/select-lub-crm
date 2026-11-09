/**
 * Test design (testing-strategy)
 *
 * SUT: hasWord, namesModel and decodedUrl (internal/model-named.ts). Pure.
 *
 * Oracle: specs/quotes/oil-spec-web-search "Only HTML text is extracted; documents are recorded
 * as manual candidates" — a document concerns the vehicle when the model appears as a whole word,
 * ignoring case and accents, in the search title, the link's label or the decoded URL — and
 * `manuals/select-candidates.ts`, which applies the same test before queueing a manual.
 *
 * Axes
 *   M1 case and accents — as written / folded
 *   M2 boundary — whole word / inside a longer word
 *   M3 model shape — letters / digits / a hyphen or dot
 *   M4 text sources — title / label / decoded URL / null
 *   M5 separators — present / absent / another one (space, hyphen, dot, underscore, slash, "!")
 *
 * Sampled cells (one row per `it`)
 *   case + accents           | M1    | "GOL" in "manual do gol", "Veículo" in "veiculo"
 *   Gol vs Golf              | M2    | no match: a longer word is another model
 *   digits                   | M3    | "HB20" matches "Manual HB20 2022", not "HB200"
 *   hyphen and dot           | M3    | "HR-V" and "C3 Aircross" are escaped, not read as patterns
 *   any source               | M4    | one text naming the model is enough; null and blank are skipped
 *   separators               | M5    | "HR-V" is found in "hrv", "hr v" and "manual-hr-v.pdf"; "Grand Siena" in "grand-siena";
 *      "C3 Aircross" in "c3-aircross"; "Up!" in "up-2018"; and "Gol" is still not found in "Golf"
 *   label decides            | M4    | `concernsModel`: a label that names the model qualifies, a label that does not is not
 *      rescued by the URL ("Manual Voyage 2015" under `/manual-gol/`), an unlabelled document falls back to its URL
 *   encoded URL              | M4    | "%20" is decoded before the test; a malformed escape is left
 *
 * Out of scope: how the adapters use it (web-search.admission.test.ts) and the ranking of the
 * manuals it qualifies (manuals/select-candidates.test.ts).
 */
import { describe, expect, it } from "vitest";
import { concernsModel, decodedUrl, hasWord, namesModel } from "./model-named.js";

describe("hasWord", () => {
  it("ignores case and accents", () => {
    expect(hasWord("Manual do GOL 2021", "Gol")).toBe(true);
    expect(hasWord("veiculo", "Veículo")).toBe(true);
  });

  it("does not match inside a longer word", () => {
    expect(hasWord("Manual do Golf", "Gol")).toBe(false);
    expect(hasWord("Manual HB200", "HB20")).toBe(false);
  });

  it("matches a model with digits", () => {
    expect(hasWord("Manual do Proprietário HB20 2022", "HB20")).toBe(true);
  });

  it("escapes a hyphen or a dot instead of reading it as a pattern", () => {
    expect(hasWord("/dam/hr-v-2021.pdf", "HR-V")).toBe(true);
    expect(hasWord("Manual C3 Aircross", "C3 Aircross")).toBe(true);
    expect(hasWord("Manual HRXV", "H.-V")).toBe(false);
  });
});

describe("hasWord ignores separators", () => {
  it.each([
    ["Manual Grand Siena 2018", "Grand Siena"],
    ["/dam/manual-grand-siena-2018.pdf", "Grand Siena"],
    ["/dam/manual_grandsiena.pdf", "Grand Siena"],
    ["/dam/manual-hrv-2021.pdf", "HR-V"],
    ["Honda hr v 2021", "HR-V"],
    ["Honda HR-V 2021", "HR-V"],
    ["/dam/manual-hr-v.pdf", "HR-V"],
    ["Manual do C3 Aircross", "C3 Aircross"],
    ["/pt/c3-aircross/manual.pdf", "C3 Aircross"],
    ["manual c3aircross", "C3 Aircross"],
    ["Volkswagen UP! 2018", "Up!"],
    ["/dam/up-2018.pdf", "Up!"],
    ["Manual HB 20 2022", "HB20"],
  ])("finds %j for the model %j", (text, model) => {
    expect(hasWord(text, model)).toBe(true);
  });

  it.each([
    ["Manual do Golf", "Gol"],
    ["/dam/golf-2018.pdf", "Gol"],
    ["Manual Upgrade 2018", "Up!"],
    ["Manual HB200", "HB20"],
    ["Manual HRXV", "HR-V"],
    ["Grand Siena Plus", "Grand Sienna"],
    ["Manual do carro", "!!!"],
  ])("does not find %j for the model %j", (text, model) => {
    expect(hasWord(text, model)).toBe(false);
  });
});

describe("concernsModel", () => {
  const url = "https://x.com.br/dam/manual-gol/a.pdf";

  it("lets a label that names the model qualify, whatever the URL", () => {
    expect(concernsModel({ label: "Manual Gol 2021", url: "https://x.com.br/dam/a1.pdf" }, "Gol")).toBe(true);
  });

  it("does not rescue a label that does not name the model with the URL", () => {
    expect(concernsModel({ label: "Manual Voyage 2015", url }, "Gol")).toBe(false);
  });

  it("falls back to the URL for a document nobody labelled", () => {
    expect(concernsModel({ label: null, url }, "Gol")).toBe(true);
    expect(concernsModel({ label: "   ", url }, "Gol")).toBe(true);
    expect(concernsModel({ label: undefined, url: "https://x.com.br/dam/a1.pdf" }, "Gol")).toBe(false);
  });
});

describe("namesModel", () => {
  it("is true when any one text names the model", () => {
    expect(namesModel([null, "Tabela de preços", "https://x.com.br/dam/onix.pdf"], "Onix")).toBe(true);
  });

  it("is false when none does, and for null and blank texts", () => {
    expect(namesModel([null, undefined, "   ", "Termos da promoção"], "Onix")).toBe(false);
    expect(namesModel([], "Onix")).toBe(false);
  });
});

describe("decodedUrl", () => {
  it("decodes an escaped URL", () => {
    expect(decodedUrl("https://x.com.br/Manual%20Novo%20Polo.pdf")).toBe("https://x.com.br/Manual Novo Polo.pdf");
  });

  it("leaves a malformed escape as it came", () => {
    expect(decodedUrl("https://x.com.br/%E0%A4%A.pdf")).toBe("https://x.com.br/%E0%A4%A.pdf");
  });
});

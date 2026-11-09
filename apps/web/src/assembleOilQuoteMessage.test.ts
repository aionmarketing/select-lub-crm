/**
 * Test design (testing-strategy)
 *
 * Setup: assembleOilQuoteMessage / formatQuotePrice; no HTTP.
 *
 * Oracle: oil-quote spec "Cards carry editable prices and assemble the
 * message live" + design D6 / template.md — numbered options in chosen
 * order; intro checklist and trailer match template.md; price uses pt-BR.
 *
 * Axes
 *   A1 selection order — B then A vs A then B
 *   A2 count — 0 / 1 / 2 / 11 (one past the ten emoji markers)
 *   A3 oil type (add-lubricant-oil-type) — SINTETICO / SEMISSINTETICO / MINERAL / null
 *
 * Outputs
 *   O1 B is 1️⃣ and A is 2️⃣
 *   O2 intro + trailer tokens from template.md
 *   O3 singular "1 opção" vs plural "N opções"
 *   O4 the option's lines: name, then "➡️ Tipo: <label>" when typed, then "➡️ Valor:"
 *
 * Sampled-cell
 *   B then A               | A1 B→A A2 2 | O1+O2 | A numbered first
 *   single option          | A2 1        | O3 singular | "opções"
 *   none selected          | A2 0        | O2+O3 0 opções, no 1️⃣ | invented card
 *   typed option           | A3 each     | O4 the pt-BR label   | the value or the grade printed
 *   untyped option         | A3 null     | O4 no Tipo line      | "Tipo: 5W-40" or "Tipo: " left in
 *
 * Decision map
 *   D1 length === 1        T: singular it; F: 0 and 2 its
 *   D2 selection order     T: B-then-A it; F: (A-then-B unsampled; same mapper)
 *   D3 `OPTION_MARKERS[index] ?? \`${index + 1}.\`` (assembleOilQuoteMessage.ts:47)
 *     — T (index within the ten markers): every it above. F (an 11th
 *     selection, index 10): UNTESTED. No spec scenario or JSDoc says what an
 *     11th option should look like — the workshop's own catalog is small
 *     enough that this may never occur, or "11." may be exactly wrong and a
 *     re-cycled emoji intended instead. Asserting today's `??` output would
 *     read the oracle off the implementation, which testing-strategy and
 *     repo-foundation:114 both rule out. Flagged below as `it.skip` rather
 *     than silently dropped, per repo-foundation:114's owner-decides rule.
 *
 * Out of scope: ConversasPage quote dialog; POST /quotes.
 */
import { describe, expect, it } from "vitest";
import { assembleOilQuoteMessage } from "./assembleOilQuoteMessage.js";

const motul = {
  name: "Motul 8100 X-cess 5W-40",
  oilType: "SINTETICO" as const,
  price: 89.9,
};
const ipiranga = {
  name: "Ipiranga F1 Master 5W-40",
  oilType: null,
  price: 129.9,
};

describe("assembleOilQuoteMessage", () => {
  it("numbers options in the order they were chosen", () => {
    const text = assembleOilQuoteMessage([ipiranga, motul]);

    expect(text.startsWith("Nesse valor já está incluso 👇")).toBe(true);
    expect(text).toContain("✅ Troca de Óleo");
    expect(text).toContain("✅ Filtro de Óleo");
    expect(text).toContain("✅ Filtro de Combustível");
    expect(text).toContain("Temos 2 opções de troca de óleo para o seu veículo 👇");
    const ipirangaAt = text.indexOf("1️⃣ Ipiranga F1 Master");
    const motulAt = text.indexOf("2️⃣ Motul 8100 X-cess");
    expect(ipirangaAt).toBeGreaterThan(0);
    expect(motulAt).toBeGreaterThan(ipirangaAt);
    expect(text).toContain("➡️ Valor: R$ 129,90");
    expect(text).toContain("➡️ Valor: R$ 89,90");
    expect(text).toContain("*Parcelamos em ate 6x sem juros./ Pix ou dinheiro");
    expect(text).toContain("*📌NOSSA SENHORA DO CARMO 670 SANTA TERESINHA ( AO LADO POSTO BIGATON )*");
    expect(text.indexOf("1️⃣ Motul")).toBe(-1);
  });

  it("uses singular opção when one item is selected", () => {
    const text = assembleOilQuoteMessage([motul]);

    expect(text).toContain("Temos 1 opção de troca de óleo para o seu veículo 👇");
    expect(text).not.toContain("Temos 1 opções");
    expect(text).toContain("1️⃣ Motul 8100 X-cess");
  });

  it("keeps the checklist and trailer with zero selections and invents no card", () => {
    const text = assembleOilQuoteMessage([]);

    expect(text).toContain("Nesse valor já está incluso 👇");
    expect(text).toContain("Temos 0 opções de troca de óleo para o seu veículo 👇");
    expect(text).not.toContain("1️⃣");
    expect(text).toContain("*📌NOSSA SENHORA DO CARMO 670 SANTA TERESINHA ( AO LADO POSTO BIGATON )*");
  });

  it.each([
    ["SINTETICO", "Sintético"],
    ["SEMISSINTETICO", "Semissintético"],
    ["MINERAL", "Mineral"],
  ] as const)("writes a %s option as name, Tipo %s, then Valor", (oilType, label) => {
    const text = assembleOilQuoteMessage([{ name: "Motul 8100 Eco-nergy 5W-30", oilType, price: 319.6 }]);

    expect(text).toContain(`1️⃣ Motul 8100 Eco-nergy 5W-30\n➡️ Tipo: ${label}\n➡️ Valor: R$ 319,60`);
  });

  it("omits the Tipo line for an option with no oil type and keeps its Valor", () => {
    const text = assembleOilQuoteMessage([ipiranga]);

    expect(text).toContain("1️⃣ Ipiranga F1 Master 5W-40\n➡️ Valor: R$ 129,90");
    expect(text).not.toContain("Tipo");
  });

  // Flagged for the owner, not deleted: no spec/JSDoc names the 11th-option
  // marker (see D3 above). Un-skip once a human decides "11." vs. something
  // else.
  it.skip("marks an 11th selection past the ten emoji markers — UNSPECIFIED, needs an owner decision", () => {
    const eleven = Array.from({ length: 11 }, (_, i) => ({
      name: `Marca ${i + 1}`,
      oilType: null,
      price: 10,
    }));
    const text = assembleOilQuoteMessage(eleven);
    expect(text).toContain("11. Marca 11");
  });
});

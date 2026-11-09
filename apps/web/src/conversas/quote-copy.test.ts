/**
 * Test design (testing-strategy) — the clarification copy (task 1.12, D17)
 *
 * SUT: clarificationSentence and joinPortugueseList, pure.
 *
 * Oracle: design.md D17's copy table — "Clarification, several engines named", "…several, none
 *   named", "Mismatch, one engine named", "Mismatch, several named", "Mismatch, none named" — and
 *   its list rule: join with ", " and a final " e ". No variant prints empty parentheses.
 */
import { describe, expect, it } from "vitest";
import {
  chosenVolumeFlag,
  conflictCitation,
  filterChoiceHint,
  gradeCitation,
  parseTypedFillVolume,
  saveFillQuestion,
  storedFillFlag,
  volumeChoiceText,
  clarificationSentence,
  consultedSentence,
  incompleteIdentitySentence,
  joinPortugueseList,
  newerAttemptSentence,
  refreshSentence,
  researchingSentence,
} from "./quote-copy.js";

// background-oil-research task 4.5: each research status's main sentence (D17's copy table).
describe("the research sentences", () => {
  const range = { expectedMinutes: { min: 9, max: 11 }, paused: null };

  it("names the missing fields in marca, modelo, versão, ano order", () => {
    expect(incompleteIdentitySentence(["make", "version"])).toBe("Para pesquisar o lubrificante, complete os dados do veículo: marca e versão.");
    expect(incompleteIdentitySentence(["version", "year"])).toBe("Para pesquisar o lubrificante, complete os dados do veículo: versão e ano.");
  });

  it.each([
    [range, "Procurando lubrificante compatível — pode levar entre 9 e 11 minutos.", "Buscando dados novos — pode levar entre 9 e 11 minutos."],
    [{ ...range, paused: { reason: "stopped" as const } }, "A pesquisa automática não está rodando agora; o pedido fica na fila.", "Nova busca na fila, mas a pesquisa automática não está rodando agora."],
    [{ ...range, paused: { reason: "retrying" as const, retryAt: "2026-09-26T17:05:00.000Z" } }, "A última tentativa falhou; vamos tentar de novo às 14:05.", "A nova busca falhou; vamos tentar de novo às 14:05."],
  ])("gives %j its sentences, with no range while paused", (timing, researching, refresh) => {
    expect(researchingSentence(timing)).toBe(researching);
    expect(refreshSentence(timing)).toBe(refresh);
  });

  it("dates the shown row and a newer attempt in São Paulo", () => {
    expect(consultedSentence("2026-09-20T12:00:00.000Z")).toBe("Dados consultados em 20/09/2026.");
    expect(newerAttemptSentence({ outcome: "no_spec", finishedAt: "2026-09-25T12:00:00.000Z" }, "2026-09-20T12:00:00.000Z")).toBe(
      "A nova busca de 25/09/2026 não encontrou uma fonte confiável; mostramos os dados consultados em 20/09/2026.",
    );
    expect(newerAttemptSentence({ outcome: "failed", finishedAt: "2026-09-25T12:00:00.000Z" }, "2026-09-20T12:00:00.000Z")).toBe(
      "Não conseguimos concluir a nova busca de 25/09/2026; mostramos os dados consultados em 20/09/2026.",
    );
  });
});

describe("joinPortugueseList", () => {
  it.each([
    [[], ""],
    [["marca"], "marca"],
    [["marca", "versão"], "marca e versão"],
    [["marca", "modelo", "versão"], "marca, modelo e versão"],
  ])("joins %j as %j", (items, joined) => {
    expect(joinPortugueseList(items)).toBe(joined);
  });
});

describe("clarificationSentence", () => {
  it.each([
    ["several", ["1.0 TSI", "1.6 MSI"], "A fonte cita mais de um motor para este veículo: 1.0 TSI e 1.6 MSI. Confira a versão do veículo."],
    ["several", [], "A fonte cita mais de um motor e não diz qual é o deste veículo. Confira a versão do veículo."],
    ["mismatch", ["1.6"], "A fonte encontrada descreve outro motor (1.6). Confira a versão do veículo."],
    ["mismatch", ["1.6", "2.0"], "A fonte encontrada descreve outros motores (1.6 e 2.0). Confira a versão do veículo."],
    ["mismatch", [], "A fonte encontrada descreve outro motor. Confira a versão do veículo."],
  ] as const)("%s naming %j", (coverage, engines, sentence) => {
    const text = clarificationSentence(coverage, engines);

    expect(text).toBe(sentence);
    expect(text).not.toContain("()");
  });
});

/**
 * background-oil-research tasks 5.10–5.12 (D24, D17's rows of the owner rulings).
 *
 * Oracle: oil-quote "A value that is not a volume is refused" (0, a negative number, text, more
 *   than two decimals), "A volume above 30 L warns"; D24's citation suffix rule (orchestrator,
 *   2026-09-30): the class label when a class is recorded, else the tier's label, omitted when both
 *   are null; and the engine re-read's sentence, with no range.
 */
describe("the dead ends' copy", () => {
  it.each([
    ["4,2", { kind: "ok", liters: 4.2 }],
    ["4.25", { kind: "ok", liters: 4.25 }],
    ["30", { kind: "ok", liters: 30 }],
    ["30,01", { kind: "high", liters: 30.01 }],
    ["42", { kind: "high", liters: 42 }],
    ["0", { kind: "invalid" }],
    ["0,00", { kind: "invalid" }],
    ["-1", { kind: "invalid" }],
    ["abc", { kind: "invalid" }],
    ["4,255", { kind: "invalid" }],
    ["", { kind: "invalid" }],
    ["10000", { kind: "invalid" }],
  ] as const)("reads %j as %j", (raw, expected) => {
    expect(parseTypedFillVolume(raw)).toEqual(expected);
  });

  const source = { sourcePublisher: "Toyota", sourceDocument: "Manual do proprietário Corolla 2019", sourcePage: "p. 412" };

  it.each([
    [{ sourceAuthority: 5, sourceClassification: "manufacturer_manual" as const }, "Toyota, Manual do proprietário Corolla 2019 (p. 412) — manual da montadora"],
    [{ sourceAuthority: 4, sourceClassification: null }, "Toyota, Manual do proprietário Corolla 2019 (p. 412) — guia de aplicação do fabricante de lubrificante"],
    [{ sourceAuthority: null, sourceClassification: null }, "Toyota, Manual do proprietário Corolla 2019 (p. 412)"],
  ])("cites %j with the class first, the tier next, else nothing", (authority, text) => {
    expect(conflictCitation({ ...source, ...authority })).toBe(text);
  });

  it("formats the volume choice, the chosen volume's flag and the grade's citation", () => {
    const manual = { ...source, sourceAuthority: 1, sourceClassification: "manufacturer_manual" as const };
    expect(volumeChoiceText({ liters: 4.3, source: manual })).toBe("4,3 L — Toyota, Manual do proprietário Corolla 2019 (p. 412) — manual da montadora");
    expect(chosenVolumeFlag({ liters: 4.3, source: manual })).toBe("Volume indicado por: Toyota, Manual do proprietário Corolla 2019 (p. 412) — manual da montadora: 4,3 L");
    expect(gradeCitation(manual)).toBe("Viscosidade indicada por: Toyota, Manual do proprietário Corolla 2019 (p. 412) — manual da montadora");
  });

  it("reads the engine re-read with no range, whatever the time", () => {
    const timing = { expectedMinutes: { min: 1, max: 2 }, paused: null, path: "engine_pick" as const, engine: "1.8 Dual VVT-i" };
    expect(researchingSentence(timing, 0)).toBe("Lendo a fonte para o motor 1.8 Dual VVT-i…");
    expect(researchingSentence(timing, 10 * 60_000)).toBe("Lendo a fonte para o motor 1.8 Dual VVT-i…");
    expect(researchingSentence({ ...timing, paused: { reason: "stopped" } }, 0)).toBe(
      "A pesquisa automática não está rodando agora; o pedido fica na fila.",
    );
  });

  it("asks to keep the volume for the model by its identity, and flags a kept one", () => {
    expect(saveFillQuestion(4.2, "Toyota Corolla XEi 2019")).toBe(
      "Guardar 4,2 L como volume da troca para os próximos orçamentos de Toyota Corolla XEi 2019?",
    );
    expect(storedFillFlag({ liters: 4.2, recordedBy: "Marina", recordedAt: "2026-09-20T15:00:00.000Z" })).toBe(
      "Volume informado por Marina em 20/09/2026: 4,2 L",
    );
  });
});

// block-send-until-filter-chosen (owner ruling 2026-10-04): the hint names what is still unchosen.
describe("filterChoiceHint", () => {
  it.each([
    [{ oil: true, fuel: false }, "Escolha o filtro de óleo antes de enviar."],
    [{ oil: false, fuel: true }, "Escolha o filtro de combustível antes de enviar."],
    [{ oil: true, fuel: true }, "Escolha os filtros antes de enviar."],
    [{ oil: false, fuel: false }, null],
  ])("%j reads %j", (unchosen, hint) => {
    expect(filterChoiceHint(unchosen)).toBe(hint);
  });
});

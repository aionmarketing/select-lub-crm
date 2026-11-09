/**
 * Test support: a synthetic, Gol-shaped manual — the six pages the benchmark located for the
 * Gol 2021 (96, 238, 239, 240, 270, 301), rebuilt from the lines background-oil-research D22
 * names, with filler prose around them. Not the manufacturer's text: every line that matters is
 * one D22 quotes, and the rest is invented padding that names no oil word.
 *
 * - p. 238 carries the SAE grades, written `SAE 0W 30` as the `low` benchmark run wrote them;
 * - pp. 239–240 carry the seven decoys D22 lists — the sump, a top-up of about 0,5 l, a
 *   cross-reference to the capacities page, oil consumption;
 * - p. 301 carries the capacities: a `Capacidades` heading with its three engine column heads,
 *   then, six lines further down as in the manual, the row "Quantidade de óleo do motor" /
 *   "(→ Página 236) 3,3 litros 4 litros 4,5 litros".
 */
import type { ManualPage } from "../locate-pages.js";

/** The Gol the benchmark read. */
export const GOL_2021_10 = { make: "Volkswagen", year: 2021, model: "Gol", version: "1.0 FLEX 12V 4P" };

/** Filler lines that name no oil keyword, grade or engine word. */
function prose(count: number, topic: string): string[] {
  return Array.from(
    { length: count },
    (_unused, index) => `${topic}: texto corrido do guia, explicando o item, trecho ${index + 1}.`,
  );
}

/** The two grade lines, as p. 238 prints them. */
export const GOL_GRADE_LINES = ["SAE 0W 30, SAE 0W 40, SAE 5W 30", "SAE 5W 40, SAE 10W 30, SAE 10W 40"];

/**
 * The capacities table's top on p. 301, as the manual prints it: its heading, then one column
 * head per engine. Six other lines sit between it and the oil row, as in the manual, so the row's
 * ±3-line margin does not reach the heads (task 1.13, 2026-09-27).
 */
export const GOL_CAPACITIES_TABLE_HEAD = [
  "Capacidades",
  "Potência do motor",
  "1.0 TOTALFLEX",
  "55/62 kW",
  "1.6 TOTALFLEX",
  "74/76 kW",
  "1.6 TOTALFLEX",
  "81/88 kW",
];

/** The capacities row, as p. 301 prints it: the anchor, then its liters. */
export const GOL_CAPACITY_ROW = ["Quantidade de óleo do motor", "(→ Página 236) 3,3 litros 4 litros 4,5 litros"];

/** The seven decoy lines of pp. 239–240 (D22). */
export const GOL_DECOYS = [
  "o cárter.",
  "(aproximadamente 0,5 l)",
  "mais que 0,5 l)",
  "Aguarde até que o óleo escorra para o cárter",
  "Veja a quantidade de óleo do motor na → Página 299.",
  "O sistema de ventilação do cárter",
  "Um consumo de até 0,5 l em 1.000 km é normal.",
];

/** The six located pages. */
export function golPages(): ManualPage[] {
  const page = (pageNumber: number, lines: string[]): ManualPage => ({ pageNumber, text: lines.join("\n") });
  return [
    page(96, [
      "Luzes de advertência e de controle",
      ...prose(20, "Painel"),
      "Pressão do óleo do motor",
      "Se a luz da pressão do óleo acender, pare o veículo e desligue o motor.",
      ...prose(20, "Painel"),
    ]),
    page(238, [
      ...prose(24, "Motor"),
      "Óleo do motor",
      "Especificação do óleo do motor",
      "Use somente óleos que atendam à norma indicada.",
      "Viscosidades aprovadas:",
      ...GOL_GRADE_LINES,
      "Norma VW 508 00 ou VW 509 00",
      ...prose(24, "Motor"),
    ]),
    page(239, [
      "Verificar o nível do óleo do motor",
      ...prose(4, "Nível"),
      "Com o motor desligado, o óleo escorre de volta para",
      GOL_DECOYS[0]!,
      ...prose(4, "Nível"),
      "Complete com óleo do motor",
      GOL_DECOYS[1]!,
      ...prose(3, "Nível"),
      "Não abasteça",
      GOL_DECOYS[2]!,
      ...prose(2, "Nível"),
      GOL_DECOYS[3]!,
      ...prose(4, "Nível"),
      GOL_DECOYS[4]!,
      "Troque o óleo conforme o plano de manutenção.",
      ...prose(20, "Nível"),
    ]),
    page(240, [
      "Consumo de óleo do motor",
      ...prose(6, "Consumo"),
      GOL_DECOYS[5]!,
      ...prose(6, "Consumo"),
      GOL_DECOYS[6]!,
      ...prose(20, "Consumo"),
    ]),
    page(270, [
      "Plano de manutenção",
      ...prose(10, "Revisão"),
      "Troca de óleo do motor e do filtro de óleo: a cada 10.000 km ou 12 meses",
      ...prose(20, "Revisão"),
    ]),
    page(301, [
      "Dados técnicos",
      ...prose(3, "Dados"),
      ...GOL_CAPACITIES_TABLE_HEAD,
      "Reservatório de água dos lavadores dos vidros",
      "(→ Página 235) 2,4 litros",
      "Tanque de combustível",
      "(→ Página 208)",
      "aproximadamente 55 litros,",
      "dos quais aproximadamente 8 litros de reserva",
      ...GOL_CAPACITY_ROW,
      ...prose(20, "Dados"),
    ]),
  ];
}

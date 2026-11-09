/**
 * Assembles the oil-change proposal from `template.md` and the selected catalog options.
 */
import type { OilType } from "@select-lub/shared-types";
import { oilTypeLabel } from "./oilCardName.js";

const OPTION_MARKERS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];

const INTRO = `Nesse valor já está incluso 👇

✅ Troca de Óleo
✅ Filtro de Óleo
✅ Filtro de Combustível`;

const TRAILER = `*Parcelamos em ate 6x sem juros./ Pix ou dinheiro 
5% de desconto .🤑

Troca de óleo rápida e eficiente! 🚗💧
📌 Atendimento por ordem de chegada.
⏰ Segunda a sexta, das 7:30h às 18h.
⏰ Sábado, das 7h às 12h.

*📌NOSSA SENHORA DO CARMO 670 SANTA TERESINHA ( AO LADO POSTO BIGATON )*`;

/**
 * Formats a quote price the way the proposal message writes Valor (pt-BR, regular space).
 * @param price - Offered amount in BRL; must be non-negative.
 */
export function formatQuotePrice(price: number) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" })
    .format(price)
    .replace(/\u00a0/g, " ");
}

/**
 * Builds the WhatsApp proposal text: fixed checklist, numbered selected options in chosen order, trailer.
 *
 * Each option is its marker and name (brand, description and viscosity — `oilCardName`, the same
 * text as the card title), then `➡️ Tipo:` with the pt-BR oil type, then `➡️ Valor:`. A lubricant
 * with no oil type has no `Tipo` line: the viscosity is already in the name, and writing it under
 * "Tipo" would label a grade as a type in front of the customer (add-lubricant-oil-type, ruling 1).
 *
 * @param selections - Catalog options in the order the attendant selected them: the option name,
 * the lubricant's oil type (`null` when it has none) and the offered price.
 * @returns Message matching `template.md` structure with interpolated options.
 */
export function assembleOilQuoteMessage(selections: Array<{ name: string; oilType: OilType | null; price: number }>) {
  const countLine =
    selections.length === 1
      ? "Temos 1 opção de troca de óleo para o seu veículo 👇"
      : `Temos ${selections.length} opções de troca de óleo para o seu veículo 👇`;
  const options = selections.map((row, index) => {
    const marker = OPTION_MARKERS[index] ?? `${index + 1}.`;
    const label = oilTypeLabel(row.oilType);
    return [`${marker} ${row.name}`, ...(label == null ? [] : [`➡️ Tipo: ${label}`]), `➡️ Valor: ${formatQuotePrice(row.price)}`].join("\n");
  });
  return [INTRO, "", countLine, "", ...options.flatMap((block) => [block, ""]), TRAILER]
    .join("\n")
    .replace(/\n\n\n+/g, "\n\n");
}

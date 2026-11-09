/**
 * Test design (testing-strategy) — sending waits for every filter choice
 * (block-send-until-filter-chosen, owner ruling 2026-10-04)
 *
 * Setup: ConversasPage in AppProviders, MSW (`test/quote-dialog.ts`). Shared code only, so the file
 *   runs in both variants (`pnpm test` and `pnpm test:web:antigravity`).
 *
 * Oracle: oil-quote "Each oil option is priced with one filter per type", as modified by this
 *   change — "An unchosen filter blocks the send", "Both types unchosen name both filters",
 *   "Choosing every multi-candidate type unblocks the send", "The blocked button keeps focus", "One
 *   candidate or no match does not block", "The block applies to a typed volume and to a conflict's
 *   cards"; background-oil-research D17 (one persistent `role="status"`, no `role="alert"`).
 *
 * Fixture: the tour's Polo — two oil-filter candidates, PSL545 at 38,90 and FOL0545 at 33,50 — with
 *   a single fuel filter at 45,00, 50,00 per litre and 4 L. The quote POST is recorded; the helper
 *   answers it 500, which is irrelevant here: what matters is whether it was sent at all.
 *
 * Cells
 *   oil two, unchosen          | aria-disabled, hint beside it and in the status, click sends nothing | a quote sent without the filter it promises
 *   oil two + fuel two          | "Escolha os filtros antes de enviar."                               | only one type named
 *   oil two → choose FOL0545    | no hint, not aria-disabled, POST carries FOL0545's line              | a block that never lifts
 *   focused, Enter while blocked| focus stays on the button, the hidden status span is replaced        | `disabled` dropping focus; a silent refusal
 *   one candidate each          | available, no hint                                                   | blocking a quote with nothing to choose
 *   no catalog match            | available, no hint                                                   | a warning treated as a choice
 *   typed volume, oil two       | aria-disabled with the oil hint                                      | the dead end bypassing the block
 *   conflict cards, oil two     | aria-disabled with the oil hint                                      | the conflict bypassing the block
 */
import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { catalogItemFixture, lubricantDetailFixture, type QuoteFilterCard } from "@select-lub/shared-types";
import { useSelection } from "./selectionStore.js";
import { server } from "../test/msw/server.js";
import { openQuoteDialog } from "../test/quote-dialog.js";

const SEND = "Enviar via WhatsApp";
const OIL_HINT = "Escolha o filtro de óleo antes de enviar.";
const BOTH_HINT = "Escolha os filtros antes de enviar.";

const oilCard = { ...catalogItemFixture, lubricant: lubricantDetailFixture, price: 50 };

function filterCard(id: string, brand: string, filterType: "OLEO" | "COMBUSTIVEL", partNumber: string, price: number): QuoteFilterCard {
  return {
    id,
    brand,
    description: filterType === "OLEO" ? "Filtro de óleo" : "Filtro de combustível",
    price,
    stock: 0,
    active: true,
    createdAt: "2026-08-21T10:00:00.000Z",
    updatedAt: "2026-08-26T12:00:00.000Z",
    filter: { catalogItemId: id, filterType, partNumber },
  };
}

const PSL545 = filterCard("cat-tecfil-psl545", "Tecfil", "OLEO", "PSL545", 38.9);
const FOL0545 = filterCard("cat-authomix-fol0545", "Authomix", "OLEO", "FOL0545", 33.5);
const GI50 = filterCard("cat-tecfil-gi50-7", "Tecfil", "COMBUSTIVEL", "GI50/7", 45);
const FCO0507 = filterCard("cat-authomix-fco0507", "Authomix", "COMBUSTIVEL", "FCO0507", 41);

function filters(overrides: object = {}) {
  return {
    source: "cached",
    consultedAt: "2026-09-03T18:00:00.000Z",
    application: { manufacturer: "VOLKSWAGEN", vehicle: "POLO", engine: "1.0 12V 128cv" },
    oil: { status: "matched", candidates: [PSL545, FOL0545] },
    fuel: { status: "matched", candidates: [GI50] },
    ...overrides,
  };
}

const MANUAL = {
  sourcePublisher: "Volkswagen",
  sourceDocument: "Manual do proprietário Polo 2021",
  sourcePage: "p. 287",
  sourceAuthority: 1,
  sourceUrl: null,
};

function options(filterBlock: object) {
  return {
    status: "options",
    viscosityGrades: [lubricantDetailFixture.viscosity],
    viscosity: lubricantDetailFixture.viscosity,
    classification: "",
    fillLiters: 4,
    fillKind: "em_servico",
    fillCondition: "with_filter",
    ...MANUAL,
    gradeSources: [{ grade: lubricantDetailFixture.viscosity, ...MANUAL }],
    litersSource: MANUAL,
    consultedAt: "2026-09-12T12:00:00.000Z",
    options: [oilCard],
    filters: filterBlock,
  };
}

afterEach(() => {
  useSelection.setState({ selectedConversationId: null });
  server.resetHandlers();
});

/** The send button, once the cards are priced. */
async function sendButton(dialog: HTMLElement) {
  await waitFor(() => expect(within(dialog).getByLabelText("Preço")).toBeInTheDocument());
  return within(dialog).getByRole("button", { name: SEND });
}

describe("sending waits for every filter choice", () => {
  it("blocks while the oil filter is unchosen: aria-disabled, the hint beside it and in the status, nothing sent", async () => {
    const seq = await openQuoteDialog({ reads: [options(filters())] });
    const send = await sendButton(seq.dialog);

    expect(send).toHaveAttribute("aria-disabled", "true");
    expect(send).not.toBeDisabled();
    expect(send).toHaveAccessibleDescription(OIL_HINT);
    expect(within(seq.dialog).getByRole("status")).toHaveTextContent(OIL_HINT);
    expect(within(seq.dialog).getAllByRole("status")).toHaveLength(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await seq.user.click(send);
    await seq.user.click(send);
    expect(seq.quotePosts).toEqual([]);
  });

  it("names both filters when neither type is chosen", async () => {
    const seq = await openQuoteDialog({ reads: [options(filters({ fuel: { status: "matched", candidates: [GI50, FCO0507] } }))] });
    const send = await sendButton(seq.dialog);

    expect(send).toHaveAttribute("aria-disabled", "true");
    expect(send).toHaveAccessibleDescription(BOTH_HINT);
    expect(within(seq.dialog).getByRole("status")).toHaveTextContent(BOTH_HINT);
  });

  it("unblocks once the filter is chosen, and sends the chosen filter's line", async () => {
    const seq = await openQuoteDialog({ reads: [options(filters())] });
    await sendButton(seq.dialog);

    await seq.user.click(within(seq.dialog).getByRole("button", { name: /Authomix.*FOL0545/ }));

    const send = within(seq.dialog).getByRole("button", { name: SEND });
    await waitFor(() => expect(send).not.toHaveAttribute("aria-disabled"));
    expect(send).not.toHaveAccessibleDescription(OIL_HINT);
    expect(within(seq.dialog).getByRole("status")).not.toHaveTextContent(OIL_HINT);
    // 50,00 × 4 L + 33,50 + 45,00.
    expect(within(seq.dialog).getByLabelText("Preço")).toHaveValue("278,50");

    await seq.user.click(send);
    await waitFor(() => expect(seq.quotePosts).toHaveLength(1));
    expect(seq.quotePosts[0]?.lines).toEqual([
      { catalogItemId: oilCard.id, price: 278.5 },
      { catalogItemId: FOL0545.id, price: 33.5 },
      { catalogItemId: GI50.id, price: 45 },
    ]);
  });

  it("keeps focus on the blocked button and reads the hint again when it is activated", async () => {
    const seq = await openQuoteDialog({ reads: [options(filters())] });
    const send = await sendButton(seq.dialog);
    const status = within(seq.dialog).getByRole("status");
    const before = within(status).getByText(OIL_HINT);

    send.focus();
    await seq.user.keyboard("{Enter}");

    expect(send).toHaveFocus();
    expect(seq.quotePosts).toEqual([]);
    // The announcement's span is replaced, so a screen reader hears the sentence again.
    const after = within(within(seq.dialog).getByRole("status")).getByText(OIL_HINT);
    expect(after).not.toBe(before);
    expect(within(seq.dialog).getByRole("status")).toBe(status);
  });

  it.each([
    ["one candidate per type", filters({ oil: { status: "matched", candidates: [PSL545] } })],
    ["an oil filter with no catalog match", filters({ oil: { status: "no_catalog_match", tecfilNumbers: ["PSL545"] } })],
  ])("does not block with %s", async (_name, filterBlock) => {
    const seq = await openQuoteDialog({ reads: [options(filterBlock)] });
    const send = await sendButton(seq.dialog);

    expect(send).toBeEnabled();
    expect(send).not.toHaveAttribute("aria-disabled");
    expect(within(seq.dialog).queryByText(OIL_HINT)).not.toBeInTheDocument();
    expect(within(seq.dialog).getByRole("status")).not.toHaveTextContent(/Escolha o/);
  });

  it("blocks a quote priced from a typed volume", async () => {
    const seq = await openQuoteDialog({
      reads: [
        {
          status: "no_capacity",
          viscosityGrades: [lubricantDetailFixture.viscosity],
          viscosity: lubricantDetailFixture.viscosity,
          classification: "",
          consultedAt: "2026-09-12T12:00:00.000Z",
          options: [oilCard],
          filters: filters(),
        },
      ],
    });
    const input = await within(seq.dialog).findByLabelText("Volume de óleo da troca (litros)");
    await seq.user.type(input, "4");
    await seq.user.click(within(seq.dialog).getByRole("button", { name: "Usar este volume" }));
    await seq.user.click(within(await screen.findByRole("dialog", { name: /Guardar/ })).getByRole("button", { name: "Só neste orçamento" }));

    const send = await sendButton(seq.dialog);
    expect(send).toHaveAttribute("aria-disabled", "true");
    expect(send).toHaveAccessibleDescription(OIL_HINT);
    await seq.user.click(send);
    expect(seq.quotePosts).toEqual([]);
  });

  it("blocks a conflict's cards once its grade is chosen", async () => {
    const seq = await openQuoteDialog({
      reads: [
        {
          status: "conflicting_sources",
          conflicts: [
            {
              field: "viscosityGrades",
              values: [
                { value: "0W-20", sourcePublisher: "Volkswagen", sourceDocument: MANUAL.sourceDocument, sourcePage: MANUAL.sourcePage, sourceAuthority: 1 },
                { value: "5W-40", sourcePublisher: "Lubrax", sourceDocument: "Guia de aplicação VW", sourcePage: "p. 31", sourceAuthority: 4 },
              ],
            },
          ],
          viscosityGrades: ["0W-20", "5W-40"],
          classification: "",
          gradeSources: [
            { grade: "0W-20", ...MANUAL, sourceClassification: "manufacturer_manual" },
            { grade: "5W-40", sourcePublisher: "Lubrax", sourceDocument: "Guia de aplicação VW", sourcePage: "p. 31", sourceAuthority: 4, sourceUrl: null, sourceClassification: null },
          ],
          options: [
            {
              ...oilCard,
              id: "cat-mobil",
              brand: "Mobil",
              description: "Super 3000 0W-20",
              lubricant: { catalogItemId: "cat-mobil", viscosity: "0W-20", classification: "", oilType: "SINTETICO" },
              gradeSource: { ...MANUAL, sourceClassification: "manufacturer_manual" },
            },
          ],
          filters: filters(),
          fillLiters: 4,
          fillKind: "em_servico",
          fillCondition: "with_filter",
          litersSource: { ...MANUAL, sourceClassification: "manufacturer_manual" },
        },
      ],
    });
    await seq.user.click(await within(seq.dialog).findByRole("radio", { name: /^0W-20/ }));

    const send = await sendButton(seq.dialog);
    expect(send).toHaveAttribute("aria-disabled", "true");
    expect(send).toHaveAccessibleDescription(OIL_HINT);
    await seq.user.click(send);
    expect(seq.quotePosts).toEqual([]);
  });
});

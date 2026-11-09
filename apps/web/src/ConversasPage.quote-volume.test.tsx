/**
 * Test design (testing-strategy) — the missing volume's way out (background-oil-research task 5.10)
 *
 * Setup: ConversasPage in AppProviders, MSW (`test/quote-dialog.ts`); the quote-options GET answers
 *   `no_capacity` with its cards and filters, the volume POST records its body. Shared code only,
 *   so the file runs in both variants (`pnpm test:web:antigravity`).
 *
 * Oracle: oil-quote "The attendant can type a missing fill volume" — its scenarios "A typed volume
 *   prices the cards", "Using a typed volume asks whether to keep it", "Only this quote stores
 *   nothing", "Failing to keep the volume keeps the cards priced", "Sending does not ask again", "A
 *   value that is not a volume is refused", "A volume above 30 L warns", "A confirmed high volume
 *   prices and can be kept", "A kept volume prices the next quote, flagged"; D17's copy rows of the
 *   owner rulings; D24.1's accessibility (the label names the input, the hint and the warning
 *   describe it, the warning and the failure go through the one `role="status"`, no alert).
 *
 * Fixture: 40,00 per litre with an oil filter at 32,00 and a fuel filter at 45,00, so 4,2 L prices
 *   168,00 + 77,00 = 245,00 — far from 168,00 (filters dropped) and from 40,00 (one litre).
 *
 * Cells
 *   4,2 → Usar → Só neste orçamento | 245,00, the attendant's flag, no POST           | unit price, or a stored volume
 *   0 / -1 / texto / 4,255           | nothing priced, the sentence, in the status, no prompt | a price from a non-volume
 *   42 → Usar → Usar mesmo assim → Guardar | priced 1757,00, the flag, POST confirmHighVolume | a block, or the flag lost
 *   4,2 → Guardar                    | POST { liters: 4.2 } with no confirmation       | a confirmation sent for a normal volume
 *   Guardar fails                    | dialog open, 245,00 kept, sentence in the status | the cards dropped
 *   Enviar via WhatsApp              | the quote POST, no prompt                        | the prompt on sending
 *   keyboard                         | the prompt takes focus, Escape returns it to Usar este volume | focus lost to the body
 *   options with attendantFill       | "Volume informado por Marina em 20/09/2026: 4,2 L" | the stored figure unflagged
 */
import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";
import { catalogItemFixture, lubricantDetailFixture, type QuoteFilterCard } from "@select-lub/shared-types";
import { useSelection } from "./selectionStore.js";
import { server } from "../test/msw/server.js";
import { openQuoteDialog } from "../test/quote-dialog.js";

const LABEL = "Volume de óleo da troca (litros)";
const HINT = "Informe o volume em serviço, com filtro.";
const INVALID = "Informe o volume em litros, maior que zero.";
const HIGH = "Volume alto — confira antes de usar.";
const SAVE_FAILED = "Não foi possível guardar o volume para os próximos orçamentos.";

const oilCard = { ...catalogItemFixture, lubricant: lubricantDetailFixture, price: 40 };

function filterCard(id: string, filterType: "OLEO" | "COMBUSTIVEL", partNumber: string, price: number): QuoteFilterCard {
  return {
    id,
    brand: "Tecfil",
    description: filterType === "OLEO" ? "Filtro de óleo" : "Filtro de combustível",
    price,
    stock: 0,
    active: true,
    createdAt: "2026-08-21T10:00:00.000Z",
    updatedAt: "2026-08-26T12:00:00.000Z",
    filter: { catalogItemId: id, filterType, partNumber },
  };
}

const FILTERS = {
  source: "cached",
  consultedAt: "2026-09-03T18:00:00.000Z",
  application: { manufacturer: "TOYOTA", vehicle: "COROLLA", engine: "1.8" },
  oil: { status: "matched", candidates: [filterCard("cat-oil", "OLEO", "PEL108", 32)] },
  fuel: { status: "matched", candidates: [filterCard("cat-fuel", "COMBUSTIVEL", "GI50/7", 45)] },
};

const NO_CAPACITY = {
  status: "no_capacity",
  viscosityGrades: [lubricantDetailFixture.viscosity],
  viscosity: lubricantDetailFixture.viscosity,
  classification: "",
  consultedAt: "2026-09-12T12:00:00.000Z",
  options: [oilCard],
  filters: FILTERS,
};

const MANUAL = {
  sourcePublisher: "Toyota",
  sourceDocument: "Manual do proprietário Corolla 2019",
  sourcePage: "p. 412",
  sourceAuthority: 1,
  sourceUrl: null,
};

afterEach(() => {
  useSelection.setState({ selectedConversationId: null });
  server.resetHandlers();
});

/** Types a volume and chooses "Usar este volume". */
async function typeAndUse(seq: Awaited<ReturnType<typeof openQuoteDialog>>, text: string) {
  const input = await within(seq.dialog).findByLabelText(LABEL);
  await seq.user.clear(input);
  await seq.user.type(input, text);
  await seq.user.click(within(seq.dialog).getByRole("button", { name: "Usar este volume" }));
}

describe("the missing volume", () => {
  it("prices the cards from a typed volume, flagged, and stores nothing on Só neste orçamento", async () => {
    const seq = await openQuoteDialog({ reads: [NO_CAPACITY] });
    expect(
      await within(seq.dialog).findByText(/mas não o volume\s*de óleo da troca para este veículo\. Informe o volume da troca para calcular o valor\./),
    ).toBeInTheDocument();
    // Nothing is priced before a volume is used.
    expect(within(seq.dialog).queryByLabelText("Preço")).not.toBeInTheDocument();

    await typeAndUse(seq, "4,2");
    const prompt = await screen.findByRole("dialog", { name: /Guardar 4,2 L/ });
    expect(prompt).toHaveTextContent("Guardar 4,2 L como volume da troca para os próximos orçamentos de Toyota Corolla XEi 2019?");
    await seq.user.click(within(prompt).getByRole("button", { name: "Só neste orçamento" }));

    await waitFor(() => expect(within(seq.dialog).getByLabelText("Preço")).toHaveValue("245,00"));
    expect(within(seq.dialog).getByText("Volume informado pelo atendente: 4,2 L")).toBeInTheDocument();
    expect(seq.fillPosts).toEqual([]);
    expect(screen.queryByRole("dialog", { name: /Guardar/ })).not.toBeInTheDocument();
  });

  it.each(["0", "-1", "abc", "4,255"])("refuses %s: nothing priced, the sentence by the field and in the status", async (text) => {
    const seq = await openQuoteDialog({ reads: [NO_CAPACITY] });
    await typeAndUse(seq, text);

    expect(within(seq.dialog).getByRole("status")).toHaveTextContent(INVALID);
    const input = within(seq.dialog).getByLabelText(LABEL);
    expect(input).toHaveAccessibleDescription(`${INVALID} ${HINT}`);
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(within(seq.dialog).queryByLabelText("Preço")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: /Guardar/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("warns above 30 L, prices nothing until Usar mesmo assim, then keeps it with confirmHighVolume", async () => {
    const seq = await openQuoteDialog({ reads: [NO_CAPACITY] });
    await typeAndUse(seq, "42");

    expect(within(seq.dialog).getByRole("status")).toHaveTextContent(HIGH);
    expect(within(seq.dialog).getByLabelText(LABEL)).toHaveAccessibleDescription(`${HIGH} ${HINT}`);
    expect(within(seq.dialog).queryByLabelText("Preço")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: /Guardar/ })).not.toBeInTheDocument();

    await seq.user.click(within(seq.dialog).getByRole("button", { name: "Usar mesmo assim" }));
    const prompt = await screen.findByRole("dialog", { name: /Guardar 42 L/ });
    await seq.user.click(within(prompt).getByRole("button", { name: "Guardar para este modelo" }));

    // 40,00 × 42 L + 77,00.
    await waitFor(() => expect(within(seq.dialog).getByLabelText("Preço")).toHaveValue("1757,00"));
    expect(within(seq.dialog).getByText("Volume informado pelo atendente: 42 L")).toBeInTheDocument();
    await waitFor(() => expect(seq.fillPosts).toEqual([{ liters: 42, confirmHighVolume: true }]));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps a normal volume with Guardar para este modelo, sending no confirmation", async () => {
    const seq = await openQuoteDialog({ reads: [NO_CAPACITY] });
    await typeAndUse(seq, "4,2");
    await seq.user.click(within(await screen.findByRole("dialog", { name: /Guardar/ })).getByRole("button", { name: "Guardar para este modelo" }));

    await waitFor(() => expect(seq.fillPosts).toEqual([{ liters: 4.2 }]));
    expect(within(seq.dialog).getByLabelText("Preço")).toHaveValue("245,00");
    expect(screen.getByRole("dialog", { name: /Montar orçamento/ })).toBeInTheDocument();
  });

  it("keeps the dialog open and the cards priced when keeping the volume fails, and says so in the status", async () => {
    const seq = await openQuoteDialog({ reads: [NO_CAPACITY], fillVolume: () => HttpResponse.json({}, { status: 500 }) });
    await typeAndUse(seq, "4,2");
    await seq.user.click(within(await screen.findByRole("dialog", { name: /Guardar/ })).getByRole("button", { name: "Guardar para este modelo" }));

    await waitFor(() => expect(within(seq.dialog).getByRole("status")).toHaveTextContent(SAVE_FAILED));
    expect(within(seq.dialog).getAllByText(SAVE_FAILED).length).toBeGreaterThan(0);
    expect(within(seq.dialog).getByLabelText("Preço")).toHaveValue("245,00");
    expect(within(seq.dialog).getAllByRole("status")).toHaveLength(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("never opens the prompt on Enviar via WhatsApp", async () => {
    const seq = await openQuoteDialog({ reads: [NO_CAPACITY] });
    await typeAndUse(seq, "4,2");
    await seq.user.click(within(await screen.findByRole("dialog", { name: /Guardar/ })).getByRole("button", { name: "Só neste orçamento" }));
    await waitFor(() => expect(within(seq.dialog).getByLabelText("Preço")).toHaveValue("245,00"));

    await seq.user.click(within(seq.dialog).getByRole("button", { name: "Enviar via WhatsApp" }));

    await waitFor(() => expect(seq.quotePosts).toHaveLength(1));
    expect(screen.queryByRole("dialog", { name: /Guardar/ })).not.toBeInTheDocument();
    expect(seq.fillPosts).toEqual([]);
  });

  it("names the input by its label and describes it by the hint", async () => {
    const seq = await openQuoteDialog({ reads: [NO_CAPACITY] });

    const input = await within(seq.dialog).findByRole("textbox", { name: LABEL });
    expect(input).toHaveAccessibleDescription(HINT);
  });

  it("puts the prompt in reach of the keyboard and returns focus to Usar este volume", async () => {
    const seq = await openQuoteDialog({ reads: [NO_CAPACITY] });
    const input = await within(seq.dialog).findByLabelText(LABEL);
    await seq.user.type(input, "4,2{Enter}");

    const prompt = await screen.findByRole("dialog", { name: /Guardar 4,2 L/ });
    await waitFor(() => expect(prompt.contains(document.activeElement)).toBe(true));
    await seq.user.keyboard("{Escape}");

    await waitFor(() => expect(within(seq.dialog).getByRole("button", { name: "Usar este volume" })).toHaveFocus());
    expect(screen.queryByRole("dialog", { name: /Guardar/ })).not.toBeInTheDocument();
    expect(seq.fillPosts).toEqual([]);
  });

  it("flags a kept volume on every card with who typed it and when", async () => {
    const seq = await openQuoteDialog({
      reads: [
        {
          status: "options",
          viscosityGrades: [lubricantDetailFixture.viscosity],
          viscosity: lubricantDetailFixture.viscosity,
          classification: "",
          fillLiters: 4.2,
          fillKind: "em_servico",
          fillCondition: "with_filter",
          ...MANUAL,
          gradeSources: [{ grade: lubricantDetailFixture.viscosity, ...MANUAL }],
          attendantFill: { liters: 4.2, recordedBy: "Marina", recordedAt: "2026-09-20T15:00:00.000Z" },
          consultedAt: "2026-09-12T12:00:00.000Z",
          options: [oilCard],
          filters: FILTERS,
        },
      ],
    });

    expect(await within(seq.dialog).findByText("Volume informado por Marina em 20/09/2026: 4,2 L")).toBeInTheDocument();
    await waitFor(() => expect(within(seq.dialog).getByLabelText("Preço")).toHaveValue("245,00"));
  });

  // Review of #198, finding 4: a refused re-type must not leave the previous volume pricing the cards.
  it.each(["0", "42"])("unprices the cards when a re-typed %s is refused", async (text) => {
    const seq = await openQuoteDialog({ reads: [NO_CAPACITY] });
    await typeAndUse(seq, "4,2");
    await seq.user.click(within(await screen.findByRole("dialog", { name: /Guardar/ })).getByRole("button", { name: "Só neste orçamento" }));
    await waitFor(() => expect(within(seq.dialog).getByLabelText("Preço")).toHaveValue("245,00"));

    await typeAndUse(seq, text);

    expect(within(seq.dialog).queryByLabelText("Preço")).not.toBeInTheDocument();
    expect(within(seq.dialog).queryByText(/Volume informado pelo atendente/)).not.toBeInTheDocument();
    expect(within(seq.dialog).queryByRole("button", { name: "Enviar via WhatsApp" })).not.toBeInTheDocument();
  });

  it("reads a repeated refusal again, and puts a new refusal before a stale save failure", async () => {
    const seq = await openQuoteDialog({ reads: [NO_CAPACITY], fillVolume: () => HttpResponse.json({}, { status: 500 }) });
    await typeAndUse(seq, "4,2");
    await seq.user.click(within(await screen.findByRole("dialog", { name: /Guardar/ })).getByRole("button", { name: "Guardar para este modelo" }));
    await waitFor(() => expect(within(seq.dialog).getByRole("status")).toHaveTextContent(SAVE_FAILED));

    await typeAndUse(seq, "0");
    const status = within(seq.dialog).getByRole("status");
    expect(status).toHaveTextContent(INVALID);
    expect(status).not.toHaveTextContent(SAVE_FAILED);
    const first = within(status).getByText(INVALID);

    await seq.user.click(within(seq.dialog).getByRole("button", { name: "Usar este volume" }));

    // The same sentence in a new node: a live region announces an inserted node, not an unchanged one.
    const second = within(within(seq.dialog).getByRole("status")).getByText(INVALID);
    expect(second).not.toBe(first);
    expect(first.isConnected).toBe(false);
  });

  it("rebuilds an edited message when another volume is used", async () => {
    const seq = await openQuoteDialog({ reads: [NO_CAPACITY] });
    await typeAndUse(seq, "4,2");
    await seq.user.click(within(await screen.findByRole("dialog", { name: /Guardar/ })).getByRole("button", { name: "Só neste orçamento" }));
    await seq.user.type(await within(seq.dialog).findByLabelText("Mensagem"), " editado à mão");

    await typeAndUse(seq, "5");
    await seq.user.click(within(await screen.findByRole("dialog", { name: /Guardar 5 L/ })).getByRole("button", { name: "Só neste orçamento" }));

    // 40,00 × 5 L + 77,00.
    await waitFor(() => expect(within(seq.dialog).getByLabelText("Preço")).toHaveValue("277,00"));
    const rebuilt = (within(seq.dialog).getByLabelText("Mensagem") as HTMLTextAreaElement).value;
    expect(rebuilt).not.toContain("editado à mão");
    expect(rebuilt).toContain("R$ 277,00");
  });

  // Review of #198, finding 3: D17's held newer row covers the missing volume once it is priced.
  it("swaps a typed-volume quote silently to the newer row when nothing was edited", { timeout: 30_000 }, async () => {
    const refreshing = {
      ...NO_CAPACITY,
      refresh: { requestedAt: "2026-10-01T12:00:00.000Z", now: "2026-10-01T12:00:10.000Z", expectedMinutes: { min: 1, max: 5 }, queuePosition: 0, path: "search", paused: null },
    };
    const seq = await openQuoteDialog({ reads: [refreshing, { ...NO_CAPACITY, consultedAt: "2026-09-27T12:00:00.000Z" }] });
    await typeAndUse(seq, "4,2");
    await seq.user.click(within(await screen.findByRole("dialog", { name: /Guardar/ })).getByRole("button", { name: "Só neste orçamento" }));

    await waitFor(() => expect(within(seq.dialog).getByRole("status")).toHaveTextContent("Dados consultados em 27/09/2026."), { timeout: 6_000 });
    expect(within(seq.dialog).queryByText(/Chegaram dados novos/)).not.toBeInTheDocument();
    await waitFor(() => expect(within(seq.dialog).getByLabelText("Preço")).toHaveValue("245,00"));
  });

  it("holds an edited typed-volume quote behind Chegaram dados novos", { timeout: 30_000 }, async () => {
    const refreshing = {
      ...NO_CAPACITY,
      refresh: { requestedAt: "2026-10-01T12:00:00.000Z", now: "2026-10-01T12:00:10.000Z", expectedMinutes: { min: 1, max: 5 }, queuePosition: 0, path: "search", paused: null },
    };
    const newer = { ...NO_CAPACITY, consultedAt: "2026-09-27T12:00:00.000Z" };
    const held = await openQuoteDialog({ reads: [refreshing, newer] });
    await typeAndUse(held, "4,2");
    await held.user.click(within(await screen.findByRole("dialog", { name: /Guardar/ })).getByRole("button", { name: "Só neste orçamento" }));
    const price = await within(held.dialog).findByLabelText("Preço");
    await held.user.clear(price);
    await held.user.type(price, "300,00");

    await waitFor(() => expect(within(held.dialog).getByRole("status")).toHaveTextContent("Chegaram dados novos de 27/09/2026."), { timeout: 6_000 });
    expect(within(held.dialog).getByLabelText("Preço")).toHaveValue("300,00");
  });

  it("ends the unusable-volume sentence with the input's call", async () => {
    const seq = await openQuoteDialog({ reads: [{ ...NO_CAPACITY, unusableFill: { liters: 3.6, condition: "dry" } }] });

    expect(
      await within(seq.dialog).findByText(/um volume\s*seco de 3,6 L,\s*mas esse não é o volume usado numa troca de óleo\. Informe o volume da troca para calcular o valor\./),
    ).toBeInTheDocument();
    expect(within(seq.dialog).getByLabelText(LABEL)).toBeInTheDocument();
  });
});

/**
 * Test design (testing-strategy) — the conflicting sources' way out (background-oil-research task 5.12)
 *
 * Setup: ConversasPage in AppProviders, MSW (`test/quote-dialog.ts`); the quote-options GET answers
 *   a `conflicting_sources` with its card data. Shared code only, so the file runs in both variants
 *   (`pnpm test:web:antigravity`).
 *
 * Oracle: oil-quote "Disagreeing sources are surfaced, never silently decided" — "A grade conflict
 *   offers every grade's cards, each citing its source", "A volume conflict is a choice", "Grade and
 *   volume both in conflict ask for both", "A conflict stored in the old shape offers no cards";
 *   D24.3 (nothing preselected, the choice by grade, the citation suffix rule, a null URL shows no
 *   link, the no-compatible-brand copy with the sources, a grade conflict with no stated volume
 *   priced from a typed one); D24's accessibility (a `radiogroup` of `aria-checked` options, the
 *   arrow keys move the choice, the focus ring, the 44 px target).
 *
 * Fixture: the manual (tier 1, class manufacturer_manual) lists 0W-20 — Mobil at 45,00/L — and the
 *   lubricant guide (tier 4, no class) lists 5W-30 — Motul at 47,00/L and Lubrax at 42,00/L — at an
 *   agreed 4 L, with filters at 32,00 + 45,00. So Motul is 265,00 and Lubrax 245,00, and at 4,3 L
 *   Motul is 279,10: each far from the unit price and from a price without the filters.
 *
 * Cells
 *   open                       | every radio aria-checked=false, previews only, no price box, send off | a preselected grade
 *   each grade's radio         | its own source with its suffix (class, else tier, else none)        | a grade cited to a source that does not list it
 *   choose 5W-30, then 0W-20   | the grade's stocked oils are the cards, the other's dropped, the message from them
 *   volume conflict            | "escolha o volume" until chosen, then priced from it, flagged, send on
 *   grade + volume             | the message only after both choices
 *   no stated volume           | the volume field, priced from the typed figure
 *   nothing stocked            | the no-compatible-brand copy with each grade's source, no radios
 *   keyboard                   | ArrowDown moves the choice and focus; the focus ring class; 44 px
 */
import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Theme } from "@mui/material/styles";
import type { QuoteFilterCard } from "@select-lub/shared-types";
import { useSelection } from "./selectionStore.js";
import { createAppTheme } from "./theme.js";
import { server } from "../test/msw/server.js";
import { openQuoteDialog } from "../test/quote-dialog.js";

const GRADE_INTRO =
  "As fontes consultadas discordam sobre a viscosidade deste veículo. Mostramos as opções de cada fonte — escolha a que vale para este carro.";
const VOLUME_INTRO = "As fontes consultadas discordam sobre o volume de óleo da troca. Escolha o volume que vale para este carro.";
const VOLUME_ALSO = "As fontes também discordam sobre o volume da troca. Escolha o volume:";

const MANUAL = {
  sourcePublisher: "Toyota",
  sourceDocument: "Manual do proprietário Corolla 2019",
  sourcePage: "p. 412",
  sourceAuthority: 1,
  sourceUrl: "https://toyota.com.br/manual-corolla-2019.pdf",
  sourceClassification: "manufacturer_manual",
} as const;

const GUIDE = {
  sourcePublisher: "Lubrax",
  sourceDocument: "Guia de aplicação Toyota",
  sourcePage: "p. 18",
  sourceAuthority: 4,
  sourceUrl: null,
  sourceClassification: null,
} as const;

const CATALOG = {
  sourcePublisher: "CarroRac",
  sourceDocument: "Tabela de aplicação",
  sourcePage: "Corolla 2019",
  sourceAuthority: null,
  sourceUrl: null,
  sourceClassification: null,
} as const;

const MANUAL_CITE = "Toyota, Manual do proprietário Corolla 2019 (p. 412) — manual da montadora";
const GUIDE_CITE = "Lubrax, Guia de aplicação Toyota (p. 18) — guia de aplicação do fabricante de lubrificante";

/** A stocked oil; `oilType` defaults to the canvas's "Sintético" (add-lubricant-oil-type). */
function oil(
  id: string,
  brand: string,
  description: string,
  viscosity: string,
  price: number,
  gradeSource: object,
  oilType: "SINTETICO" | "SEMISSINTETICO" | "MINERAL" | null = "SINTETICO",
) {
  return {
    id,
    brand,
    description,
    price,
    stock: 4,
    active: true,
    createdAt: "2026-08-21T10:00:00.000Z",
    updatedAt: "2026-08-26T12:00:00.000Z",
    lubricant: { catalogItemId: id, viscosity, classification: "", oilType },
    gradeSource,
  };
}

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

const MOBIL = oil("cat-mobil", "Mobil", "Super 3000 0W-20", "0W-20", 45, MANUAL);
const MOTUL = oil("cat-motul", "Motul", "5100 5W-30", "5W-30", 47, GUIDE);
const LUBRAX = oil("cat-lubrax", "Lubrax", "Top Turbo 5W-30", "5W-30", 42, GUIDE);

const GRADE_CONFLICT = {
  status: "conflicting_sources",
  conflicts: [
    {
      field: "viscosityGrades",
      values: [
        { value: "0W-20", sourcePublisher: MANUAL.sourcePublisher, sourceDocument: MANUAL.sourceDocument, sourcePage: MANUAL.sourcePage, sourceAuthority: 1 },
        { value: "5W-30", sourcePublisher: GUIDE.sourcePublisher, sourceDocument: GUIDE.sourceDocument, sourcePage: GUIDE.sourcePage, sourceAuthority: 4 },
      ],
    },
  ],
  viscosityGrades: ["0W-20", "5W-30"],
  classification: "",
  gradeSources: [
    { grade: "0W-20", ...MANUAL },
    { grade: "5W-30", ...GUIDE },
  ],
  options: [MOBIL, MOTUL, LUBRAX],
  filters: FILTERS,
  fillLiters: 4,
  fillKind: "em_servico",
  fillCondition: "with_filter",
  litersSource: MANUAL,
};

const VOLUME_CHOICES = [
  { liters: 4.3, fillCondition: "with_filter", source: MANUAL },
  { liters: 4, fillCondition: "unlabeled", source: { ...CATALOG, sourceAuthority: 5 } },
];

/** Drops the agreed volume's four fields, for the shapes that carry another volume or none. */
function withoutAgreedVolume(body: typeof GRADE_CONFLICT): Omit<typeof GRADE_CONFLICT, "fillLiters" | "fillKind" | "fillCondition" | "litersSource"> {
  const rest: Partial<typeof GRADE_CONFLICT> = { ...body };
  delete rest.fillLiters;
  delete rest.fillKind;
  delete rest.fillCondition;
  delete rest.litersSource;
  return rest as Omit<typeof GRADE_CONFLICT, "fillLiters" | "fillKind" | "fillCondition" | "litersSource">;
}

const VOLUME_CONFLICT = {
  status: "conflicting_sources",
  conflicts: [
    {
      field: "fillLiters",
      values: [
        { value: "4.3", sourcePublisher: MANUAL.sourcePublisher, sourceDocument: MANUAL.sourceDocument, sourcePage: MANUAL.sourcePage, sourceAuthority: 1 },
        { value: "4", sourcePublisher: CATALOG.sourcePublisher, sourceDocument: CATALOG.sourceDocument, sourcePage: CATALOG.sourcePage, sourceAuthority: 5 },
      ],
    },
  ],
  viscosityGrades: ["5W-30"],
  classification: "",
  gradeSources: [{ grade: "5W-30", ...MANUAL }],
  options: [{ ...MOTUL, gradeSource: MANUAL }],
  filters: FILTERS,
  volumeChoices: VOLUME_CHOICES,
};

afterEach(() => {
  useSelection.setState({ selectedConversationId: null });
  server.resetHandlers();
});

function radio(dialog: HTMLElement, name: RegExp | string) {
  return within(dialog).getByRole("radio", { name });
}

describe("a grade conflict", () => {
  it("opens with nothing chosen, every grade's cards previewed, no price box and sending off", async () => {
    const seq = await openQuoteDialog({ reads: [GRADE_CONFLICT] });

    expect(await within(seq.dialog).findByRole("status")).toHaveTextContent(GRADE_INTRO);
    const group = within(seq.dialog).getByRole("radiogroup", { name: "Viscosidade" });
    const radios = within(group).getAllByRole("radio");
    expect(radios).toHaveLength(2);
    for (const option of radios) expect(option).toHaveAttribute("aria-checked", "false");
    // Every stocked oil of either grade is shown, none selectable yet.
    for (const text of ["Mobil Super 3000 0W-20", "Motul 5100 5W-30", "Lubrax Top Turbo 5W-30"]) {
      expect(within(seq.dialog).getByText(text)).toBeInTheDocument();
    }
    expect(within(seq.dialog).queryByLabelText("Preço")).not.toBeInTheDocument();
    expect(within(seq.dialog).queryByLabelText("Mensagem")).not.toBeInTheDocument();
    expect(within(seq.dialog).getByRole("button", { name: "Enviar via WhatsApp" })).toBeDisabled();
  });

  // add-lubricant-oil-type, oil-quote "Conflict cards show the type the same way": the canvas's
  // `.pick-meta` "Sintético · R$ …"; the price alone for an untyped oil; no grade printed twice.
  it("previews each grade's cards with the oil type beside the price, or the price alone when untyped", async () => {
    const untypedLubrax = oil("cat-lubrax", "Lubrax", "Top Turbo 5W-30", "5W-30", 42, GUIDE, null);
    const seq = await openQuoteDialog({ reads: [{ ...GRADE_CONFLICT, options: [MOBIL, MOTUL, untypedLubrax] }] });

    await within(seq.dialog).findByRole("radiogroup", { name: "Viscosidade" });
    expect(within(seq.dialog).getAllByText(/^Sintético · R\$ /)).toHaveLength(2);
    // The untyped preview card shows a price caption with no type and no grade in the type's place.
    const lubraxCard = within(seq.dialog).getByText("Lubrax Top Turbo 5W-30").parentElement!;
    expect(lubraxCard.textContent).toMatch(/Lubrax Top Turbo 5W-30R\$ /);
    expect(lubraxCard.textContent).not.toContain("Sintético");
    expect(within(seq.dialog).queryByText(/5W-30 5W-30|0W-20 0W-20/)).not.toBeInTheDocument();

    await seq.user.click(radio(seq.dialog, /^5W-30/));
    const message = await waitFor(() => {
      const value = (within(seq.dialog).getByLabelText("Mensagem") as HTMLTextAreaElement).value;
      expect(value).toContain("Lubrax");
      return value;
    });
    expect(message).toContain("1️⃣ Motul 5100 5W-30\n➡️ Tipo: Sintético\n➡️ Valor: R$ ");
    expect(message).toMatch(/2️⃣ Lubrax Top Turbo 5W-30\n➡️ Valor: R\$ /);
  });

  it("cites each grade to the source that lists it, with its class, else its tier", async () => {
    const seq = await openQuoteDialog({ reads: [GRADE_CONFLICT] });

    expect(await within(seq.dialog).findByRole("radio", { name: `0W-20 — Viscosidade indicada por: ${MANUAL_CITE}` })).toBeInTheDocument();
    expect(radio(seq.dialog, `5W-30 — Viscosidade indicada por: ${GUIDE_CITE}`)).toBeInTheDocument();

    await seq.user.click(radio(seq.dialog, /^5W-30/));
    // The 5W-30 cards cite the guide, never the manual, which does not list 5W-30.
    const citations = await within(seq.dialog).findAllByText(`Viscosidade indicada por: ${GUIDE_CITE}`);
    expect(citations.length).toBeGreaterThanOrEqual(2);
    expect(within(seq.dialog).queryByText(`Viscosidade indicada por: ${MANUAL_CITE}`)).not.toBeInTheDocument();
    // A null URL shows no link.
    expect(within(seq.dialog).queryByRole("link")).not.toBeInTheDocument();
  });

  it("omits the suffix when the source has neither a class nor a tier", async () => {
    const seq = await openQuoteDialog({
      reads: [{ ...GRADE_CONFLICT, gradeSources: [{ grade: "0W-20", ...MANUAL }, { grade: "5W-30", ...CATALOG }] }],
    });

    expect(
      await within(seq.dialog).findByRole("radio", { name: "5W-30 — Viscosidade indicada por: CarroRac, Tabela de aplicação (Corolla 2019)" }),
    ).toBeInTheDocument();
  });

  it("makes the chosen grade's stocked oils the cards, drops the other's, and builds the message from them", async () => {
    const seq = await openQuoteDialog({ reads: [GRADE_CONFLICT] });

    await seq.user.click(await within(seq.dialog).findByRole("radio", { name: /^5W-30/ }));

    expect(radio(seq.dialog, /^5W-30/)).toHaveAttribute("aria-checked", "true");
    expect(radio(seq.dialog, /^0W-20/)).toHaveAttribute("aria-checked", "false");
    await waitFor(() => expect(within(seq.dialog).getAllByLabelText("Preço").map((box) => (box as HTMLInputElement).value)).toEqual(["265,00", "245,00"]));
    expect(within(seq.dialog).queryByText(/Mobil/)).not.toBeInTheDocument();
    const message = (within(seq.dialog).getByLabelText("Mensagem") as HTMLTextAreaElement).value;
    expect(message).toContain("Motul 5100 5W-30");
    expect(message).toContain("Lubrax Top Turbo 5W-30");
    expect(message).not.toContain("Mobil");
    expect(within(seq.dialog).getByRole("button", { name: "Enviar via WhatsApp" })).toBeEnabled();

    await seq.user.click(radio(seq.dialog, /^0W-20/));

    await waitFor(() => expect(within(seq.dialog).getAllByLabelText("Preço").map((box) => (box as HTMLInputElement).value)).toEqual(["257,00"]));
    const after = (within(seq.dialog).getByLabelText("Mensagem") as HTMLTextAreaElement).value;
    expect(after).toContain("Mobil Super 3000 0W-20");
    expect(after).not.toContain("Motul");
    // A web source's URL is the attendant's link to check it.
    expect(within(seq.dialog).getByRole("link", { name: MANUAL.sourceUrl })).toHaveAttribute("href", MANUAL.sourceUrl);
  });

  it("moves the choice with the arrow keys, shows the focus ring, and has 44 px targets", async () => {
    const seq = await openQuoteDialog({ reads: [GRADE_CONFLICT] });
    const first = await within(seq.dialog).findByRole("radio", { name: /^0W-20/ });
    // One tab stop for the group: the first option while nothing is chosen.
    expect(first).toHaveAttribute("tabindex", "0");
    expect(radio(seq.dialog, /^5W-30/)).toHaveAttribute("tabindex", "-1");

    for (let step = 0; step < 15 && document.activeElement !== first; step += 1) {
      await seq.user.tab();
    }
    expect(first).toHaveFocus();
    expect(getComputedStyle(first).minHeight).toBe("44px");
    // The ring is the theme's `MuiButtonBase` `.Mui-focusVisible` outline. jsdom has no
    // `:focus-visible`, so MUI never sets the class here: the option is pinned to be a ButtonBase,
    // and the theme to draw the outline (the browser check is in the visual QA notes).
    expect(first).toHaveClass("MuiButtonBase-root");
    const root = createAppTheme("yellow-cta").components?.MuiButtonBase?.styleOverrides?.root as (props: { theme: Theme }) => Record<string, unknown>;
    expect(root({ theme: createAppTheme("yellow-cta") })["&.Mui-focusVisible"]).toMatchObject({ outline: expect.stringContaining("solid") });

    await seq.user.keyboard("{ArrowDown}");

    const second = radio(seq.dialog, /^5W-30/);
    expect(second).toHaveFocus();
    expect(second).toHaveAttribute("aria-checked", "true");
    expect(second).toHaveAttribute("tabindex", "0");
    expect(first).toHaveAttribute("aria-checked", "false");

    await seq.user.keyboard("{ArrowDown}");
    expect(radio(seq.dialog, /^0W-20/)).toHaveAttribute("aria-checked", "true");
  });
});

describe("a volume conflict", () => {
  it("lists each source's volume highest authority first, reads escolha o volume, then prices from the choice", async () => {
    const seq = await openQuoteDialog({ reads: [VOLUME_CONFLICT] });

    expect(await within(seq.dialog).findByRole("status")).toHaveTextContent(VOLUME_INTRO);
    const choices = within(within(seq.dialog).getByRole("radiogroup", { name: "Volume de óleo da troca" })).getAllByRole("radio");
    expect(choices.map((choice) => choice.textContent)).toEqual([
      `4,3 L — ${MANUAL_CITE}`,
      "4,0 L — CarroRac, Tabela de aplicação (Corolla 2019) — catálogo de reposição",
    ]);
    for (const choice of choices) expect(choice).toHaveAttribute("aria-checked", "false");
    expect(within(seq.dialog).getByText("Preço: escolha o volume")).toBeInTheDocument();
    expect(within(seq.dialog).queryByLabelText("Preço")).not.toBeInTheDocument();
    expect(within(seq.dialog).getByRole("button", { name: "Enviar via WhatsApp" })).toBeDisabled();

    await seq.user.click(choices[0]!);

    // 47,00 × 4,3 L + 77,00.
    await waitFor(() => expect(within(seq.dialog).getByLabelText("Preço")).toHaveValue("279,10"));
    const flag = `Volume indicado por: ${MANUAL_CITE}: 4,3 L`;
    expect(within(seq.dialog).getByText((_text, element) => element?.tagName === "SPAN" && (element.textContent ?? "").startsWith(flag))).toBeInTheDocument();
    expect(within(seq.dialog).getByRole("button", { name: "Enviar via WhatsApp" })).toBeEnabled();
  });
});

describe("a grade-and-volume conflict", () => {
  it("assembles the message only once a grade and a volume are both chosen", async () => {
    const seq = await openQuoteDialog({
      reads: [{ ...withoutAgreedVolume(GRADE_CONFLICT), volumeChoices: VOLUME_CHOICES }],
    });

    expect(await within(seq.dialog).findByRole("radiogroup", { name: VOLUME_ALSO })).toBeInTheDocument();
    await seq.user.click(radio(seq.dialog, /^5W-30/));
    expect(within(seq.dialog).getAllByText("Preço: escolha o volume")).toHaveLength(2);
    expect(within(seq.dialog).queryByLabelText("Mensagem")).not.toBeInTheDocument();
    expect(within(seq.dialog).getByRole("button", { name: "Enviar via WhatsApp" })).toBeDisabled();

    await seq.user.click(radio(seq.dialog, /^4,3 L/));

    expect(await within(seq.dialog).findByLabelText("Mensagem")).toBeInTheDocument();
    expect(within(seq.dialog).getByRole("button", { name: "Enviar via WhatsApp" })).toBeEnabled();
  });
});

describe("a grade conflict with no stated volume", () => {
  it("asks for the volume as the missing volume does, and prices the chosen grade from it", async () => {
    const seq = await openQuoteDialog({ reads: [withoutAgreedVolume(GRADE_CONFLICT)] });

    const input = await within(seq.dialog).findByLabelText("Volume de óleo da troca (litros)");
    await seq.user.click(radio(seq.dialog, /^5W-30/));
    // No source stated a volume, so there is none to choose: the card asks for one to be typed.
    expect(within(seq.dialog).getAllByText("Preço: informe o volume")).toHaveLength(2);
    expect(within(seq.dialog).queryByText(/escolha o volume/)).not.toBeInTheDocument();
    await seq.user.type(input, "4");
    await seq.user.click(within(seq.dialog).getByRole("button", { name: "Usar este volume" }));
    await seq.user.click(within(await screen.findByRole("dialog", { name: /Guardar 4 L/ })).getByRole("button", { name: "Só neste orçamento" }));

    await waitFor(() => expect(within(seq.dialog).getAllByLabelText("Preço").map((box) => (box as HTMLInputElement).value)).toEqual(["265,00", "245,00"]));
    expect(within(seq.dialog).getAllByText("Volume informado pelo atendente: 4 L")).toHaveLength(2);
  });

  // Review of #198: a kept attendant volume prices the conflict directly, flagged, with no field.
  it("prices the chosen grade from a kept attendant volume, with who and when", async () => {
    const seq = await openQuoteDialog({
      reads: [{ ...withoutAgreedVolume(GRADE_CONFLICT), attendantFill: { liters: 4, recordedBy: "Marina", recordedAt: "2026-09-20T15:00:00.000Z" } }],
    });

    await seq.user.click(await within(seq.dialog).findByRole("radio", { name: /^5W-30/ }));

    await waitFor(() => expect(within(seq.dialog).getAllByLabelText("Preço").map((box) => (box as HTMLInputElement).value)).toEqual(["265,00", "245,00"]));
    expect(within(seq.dialog).getAllByText("Volume informado por Marina em 20/09/2026: 4 L")).toHaveLength(2);
    expect(within(seq.dialog).queryByLabelText("Volume de óleo da troca (litros)")).not.toBeInTheDocument();
  });
});

/**
 * Review of #198, finding 2: an edited message names the oils and prices it was edited for, so
 * when the card set or its volume changes it is rebuilt, and prices edited on cards that left the
 * set are dropped. A message naming the wrong oils must never reach the customer.
 */
describe("a conflict whose choice changes after an edit", () => {
  it("rebuilds an edited message when the grade changes", async () => {
    const seq = await openQuoteDialog({ reads: [GRADE_CONFLICT] });
    await seq.user.click(await within(seq.dialog).findByRole("radio", { name: /^5W-30/ }));
    const message = await within(seq.dialog).findByLabelText("Mensagem");
    await seq.user.type(message, " editado à mão");
    expect((message as HTMLTextAreaElement).value).toContain("editado à mão");

    await seq.user.click(radio(seq.dialog, /^0W-20/));

    const rebuilt = (within(seq.dialog).getByLabelText("Mensagem") as HTMLTextAreaElement).value;
    expect(rebuilt).not.toContain("editado à mão");
    expect(rebuilt).toContain("Mobil Super 3000 0W-20");
    expect(rebuilt).not.toContain("Motul");
  });

  it("rebuilds an edited message and re-prices when the chosen volume changes", async () => {
    const seq = await openQuoteDialog({ reads: [VOLUME_CONFLICT] });
    await seq.user.click(await within(seq.dialog).findByRole("radio", { name: /^4,3 L/ }));
    await waitFor(() => expect(within(seq.dialog).getByLabelText("Preço")).toHaveValue("279,10"));
    const message = within(seq.dialog).getByLabelText("Mensagem");
    await seq.user.type(message, " editado à mão");

    await seq.user.click(radio(seq.dialog, /^4,0 L/));

    // 47,00 × 4 L + 77,00, and the message rebuilt from it.
    await waitFor(() => expect(within(seq.dialog).getByLabelText("Preço")).toHaveValue("265,00"));
    const rebuilt = (within(seq.dialog).getByLabelText("Mensagem") as HTMLTextAreaElement).value;
    expect(rebuilt).not.toContain("editado à mão");
    expect(rebuilt).toContain("R$ 265,00");
  });

  it("drops a price edited on a card that left the set", async () => {
    const seq = await openQuoteDialog({ reads: [GRADE_CONFLICT] });
    await seq.user.click(await within(seq.dialog).findByRole("radio", { name: /^0W-20/ }));
    const price = await within(seq.dialog).findByLabelText("Preço");
    await waitFor(() => expect(price).toHaveValue("257,00"));
    await seq.user.clear(price);
    await seq.user.type(price, "999,00");

    await seq.user.click(radio(seq.dialog, /^5W-30/));
    await seq.user.click(radio(seq.dialog, /^0W-20/));

    await waitFor(() => expect(within(seq.dialog).getByLabelText("Preço")).toHaveValue("257,00"));
  });
});

describe("an agreed volume in a grade conflict", () => {
  it("counts the sources consulted and cites the source of the litres", async () => {
    const seq = await openQuoteDialog({ reads: [GRADE_CONFLICT] });

    expect(await within(seq.dialog).findByText(`Volume de troca 4 L — as duas fontes concordam (${MANUAL_CITE})`)).toBeInTheDocument();
  });
});

/** Review of #198, finding 3: D17's held newer row covers a conflict with its cards. */
describe("a conflict whose newer data arrives", () => {
  const PENDING = { ...GRADE_CONFLICT.filters, source: "pending", stopped: false };
  const OPTIONS = {
    status: "options",
    viscosityGrades: ["5W-30"],
    viscosity: "5W-30",
    classification: "",
    fillLiters: 4,
    fillKind: "em_servico",
    fillCondition: "with_filter",
    sourcePublisher: GUIDE.sourcePublisher,
    sourceDocument: GUIDE.sourceDocument,
    sourcePage: GUIDE.sourcePage,
    gradeSources: [{ grade: "5W-30", sourcePublisher: GUIDE.sourcePublisher, sourceDocument: GUIDE.sourceDocument, sourcePage: GUIDE.sourcePage, sourceAuthority: 4, sourceUrl: null }],
    litersSource: { sourcePublisher: GUIDE.sourcePublisher, sourceDocument: GUIDE.sourceDocument, sourcePage: GUIDE.sourcePage, sourceAuthority: 4, sourceUrl: null },
    consultedAt: "2026-09-27T12:00:00.000Z",
    options: [MOTUL],
    filters: FILTERS,
  };

  it("swaps silently to the newer row when nothing was edited", { timeout: 20_000 }, async () => {
    const seq = await openQuoteDialog({ reads: [{ ...GRADE_CONFLICT, filters: PENDING }, OPTIONS] });
    await seq.user.click(await within(seq.dialog).findByRole("radio", { name: /^5W-30/ }));

    await waitFor(() => expect(within(seq.dialog).getByRole("status")).toHaveTextContent("Dados consultados em 27/09/2026."), { timeout: 6_000 });
    expect(within(seq.dialog).queryByText(/Chegaram dados novos/)).not.toBeInTheDocument();
  });

  it("holds an edited conflict behind Chegaram dados novos until Atualizar", { timeout: 20_000 }, async () => {
    // The filters still pending keep the dialog polling; the next read is a verified row.
    const held = await openQuoteDialog({ reads: [{ ...GRADE_CONFLICT, filters: PENDING }, OPTIONS] });
    await held.user.click(await within(held.dialog).findByRole("radio", { name: /^5W-30/ }));
    await held.user.type(await within(held.dialog).findByLabelText("Mensagem"), " editado");

    await waitFor(() => expect(within(held.dialog).getByRole("status")).toHaveTextContent("Chegaram dados novos de 27/09/2026."), { timeout: 6_000 });
    expect((within(held.dialog).getByLabelText("Mensagem") as HTMLTextAreaElement).value).toContain("editado");
    await held.user.click(within(held.dialog).getByRole("button", { name: "Atualizar" }));
    expect(within(held.dialog).getByRole("status")).toHaveTextContent("Dados consultados em 27/09/2026.");
    expect((within(held.dialog).getByLabelText("Mensagem") as HTMLTextAreaElement).value).not.toContain("editado");
  });
});

describe("a conflict with no stocked grade", () => {
  it("shows the no-compatible-brand copy with each grade's source, and no choice", async () => {
    const seq = await openQuoteDialog({ reads: [{ ...GRADE_CONFLICT, options: [] }] });

    expect(await within(seq.dialog).findByRole("status")).toHaveTextContent("Nenhuma marca do catálogo interno é compatível. Nenhuma opção é exibida.");
    expect(within(seq.dialog).getByText(`0W-20 — Viscosidade indicada por: ${MANUAL_CITE}`)).toBeInTheDocument();
    expect(within(seq.dialog).getByText(`5W-30 — Viscosidade indicada por: ${GUIDE_CITE}`)).toBeInTheDocument();
    expect(within(seq.dialog).queryByRole("radiogroup")).not.toBeInTheDocument();
    expect(within(seq.dialog).queryByRole("button", { name: "Enviar via WhatsApp" })).not.toBeInTheDocument();
  });
});

describe("a conflict stored in the old shape", () => {
  it("keeps today's list and offers no cards and no choice", async () => {
    const seq = await openQuoteDialog({ reads: [{ status: "conflicting_sources", conflicts: GRADE_CONFLICT.conflicts }] });

    expect(await within(seq.dialog).findByText(/Nenhuma opção é exibida até que a divergência seja resolvida/)).toBeInTheDocument();
    expect(within(seq.dialog).queryByRole("radiogroup")).not.toBeInTheDocument();
    expect(within(seq.dialog).queryByLabelText("Preço")).not.toBeInTheDocument();
  });
});

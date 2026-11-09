/**
 * Test design (testing-strategy)
 *
 * Setup: ConversasPage in AppProviders; MSW. Query retry: false.
 *
 * Oracle: oil-quote conversas delta — Montar orçamento scoped to the
 * clicked vehicle; panel states (background-oil-research D15/D17: a cached
 * row opens on its options with "Dados consultados em", no reuse prompt;
 * the research, no-source, incomplete-identity and failure sentences; empty
 * Portuguese; cards); Tecfil filter slots priced into each card (design
 * D11); confirm POSTs /quotes once (not /messages) and lands text in the
 * composer.
 *
 * Axes
 *   A1 vehicle clicked — A vs B
 *   A2 options status — researching / options (+ refresh / newerAttempt) / empty / no_spec (reason) / error
 *   A3 confirm — single vs double-click
 *   A4 filter slot — one candidate / two candidates / unresolved
 *   A5 filters.source — cached / pending / unavailable / unmatched
 *   A6 card price — untouched vs attendant-edited
 *
 * Outputs
 *   O1 dialog title for that vehicle; quote-options path
 *   O2 the row's date and Buscar novamente; no reuse buttons
 *   O3 empty / no-source / incomplete-identity / failure copy; no cards
 *   O4 the research sentence: the range, or the pause's reason
 *   O5 POST /quotes once; composer has text; no POST /messages
 *   O6 card label is brand + description (not the removed productLine)
 *   O7 pre-filled composite price + pt-BR breakdown caption
 *   O8 chooser rendered; chosen type recomputes untouched prices only
 *   O9 Portuguese warning per unresolved type, no invented number
 *   O10 POST lines carry the chosen filter items
 *
 * Sampled-cell
 *   open B                  | A1 B               | O1 veh-b | veh-a path
 *   cached options          | A2 options         | O2 | a reuse prompt first
 *   empty catalog           | A2 empty           | O3 | invented card
 *   no source / incomplete  | A2 no_spec         | O3 | "no source" for an unresearched car
 *   failed research         | A2 error           | O3 | Motul blamed
 *   researching / refresh   | A2 researching     | O4 | a range while paused
 *   newer attempt           | A2 options         | O4 | silence about the newer search
 *   filters pending         | A5 pending         | O9 | a filter price invented
 *   confirm once            | A3 double          | O5 O6 | two POSTs / blank card label
 *   typed price kept        | price hydrate F    | POST 150 | catalog 89.9
 *   both slots single       | A4 one             | O7 | oil-only price
 *   oil slot two candidates | A4 two             | O7 O8 | oil filter silently priced
 *   choose then recompute   | A4 two A6 untouched| O8 | edited price overwritten
 *   choose after editing    | A4 two A6 edited   | O8 | edited price overwritten
 *   warning variants        | A4 unresolved A5   | O9 | number invented
 *   confirm with filters    | A4 one A3 single   | O10 | oil line only
 *
 * Decision map (conversas/quote.tsx OilQuoteDialog)
 *   D2 status options       T: confirm it; F: empty/error
 *   D3 persist.isPending    T: double-click it; F: (disabled)
 *   quoteStillResolving     T: the polling its; F: the settled ones
 *   priceTouched.has(id) T: edited-price it; F: recompute its
 *   slot.candidates.length < 2 T: auto-priced it; F: chooser it
 *   filters.source pending/unavailable/unmatched T: source notice its; F: per-type its
 *
 * Out of scope: Motul network; the API-side Tecfil lookup; Playwright. The ticking
 * counter and the research block's lines, the a11y region and the new-data hold are
 * `ConversasPage.quote-research.test.tsx` (tasks 5.2, 5.3).
 */
import { QueryClient } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import {
  catalogItemFixture,
  lubricantDetailFixture,
  oilQuoteFixture,
  type ConversationSummary,
  type QuoteFilterCard,
  type QuoteFilters,
  type Vehicle,
} from "@select-lub/shared-types";
import { AppProviders } from "./AppProviders.js";
import { ConversasPage } from "./ConversasPage.js";
import { useSelection } from "./selectionStore.js";
import { server } from "../test/msw/server.js";

/** One offerable card as the API returns it: catalog item plus its lubricant-detail. */
const quoteCard = { ...catalogItemFixture, lubricant: lubricantDetailFixture };

/**
 * The oil card the filter cases price against: 50,00 PER LITRE.
 *
 * With {@link FILL_LITERS} that is a 200,00 oil subtotal, deliberately far from both the
 * unit price and either filter price — if the dialog ever forgot to multiply, or multiplied
 * by the wrong number, no coincidence would hide it.
 */
const oilCard = { ...quoteCard, price: 50 };

/** Verified service-fill volume every `options` body in this file reports. */
const FILL_LITERS = 4;

const timestamps = { createdAt: "2026-08-21T10:00:00.000Z", updatedAt: "2026-08-26T12:00:00.000Z" };

/** Builds one offerable filter card (catalog item plus the filter-detail that matched). */
function filterCard(
  id: string,
  brand: string,
  filterType: "OLEO" | "COMBUSTIVEL",
  partNumber: string,
  price: number,
): QuoteFilterCard {
  return {
    id,
    brand,
    description: filterType === "OLEO" ? "Filtro de óleo" : "Filtro de combustível",
    price,
    stock: 0,
    active: true,
    ...timestamps,
    filter: { catalogItemId: id, filterType, partNumber },
  };
}

const tecfilOil = filterCard("cat-tecfil-pel108", "Tecfil", "OLEO", "PEL108", 32);
const authomixOil = filterCard("cat-authomix-fol0108", "Authomix", "OLEO", "FOL0108", 28);
const tecfilFuel = filterCard("cat-tecfil-gi50-7", "Tecfil", "COMBUSTIVEL", "GI50/7", 45);

/** A `filters` block with both slots resolved, overridable per case. */
function filtersBlock(overrides: Partial<QuoteFilters> = {}): QuoteFilters {
  return {
    source: "cached",
    consultedAt: "2026-09-03T18:00:00.000Z",
    application: { manufacturer: "PEUGEOT", vehicle: "207", engine: "1.4 8V" },
    oil: { status: "matched", candidates: [tecfilOil] },
    fuel: { status: "matched", candidates: [tecfilFuel] },
    ...overrides,
  };
}

/** The manual every `options` body in this file cites unless a case says otherwise. */
const MANUAL = {
  sourcePublisher: "Peugeot do Brasil",
  sourceDocument: "Manual do Proprietário 207 (2011)",
  sourcePage: "Seção 8 — Capacidades",
  sourceAuthority: 1,
  sourceUrl: null as string | null,
};

/**
 * An `options` body carrying the given cards and filter block, with `source` cited as the
 * primary source, for every grade, and for the liters — one provenance, as the API sends it
 * when everything came from one document.
 */
function optionsBody(
  cards: unknown[],
  filters: QuoteFilters,
  source = MANUAL,
  fill: { fillKind: "em_servico" | "unlabeled"; fillCondition: "with_filter" | "unlabeled" } = { fillKind: "em_servico", fillCondition: "with_filter" },
) {
  return {
    status: "options",
    viscosityGrades: ["5W-40"],
    viscosity: "5W-40",
    classification: "API SN",
    fillLiters: FILL_LITERS,
    ...fill,
    ...source,
    gradeSources: [{ grade: "5W-40", ...source }],
    litersSource: source,
    consultedAt: "2026-01-12T15:00:00.000Z",
    options: cards,
    filters,
  };
}

/** A research under way (D15): requested two minutes ago, estimated one to three minutes. */
const TIMING = {
  requestedAt: "2026-09-26T17:00:00.000Z",
  now: "2026-09-26T17:02:00.000Z",
  expectedMinutes: { min: 1, max: 3 },
  queuePosition: 0,
  path: "search",
  paused: null,
};

/** The `researching` body: no row to show yet. */
const RESEARCHING = { status: "researching", ...TIMING };

function summary(
  partial: Partial<ConversationSummary> & Pick<ConversationSummary, "id" | "phone">,
): ConversationSummary {
  return {
    contactLabel: partial.phone,
    lastSnippet: "oi",
    lastMessageAt: "2026-08-26T12:00:00.000Z",
    tags: [],
    sourceType: "UNKNOWN",
    unanswered: false,
    // Inbound-only default; `partial` still overrides it for a case that wants
    // a further stage.
    pipelineStage: "novosContatos",
    ...partial,
  };
}

const vehA: Vehicle = {
  id: "veh-a",
  customerId: "cus-1",
  omieId: null,
  plate: "ABC1D23",
  make: "Toyota",
  model: "Corolla",
  version: "1.8 XEi",
  year: 2019,
  odometerKm: 42300,
  origin: "crm",
  plateSourcedKeys: [],
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

const vehB: Vehicle = {
  ...vehA,
  id: "veh-b",
  plate: "XYZ9F88",
  make: "Honda",
  model: "Civic",
  version: "EXL",
  year: 2021,
};

function renderConversas() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <MemoryRouter>
      <AppProviders queryClient={queryClient}>
        <ConversasPage />
      </AppProviders>
    </MemoryRouter>,
  );
}

async function openInbox(options: { quote?: unknown; quoteById?: Record<string, unknown> } = {}) {
  const conv = summary({ id: "conv-1", phone: "11988887777", contactLabel: "Roberto" });
  const optionHits: string[] = [];
  server.use(
    http.get("*/api/conversations", () => HttpResponse.json([conv])),
    http.get("*/api/conversations/:id/customer", () =>
      HttpResponse.json({
        customer: {
          id: "cus-1",
          name: "Roberto",
          omieId: null,
          taxId: null,
          unitId: "unit-1",
          origin: "crm",
          status: "active",
          givenName: null,
          familyName: null,
          mergedInto: null,
          street: null,
          streetNumber: null,
          neighborhood: null,
          complement: null,
          city: null,
          state: null,
          postalCode: null,
          country: null,
          phones: [],
          emails: [],
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z",
        },
        pendings: [],
      }),
    ),
    http.get("*/api/conversations/:id/vehicles", () =>
      HttpResponse.json({ customerId: "cus-1", vehicles: [vehA, vehB] }),
    ),
    http.get("*/api/vehicles/:id/quote-options", ({ params }) => {
      const id = String(params.id);
      optionHits.push(id);
      const body = options.quoteById?.[id] ?? options.quote ?? { status: "no_spec", reason: "no_source" };
      return HttpResponse.json(body);
    }),
  );
  renderConversas();
  await userEvent.setup().click(await screen.findByText("Roberto"));
  return { optionHits };
}

/** Opens the quote dialog on the first vehicle and returns the userEvent session. */
async function openQuote(quote: unknown) {
  await openInbox({ quote });
  const user = userEvent.setup();
  await user.click((await screen.findAllByRole("button", { name: "Montar orçamento" }))[0]!);
  return user;
}

afterEach(() => {
  useSelection.setState({ selectedConversationId: null });
  server.resetHandlers();
});

describe("Conversas oil quote", () => {
  it("shows Portuguese loading copy while quote-options are in flight", async () => {
    const conv = summary({ id: "conv-1", phone: "11988887777", contactLabel: "Roberto" });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.get("*/api/conversations", () => HttpResponse.json([conv])),
      http.get("*/api/conversations/:id/vehicles", () =>
        HttpResponse.json({ customerId: "cus-1", vehicles: [vehA] }),
      ),
      http.get("*/api/vehicles/:id/quote-options", async () => {
        await gate;
        return HttpResponse.json({ status: "no_spec", reason: "no_source" });
      }),
    );
    renderConversas();
    const user = userEvent.setup();
    await user.click(await screen.findByText("Roberto"));
    await user.click(await screen.findByRole("button", { name: "Montar orçamento" }));

    // D17: a read that never calls a provider says so; no provider is named while it loads.
    expect(screen.getByText("Carregando opções de orçamento…")).toBeInTheDocument();
    expect(screen.queryByText(/Motul|Tecfil/)).not.toBeInTheDocument();
    release();
    expect(await screen.findByText(/Não encontramos o óleo indicado/)).toBeInTheDocument();
  });

  it("does not fetch quote-options until Montar orçamento is clicked", async () => {
    const { optionHits } = await openInbox();
    await screen.findAllByRole("button", { name: "Montar orçamento" });
    expect(optionHits).toEqual([]);
  });

  it("opens the quote scoped to the clicked vehicle", async () => {
    const { optionHits } = await openInbox({ quote: { status: "no_spec", reason: "no_source" } });
    const user = userEvent.setup();
    const montar = await screen.findAllByRole("button", { name: "Montar orçamento" });
    await user.click(montar[1]!);

    expect(await screen.findByText(/Montar orçamento — Honda Civic 2021/)).toBeInTheDocument();
    await waitFor(() => {
      expect(optionHits).toEqual(["veh-b"]);
    });
  });

  // background-oil-research D15: no reuse prompt — a cached row opens on its options at once,
  // with its date and "Buscar novamente".
  it("opens a cached row on its options with its date and Buscar novamente, and no reuse prompt", async () => {
    await openQuote(optionsBody([quoteCard], filtersBlock()));

    expect(await screen.findByText("Dados consultados em 12/01/2026.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Buscar novamente" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Usar dados/ })).not.toBeInTheDocument();
  });

  it("shows Portuguese empty copy when no catalog item matches", async () => {
    await openQuote({
      status: "empty",
      viscosityGrades: ["5W-30"],
      viscosity: "5W-30",
      classification: "API SP",
      consultedAt: "2026-01-12T15:00:00.000Z",
    });

    expect(
      await screen.findByText("Nenhuma marca do catálogo interno é compatível. Nenhuma opção é exibida."),
    ).toBeInTheDocument();
    expect(screen.getByText("Dados consultados em 12/01/2026.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Motul/ })).not.toBeInTheDocument();
  });

  it("says no trusted source was found, naming no provider", async () => {
    await openQuote({ status: "no_spec", reason: "no_source" });

    expect(
      await screen.findByText(
        "Não encontramos o óleo indicado para este veículo em um manual ou catálogo confiável, por isso nenhuma opção é exibida.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Buscar novamente" })).toBeInTheDocument();
  });

  it("names the missing fields of an incomplete identity, and offers no refetch", async () => {
    await openQuote({ status: "no_spec", reason: "incomplete_identity", missingFields: ["make", "version"] });

    expect(
      await screen.findByText("Para pesquisar o lubrificante, complete os dados do veículo: marca e versão."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Buscar novamente" })).not.toBeInTheDocument();
  });

  it("says a failed research failed, without blaming Motul", async () => {
    await openQuote({ status: "error" });

    expect(await screen.findByText("Não conseguimos concluir a pesquisa de lubrificante deste veículo.")).toBeInTheDocument();
    expect(screen.queryByText(/Motul/)).not.toBeInTheDocument();
  });

  it.each([
    [null, "Procurando lubrificante compatível — pode levar entre 1 e 3 minutos."],
    [{ reason: "stopped" }, "A pesquisa automática não está rodando agora; o pedido fica na fila."],
    [{ reason: "retrying", retryAt: "2026-09-26T17:05:00.000Z" }, "A última tentativa falhou; vamos tentar de novo às 14:05."],
  ])("says the research is under way (paused %j)", async (paused, sentence) => {
    await openQuote({ ...RESEARCHING, paused });

    expect(await screen.findByText(sentence)).toBeInTheDocument();
    expect(screen.queryByLabelText("Preço")).not.toBeInTheDocument();
  });

  it.each([
    [{ outcome: "no_spec", finishedAt: "2026-09-25T12:00:00.000Z" }, "A nova busca de 25/09/2026 não encontrou uma fonte confiável; mostramos os dados consultados em 12/01/2026."],
    [{ outcome: "failed", finishedAt: "2026-09-25T12:00:00.000Z" }, "Não conseguimos concluir a nova busca de 25/09/2026; mostramos os dados consultados em 12/01/2026."],
  ])("notes a newer attempt %j beside the row's options", async (newerAttempt, sentence) => {
    await openQuote({ ...optionsBody([oilCard], filtersBlock()), newerAttempt });

    expect(await screen.findByText(sentence)).toBeInTheDocument();
  });

  it.each([
    [null, "Buscando dados novos — pode levar entre 1 e 3 minutos."],
    [{ reason: "stopped" }, "Nova busca na fila, mas a pesquisa automática não está rodando agora."],
    [{ reason: "retrying", retryAt: "2026-09-26T17:05:00.000Z" }, "A nova busca falhou; vamos tentar de novo às 14:05."],
  ])("says a new search is under way over the row's options (paused %j)", async (paused, sentence) => {
    await openQuote({ ...optionsBody([oilCard], filtersBlock()), refresh: { ...TIMING, paused } });

    expect(await screen.findByText(sentence)).toBeInTheDocument();
    expect(screen.getByLabelText("Preço")).toBeInTheDocument();
  });

  it("persists one quote on double-click and lands the text in the composer", async () => {
    const posts: unknown[] = [];
    const messages: unknown[] = [];
    server.use(
      http.post("*/api/vehicles/:id/quotes", async ({ request }) => {
        posts.push(await request.json());
        return HttpResponse.json(
          { ...oilQuoteFixture, generatedMessageText: "Nesse valor já está incluso 👇" },
          { status: 201 },
        );
      }),
      http.post("*/api/conversations/:id/messages", async ({ request }) => {
        messages.push(await request.json());
        return HttpResponse.json({}, { status: 201 });
      }),
    );
    const user = await openQuote(optionsBody([quoteCard], filtersBlock()));
    expect(await screen.findByRole("button", { name: /Motul 8100 X-cess/ })).toBeInTheDocument();
    const send = await screen.findByRole("button", { name: "Enviar via WhatsApp" });
    await user.click(send);
    await user.click(send);

    await waitFor(() => {
      expect(posts).toHaveLength(1);
    });
    expect(messages).toHaveLength(0);
    const composer = screen.getByPlaceholderText("Digite uma mensagem");
    expect(composer).toHaveValue("Nesse valor já está incluso 👇");
  });

  // add-lubricant-oil-type — oil-quote "Cards carry editable prices and assemble the message live".
  describe("the oil type on the card and in the message", () => {
    const motul = { ...oilCard, id: "cat-motul", description: "8100 Eco-nergy", lubricant: { ...lubricantDetailFixture, catalogItemId: "cat-motul", viscosity: "5W-30", oilType: "SINTETICO" as const } };
    const ipiranga = { ...oilCard, id: "cat-ipiranga", brand: "Ipiranga", description: "F1 Master", lubricant: { ...lubricantDetailFixture, catalogItemId: "cat-ipiranga", viscosity: "5W-30", oilType: null } };
    const message = () => (within(screen.getByRole("dialog")).getByLabelText("Mensagem") as HTMLTextAreaElement).value;
    /** An `options` body whose cited grade is 5W-30, the grade these cards carry. */
    const body5w30 = (cards: unknown[]) => ({
      ...optionsBody(cards, filtersBlock()),
      viscosityGrades: ["5W-30"],
      viscosity: "5W-30",
      gradeSources: [{ grade: "5W-30", ...MANUAL }],
    });

    it("titles a typed card with brand, description and viscosity, shows Sintético, and writes Tipo: Sintético", async () => {
      await openQuote(body5w30([motul]));

      const card = (await screen.findByRole("button", { name: "✓ Motul 8100 Eco-nergy 5W-30" })).closest(".MuiPaper-root") as HTMLElement;
      expect(within(card).getByText("Sintético")).toBeInTheDocument();
      await waitFor(() => expect(message()).toContain("1️⃣ Motul 8100 Eco-nergy 5W-30\n➡️ Tipo: Sintético\n➡️ Valor: R$ 277,00"));
    });

    it.each([
      ["SEMISSINTETICO", "Semissintético"],
      ["MINERAL", "Mineral"],
    ] as const)("labels a %s card and option %s", async (oilType, label) => {
      const typed = { ...motul, lubricant: { ...motul.lubricant, oilType } };
      await openQuote(body5w30([typed]));

      expect(await screen.findByText(label)).toBeInTheDocument();
      await waitFor(() => expect(message()).toContain(`➡️ Tipo: ${label}\n`));
    });

    it("shows no type for an untyped card and omits its Tipo line, keeping Valor", async () => {
      await openQuote(body5w30([motul, ipiranga]));

      const card = (await screen.findByRole("button", { name: "✓ Ipiranga F1 Master 5W-30" })).closest(".MuiPaper-root") as HTMLElement;
      for (const label of ["Sintético", "Semissintético", "Mineral"]) expect(within(card).queryByText(label)).not.toBeInTheDocument();
      // The grade is in the title only — never standing in for the type beside the price.
      expect(within(card).getAllByText(/5W-30/).map((node) => node.textContent)).not.toContain("5W-30");
      await waitFor(() => expect(message()).toContain("2️⃣ Ipiranga F1 Master 5W-30\n➡️ Valor: R$ 277,00"));
      expect(message().match(/Tipo/g)).toHaveLength(1);
    });

    it("does not repeat a grade the description already names", async () => {
      const mobil = { ...motul, id: "cat-mobil", brand: "Mobil", description: "Super 3000 5W-30", lubricant: { ...motul.lubricant, catalogItemId: "cat-mobil" } };
      await openQuote(body5w30([mobil]));

      expect(await screen.findByRole("button", { name: "✓ Mobil Super 3000 5W-30" })).toBeInTheDocument();
      await waitFor(() => expect(message()).toContain("1️⃣ Mobil Super 3000 5W-30\n"));
      expect(message()).not.toContain("5W-30 5W-30");
    });
  });

  it("keeps an attendant-typed price on the persisted quote line", async () => {
    const posts: Array<{ lines?: Array<{ price?: number }> }> = [];
    server.use(
      http.post("*/api/vehicles/:id/quotes", async ({ request }) => {
        posts.push((await request.json()) as { lines?: Array<{ price?: number }> });
        return HttpResponse.json(oilQuoteFixture, { status: 201 });
      }),
    );
    const user = await openQuote(optionsBody([quoteCard], filtersBlock()));
    const price = await screen.findByLabelText("Preço");
    await user.clear(price);
    await user.type(price, "150,00");
    await user.click(await screen.findByRole("button", { name: "Enviar via WhatsApp" }));

    await waitFor(() => {
      expect(posts[0]?.lines?.[0]?.price).toBe(150);
    });
  });

  it("prices a single candidate per type into the card and captions the breakdown", async () => {
    await openQuote(optionsBody([oilCard], filtersBlock()));

    await waitFor(async () => {
      expect(await screen.findByLabelText("Preço")).toHaveValue("277,00");
    });
    expect(
      screen.getByText(
        "Óleo R$ 50,00/L × 4 L (com filtro) = R$ 200,00 + filtro de óleo R$ 32,00 + filtro de combustível R$ 45,00 — Tecfil: PEUGEOT 207 1.4 8V",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Authomix/ })).not.toBeInTheDocument();
  });

  // D5 (owner, 2026-09-26): a single unlabelled volume prices, and the card says so.
  it("captions an unlabelled volume as such", async () => {
    await openQuote(optionsBody([oilCard], filtersBlock(), MANUAL, { fillKind: "unlabeled", fillCondition: "unlabeled" }));

    expect(await screen.findByText(/^Óleo R\$ 50,00\/L × 4 L \(volume sem legenda\) = R\$ 200,00/)).toBeInTheDocument();
  });

  it("shows a chooser for two candidates and excludes that type until one is chosen", async () => {
    await openQuote(
      optionsBody(
        [oilCard],
        filtersBlock({ oil: { status: "matched", candidates: [tecfilOil, authomixOil] } }),
      ),
    );

    await waitFor(async () => {
      expect(await screen.findByLabelText("Preço")).toHaveValue("245,00");
    });
    expect(screen.getByRole("button", { name: /Tecfil.*PEL108/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Authomix.*FOL0108/ })).toBeInTheDocument();
    expect(screen.getByText(/filtro de óleo ainda não escolhido/)).toBeInTheDocument();
  });

  it("recomputes an untouched price when the attendant chooses a filter", async () => {
    const user = await openQuote(
      optionsBody(
        [oilCard],
        filtersBlock({ oil: { status: "matched", candidates: [tecfilOil, authomixOil] } }),
      ),
    );
    await user.click(await screen.findByRole("button", { name: /Authomix.*FOL0108/ }));

    await waitFor(async () => {
      expect(await screen.findByLabelText("Preço")).toHaveValue("273,00");
    });
    expect(
      screen.getByText(
        "Óleo R$ 50,00/L × 4 L (com filtro) = R$ 200,00 + filtro de óleo R$ 28,00 + filtro de combustível R$ 45,00 — Tecfil: PEUGEOT 207 1.4 8V",
      ),
    ).toBeInTheDocument();
  });

  it("keeps an edited price when the attendant then chooses a filter", async () => {
    const user = await openQuote(
      optionsBody(
        [oilCard],
        filtersBlock({ oil: { status: "matched", candidates: [tecfilOil, authomixOil] } }),
      ),
    );
    const price = await screen.findByLabelText("Preço");
    await user.clear(price);
    await user.type(price, "300,00");
    await user.click(await screen.findByRole("button", { name: /Authomix.*FOL0108/ }));

    expect(await screen.findByLabelText("Preço")).toHaveValue("300,00");
  });

  it.each([
    {
      name: "no catalog match lists the Tecfil numbers",
      filters: filtersBlock({ fuel: { status: "no_catalog_match", tecfilNumbers: ["GI50/7"] } }),
      expected: "Filtro de combustível não encontrado no catálogo interno (Tecfil: GI50/7).",
      price: "232,00",
    },
    {
      name: "no fitment warns that type only",
      filters: filtersBlock({ fuel: { status: "no_fitment" } }),
      expected: "A Tecfil não lista filtro de combustível para este veículo.",
      price: "232,00",
    },
    {
      name: "unavailable warns about both types",
      filters: filtersBlock({
        source: "unavailable",
        consultedAt: null,
        application: null,
        oil: { status: "unavailable" },
        fuel: { status: "unavailable" },
      }),
      expected: "Não foi possível consultar os filtros na Tecfil — nenhum filtro foi incluído no preço.",
      price: "200,00",
    },
    {
      name: "unmatched vehicle names the field without a part number",
      filters: filtersBlock({
        source: "unmatched",
        consultedAt: null,
        application: null,
        unmatchedField: "vehicle",
        oil: { status: "unavailable" },
        fuel: { status: "unavailable" },
      }),
      expected: "Veículo não encontrado no catálogo da Tecfil (veículo) — nenhum filtro foi incluído no preço.",
      price: "200,00",
    },
  ])("warns in Portuguese when $name", async ({ filters, expected, price }) => {
    await openQuote(optionsBody([oilCard], filters));

    expect(await screen.findByText(expected)).toBeInTheDocument();
    await waitFor(async () => {
      expect(await screen.findByLabelText("Preço")).toHaveValue(price);
    });
    expect(screen.getByRole("button", { name: "Enviar via WhatsApp" })).toBeEnabled();
  });

  // background-oil-research D12, D15: the quote never calls Tecfil, so there is no failed refetch
  // to fall back from; filters not yet consulted open the cards with the oil subtotal only.
  it("says the filters are still being consulted and prices the oil alone", async () => {
    await openQuote(
      optionsBody(
        [oilCard],
        filtersBlock({ source: "pending", stopped: true, consultedAt: null, application: null, oil: { status: "unavailable" }, fuel: { status: "unavailable" } }),
      ),
    );

    expect(
      await screen.findByText("Ainda estamos consultando os filtros na Tecfil — por enquanto, nenhum filtro entra no preço."),
    ).toBeInTheDocument();
    await waitFor(async () => {
      expect(await screen.findByLabelText("Preço")).toHaveValue("200,00");
    });
    expect(screen.getByRole("button", { name: "Enviar via WhatsApp" })).toBeEnabled();
  });

  it("sends one line per chosen filter alongside the oil line", async () => {
    const posts: Array<{ lines?: Array<{ catalogItemId: string; price: number }> }> = [];
    server.use(
      http.post("*/api/vehicles/:id/quotes", async ({ request }) => {
        posts.push((await request.json()) as { lines?: Array<{ catalogItemId: string; price: number }> });
        return HttpResponse.json(oilQuoteFixture, { status: 201 });
      }),
    );
    const user = await openQuote(optionsBody([oilCard], filtersBlock()));
    await waitFor(async () => {
      expect(await screen.findByLabelText("Preço")).toHaveValue("277,00");
    });
    await user.click(await screen.findByRole("button", { name: "Enviar via WhatsApp" }));

    await waitFor(() => {
      expect(posts).toHaveLength(1);
    });
    expect(posts[0]?.lines).toEqual([
      { catalogItemId: oilCard.id, price: 277 },
      { catalogItemId: tecfilOil.id, price: 32 },
      { catalogItemId: tecfilFuel.id, price: 45 },
    ]);
  });

  it("sends no filter line for an unresolved type", async () => {
    const posts: Array<{ lines?: Array<{ catalogItemId: string }> }> = [];
    server.use(
      http.post("*/api/vehicles/:id/quotes", async ({ request }) => {
        posts.push((await request.json()) as { lines?: Array<{ catalogItemId: string }> });
        return HttpResponse.json(oilQuoteFixture, { status: 201 });
      }),
    );
    const user = await openQuote(
      optionsBody([oilCard], filtersBlock({ fuel: { status: "no_fitment" } })),
    );
    await waitFor(async () => {
      expect(await screen.findByLabelText("Preço")).toHaveValue("232,00");
    });
    await user.click(await screen.findByRole("button", { name: "Enviar via WhatsApp" }));

    await waitFor(() => {
      expect(posts).toHaveLength(1);
    });
    expect(posts[0]?.lines?.map((line) => line.catalogItemId)).toEqual([oilCard.id, tecfilOil.id]);
  });
});

/**
 * Added by oil-quote-liters-pricing task 4.1.
 *
 * Oracle: specs/quotes/oil-quote/spec.md — the caption names the unit price, the volume, the oil
 * subtotal, the filters and the Tecfil application; "Missing motor liters is a Portuguese
 * failure" opens no cards; and the extracted grade list is shown, not one headline grade.
 *
 * Axes
 *   W1 result status — options / no_capacity
 *   W2 grades listed — one / two
 *
 * Outputs: O1 the spec line; O2 whether a price box exists at all
 *
 * Sampled cells (one row per `it`)
 *   options, two grades | W1,W2 | O1 both grades named |
 *      fails if the dialog shows only `viscosity`, which is the collapse D12 forbids
 *   no_capacity         | W1    | O2 no price box | fails if a card is priced from the
 *      unit price alone, i.e. a job quoted at one litre
 */
/**
 * Added by background-oil-research task 4.5 (minimal dialog support).
 *
 * Oracle: D16 and D17 — the dialog polls every 3 s while research is under way, a new search runs
 *   for the row, or the filters are pending and research runs; "Buscar novamente" is a POST whose
 *   body is written into the read's cache (no extra GET) and whose failure says so in Portuguese.
 *
 * Cells
 *   researching → options    | the options appear without a click, polling stops | a dialog stuck on the warning
 *   options → POST → refresh | the banner from the POST body, no extra GET, then a poll | a GET after the POST; no poll
 *   POST fails               | "Não foi possível pedir uma nova busca. Tente de novo.", button enabled | a silent failure
 *
 * These cases wait on the real 3 s interval, not fake timers: the interval is the behavior under test.
 */
describe("Conversas oil quote — research progress and Buscar novamente", () => {
  /** Opens the dialog with GETs answered from `reads` in order (the last repeats) and POSTs from `post`. */
  async function openSequence(reads: object[], post?: () => Response) {
    let gets = 0;
    let posts = 0;
    await openInbox();
    // Registered after the inbox's own handlers, so these answer first.
    server.use(
      http.get("*/api/vehicles/:id/quote-options", () => {
        const body = reads[Math.min(gets, reads.length - 1)];
        gets += 1;
        return HttpResponse.json(body);
      }),
      http.post("*/api/vehicles/:id/oil-research/refetch", () => {
        posts += 1;
        return post ? post() : HttpResponse.json({});
      }),
    );
    const user = userEvent.setup();
    await user.click((await screen.findAllByRole("button", { name: "Montar orçamento" }))[0]!);
    return { user, gets: () => gets, posts: () => posts };
  }

  it("shows the options when research ends, without a click, and stops polling", { timeout: 20_000 }, async () => {
    const seq = await openSequence([RESEARCHING, optionsBody([oilCard], filtersBlock())]);

    expect(await screen.findByText("Procurando lubrificante compatível — pode levar entre 1 e 3 minutos.")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /Motul 8100 X-cess/ }, { timeout: 6_000 })).toBeInTheDocument();
    const settled = seq.gets();
    await new Promise((resolve) => setTimeout(resolve, 3_500));
    expect(seq.gets()).toBe(settled);
  });

  it("shows the new search from the POST's own body, with no extra GET, then polls", { timeout: 20_000 }, async () => {
    const cached = optionsBody([oilCard], filtersBlock());
    const refreshing = { ...cached, refresh: TIMING };
    const seq = await openSequence([cached], () => HttpResponse.json(refreshing));
    const button = await screen.findByRole("button", { name: "Buscar novamente" });
    expect(seq.gets()).toBe(1);

    await seq.user.click(button);

    expect(await screen.findByText("Buscando dados novos — pode levar entre 1 e 3 minutos.")).toBeInTheDocument();
    expect(seq.posts()).toBe(1);
    expect(seq.gets()).toBe(1);
    await waitFor(() => expect(seq.gets()).toBe(2), { timeout: 6_000 });
  });

  // Orchestrator ruling (review of #188): `pending` polls; `unavailable` — no claim will bring the
  // filters — does not.
  it("polls while the filters are pending and stops once they read unavailable", { timeout: 20_000 }, async () => {
    const none = { consultedAt: null, application: null, oil: { status: "unavailable" as const }, fuel: { status: "unavailable" as const } };
    const seq = await openSequence([
      optionsBody([oilCard], filtersBlock({ source: "pending", stopped: false, ...none })),
      optionsBody([oilCard], filtersBlock({ source: "unavailable", ...none })),
    ]);

    expect(await screen.findByText(/Ainda estamos consultando os filtros na Tecfil/)).toBeInTheDocument();
    expect(
      await screen.findByText("Não foi possível consultar os filtros na Tecfil — nenhum filtro foi incluído no preço.", undefined, { timeout: 6_000 }),
    ).toBeInTheDocument();
    const settled = seq.gets();
    await new Promise((resolve) => setTimeout(resolve, 3_500));
    expect(seq.gets()).toBe(settled);
  });

  it("does not poll filters pending while research is stopped", { timeout: 20_000 }, async () => {
    const none = { consultedAt: null, application: null, oil: { status: "unavailable" as const }, fuel: { status: "unavailable" as const } };
    const seq = await openSequence([optionsBody([oilCard], filtersBlock({ source: "pending", stopped: true, ...none }))]);

    expect(await screen.findByText(/Ainda estamos consultando os filtros na Tecfil/)).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 3_500));
    expect(seq.gets()).toBe(1);
  });

  it("says the refetch request failed and keeps Buscar novamente available", async () => {
    const seq = await openSequence([optionsBody([oilCard], filtersBlock())], () => HttpResponse.json({ error: "boom" }, { status: 500 }));

    await seq.user.click(await screen.findByRole("button", { name: "Buscar novamente" }));

    expect(await screen.findByText("Não foi possível pedir uma nova busca. Tente de novo.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Buscar novamente" })).toBeEnabled();
  });
});

describe("Conversas oil quote — grounded spec on screen", () => {
  it("names every listed viscosity, the volume, and the cited source", async () => {
    await openQuote({
      ...optionsBody([oilCard], filtersBlock()),
      viscosityGrades: ["5W-40", "5W-30"],
      gradeSources: [
        { grade: "5W-40", ...MANUAL },
        { grade: "5W-30", ...MANUAL },
      ],
    });

    expect(
      await screen.findByText(/Viscosidades aceitas: 5W-40 ou 5W-30/),
    ).toBeInTheDocument();
    expect(screen.getByText(/volume de\s*troca 4 L/)).toBeInTheDocument();
    expect(
      screen.getByText(/^Fonte: .*Manual do Proprietário 207 \(2011\)/),
    ).toBeInTheDocument();
  });

  it("opens no cards when the volume was never verified", async () => {
    await openQuote({
      status: "no_capacity",
      viscosityGrades: ["5W-30"],
      viscosity: "5W-30",
      classification: "API SP",
      consultedAt: "2026-01-12T15:00:00.000Z",
      // The missing volume carries its cards and filters (background-oil-research D24); this
      // dialog does not price them yet (PR 5c builds the volume input).
      options: [oilCard],
      filters: filtersBlock(),
    });

    expect(
      await screen.findByText(/não o volume\s*de óleo da troca/),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Preço")).not.toBeInTheDocument();
  });

  // D5: a volume a change does not use is named, so the attendant knows why there is no price.
  it.each([
    ["without_filter", /um volume\s*sem filtro de 3,6 L,\s*mas esse não é o volume usado numa troca de óleo/],
    ["dry", /um volume\s*seco de 3,6 L,\s*mas esse não é o volume usado numa troca de óleo/],
  ] as const)("names a %s volume and opens no cards", async (condition, message) => {
    await openQuote({
      status: "no_capacity",
      viscosityGrades: ["5W-30"],
      viscosity: "5W-30",
      classification: "API SP",
      consultedAt: "2026-01-12T15:00:00.000Z",
      // The missing volume carries its cards and filters (background-oil-research D24); this
      // dialog does not price them yet (PR 5c builds the volume input).
      options: [oilCard],
      filters: filtersBlock(),
      unusableFill: { liters: 3.6, condition },
    });

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.queryByText(/não o volume\s*de óleo da troca/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Preço")).not.toBeInTheDocument();
  });
});

/**
 * Added with `conflicting_sources` (oil-quote-liters-pricing task 7.5).
 *
 * Oracle: specs/quotes/oil-quote/spec.md "Disagreeing sources are surfaced" — every value with its
 * source and tier, highest tier first, no cards.
 *
 * Sampled cell: one litre conflict, manual (tier 1) then catalog (tier 5) | shows both
 * values in that order with the tier's Portuguese name, and no price box | fails if the
 * dialog picks one value, or prices a card from either
 */
describe("Conversas oil quote — conflicting sources", () => {
  it("shows every value with its source, highest authority first, and opens no cards", async () => {
    await openQuote({
      status: "conflicting_sources",
      conflicts: [
        {
          field: "fillLiters",
          values: [
            {
              value: "4.3",
              sourcePublisher: "Volkswagen do Brasil",
              sourceDocument: "Manual do Proprietário Polo 2021",
              sourcePage: "p. 287",
              sourceAuthority: 1,
            },
            {
              value: "4",
              sourcePublisher: "CarroRac",
              sourceDocument: "tabela de aplicação",
              sourcePage: "Polo AW, 1.0 TSI",
              sourceAuthority: 5,
            },
          ],
        },
      ],
    });

    expect(await screen.findByText(/As fontes consultadas discordam/)).toBeInTheDocument();
    // Written in pt-BR, as the canvas draws it (background-oil-research 5.6).
    const manual = screen.getByText(/4,3 L — Volkswagen do Brasil/);
    const catalog = screen.getByText(/4,0 L — CarroRac/);
    expect(manual).toHaveTextContent("manual da montadora");
    expect(catalog).toHaveTextContent("catálogo de reposição");
    // Order is the preference: the manual's line must precede the catalog's in the DOM.
    expect(manual.compareDocumentPosition(catalog) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByLabelText("Preço")).not.toBeInTheDocument();
  });
});

/**
 * Added by web-search-source-adapter task 6.1.
 *
 * Oracle: specs/quotes/oil-quote/spec.md "the card caption names the page and its URL", and the
 * design's line that a web source needs no new dialog state. The passage the extractor read
 * is audit data: it lives on the cache row and must never reach the customer.
 *
 * Axes
 *   B1 the citation carries a URL — yes / no
 *   B2 the payload also carries an excerpt (a server that over-shares) — yes
 *
 * Outputs: O1 the caption; O2 the assembled WhatsApp text
 *
 * Sampled cells (one row per `it`)
 *   web citation with URL | B1,B2 | O1 publisher, document and the link | O2 no excerpt.
 *      THE case: the attendant can check the page, the customer never sees the scrape
 *   citation with no URL  | B1    | O1 unchanged — a fixture source grows no empty link
 *
 * Out of scope: how the page was found (api web-search.test.ts); what is persisted
 * (api options.test.ts); the conflict caption (the conflicting-sources block above).
 */
describe("Conversas oil quote — a web-found citation", () => {
  const PAGE_URL = "https://peugeot.com.br/pos-venda/207-2011/capacidades";
  const EXCERPT = "Motor 1.4 8V — 5W-40 — capacidade em serviço 4,0 L";

  it("shows the page and its link, and keeps the passage out of the message", async () => {
    const posts: Array<{ generatedMessageText?: string }> = [];
    server.use(
      http.post("*/api/vehicles/:id/quotes", async ({ request }) => {
        posts.push((await request.json()) as { generatedMessageText?: string });
        return HttpResponse.json(oilQuoteFixture, { status: 201 });
      }),
    );

    const user = await openQuote({
      ...optionsBody([oilCard], filtersBlock(), { ...MANUAL, sourceUrl: PAGE_URL }),
      // A server that over-shares must still not reach the customer.
      sourceExcerpt: EXCERPT,
    });

    const caption = await screen.findByText(/^Fonte: .*Manual do Proprietário 207 \(2011\)/);
    expect(caption).toHaveTextContent("Peugeot do Brasil");
    expect(screen.getByRole("link", { name: PAGE_URL })).toHaveAttribute("href", PAGE_URL);
    expect(screen.queryByText(new RegExp(EXCERPT.slice(0, 20)))).not.toBeInTheDocument();

    await user.click(await screen.findByRole("button", { name: "Enviar via WhatsApp" }));
    await waitFor(() => {
      expect(posts).toHaveLength(1);
    });
    expect(posts[0]?.generatedMessageText).not.toContain(EXCERPT);
    expect(posts[0]?.generatedMessageText).not.toContain(PAGE_URL);
  });

  it("renders no link when the source has no URL", async () => {
    await openQuote(optionsBody([oilCard], filtersBlock()));

    expect(await screen.findByText(/^Fonte: .*Manual do Proprietário 207 \(2011\)/)).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});

/**
 * Each grade and the liters cited to their own source (oil-quote spec, "Each grade and the
 * liters carry their own source"; design D11, owner 2026-09-25).
 *
 *   header lines      | one when all agree | one per source, naming what it covers
 *   card caption      | the card's own grade's source, never another grade's
 *   customer message  | no source, whatever the cards cite
 *
 * Oracle: the spec scenarios. The two sources sit on different publishers AND documents, so
 * a caption showing the wrong one cannot pass by sharing a substring.
 */
describe("Conversas oil quote — each grade cited to its own source", () => {
  const CATALOG = {
    sourcePublisher: "CarroRac",
    sourceDocument: "Catálogo de aplicação 2024",
    sourcePage: "207 1.4 8V",
    sourceAuthority: 5,
    sourceUrl: null as string | null,
  };
  const card0w20 = {
    ...catalogItemFixture,
    id: "cat-0w20",
    brand: "Motul",
    description: "8100 Eco-clean",
    price: 50,
    lubricant: { ...lubricantDetailFixture, catalogItemId: "cat-0w20", viscosity: "0W-20" },
  };
  const card5w30 = {
    ...catalogItemFixture,
    id: "cat-5w30",
    brand: "Lubrax",
    description: "Supera",
    price: 40,
    lubricant: { ...lubricantDetailFixture, catalogItemId: "cat-5w30", viscosity: "5W-30" },
  };

  /** Manual lists only 0W-20; the catalog lists 0W-20 and 5W-30 and states the liters. */
  function splitBody() {
    return {
      ...optionsBody([card0w20, card5w30], filtersBlock()),
      viscosityGrades: ["0W-20", "5W-30"],
      viscosity: "0W-20",
      gradeSources: [
        { grade: "0W-20", ...MANUAL },
        { grade: "5W-30", ...CATALOG },
      ],
      litersSource: CATALOG,
    };
  }

  /** The card holding the button named `name`. */
  async function cardOf(name: RegExp) {
    const card = (await screen.findByRole("button", { name })).closest<HTMLElement>(".MuiPaper-root");
    expect(card).not.toBeNull();
    return within(card!);
  }

  it("captions each card with its own grade's source", async () => {
    await openQuote(splitBody());

    const eco = await cardOf(/Motul 8100 Eco-clean/);
    expect(eco.getByText(/^Fonte de 0W-20:/)).toHaveTextContent(
      "Peugeot do Brasil — Manual do Proprietário 207 (2011) (Seção 8 — Capacidades)",
    );
    expect(eco.queryByText(/CarroRac/)).not.toBeInTheDocument();
    const supera = await cardOf(/Lubrax Supera/);
    expect(supera.getByText(/^Fonte de 5W-30:/)).toHaveTextContent(
      "CarroRac — Catálogo de aplicação 2024 (207 1.4 8V)",
    );
    expect(supera.queryByText(/Peugeot/)).not.toBeInTheDocument();
  });

  it("lists each source with what it covers, the liters named on the catalog's line", async () => {
    await openQuote(splitBody());

    expect(await screen.findByText(/^Fonte de 5W-30 e do volume de troca: CarroRac/)).toBeInTheDocument();
    // The manual is never shown as the source of the grade it does not list.
    expect(screen.queryByText(/^Fonte de .*5W-30.*Peugeot/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Fonte: /)).not.toBeInTheDocument();
  });

  it("gives the liters a line of their own when no grade shares their source", async () => {
    await openQuote({
      ...optionsBody([oilCard], filtersBlock()),
      litersSource: CATALOG,
    });

    expect(await screen.findByText(/^Fonte do volume de troca: CarroRac/)).toBeInTheDocument();
    // The header's grade line and the card's caption: the manual, for the grade it lists.
    expect(screen.getAllByText(/^Fonte de 5W-40: Peugeot do Brasil/)).toHaveLength(2);
  });

  it("keeps one Fonte line when every grade and the liters share a source", async () => {
    await openQuote(optionsBody([oilCard], filtersBlock()));

    expect(await screen.findByText(/^Fonte: Peugeot do Brasil/)).toBeInTheDocument();
    expect(screen.queryByText(/volume de troca: /)).not.toBeInTheDocument();
  });

  it("sends a message with no source, whatever the cards cite", async () => {
    const posts: Array<{ generatedMessageText?: string }> = [];
    server.use(
      http.post("*/api/vehicles/:id/quotes", async ({ request }) => {
        posts.push((await request.json()) as { generatedMessageText?: string });
        return HttpResponse.json(oilQuoteFixture, { status: 201 });
      }),
    );
    // Every card starts selected, so the message carries both grades and both sources' cards.
    const user = await openQuote(splitBody());
    await user.click(await screen.findByRole("button", { name: "Enviar via WhatsApp" }));

    await waitFor(() => {
      expect(posts).toHaveLength(1);
    });
    const text = posts[0]?.generatedMessageText ?? "";
    expect(text).toContain("Motul 8100 Eco-clean");
    expect(text).toContain("Lubrax Supera");
    for (const fragment of ["Peugeot", "Manual", "CarroRac", "Catálogo", "Fonte"]) {
      expect(text).not.toContain(fragment);
    }
  });
});

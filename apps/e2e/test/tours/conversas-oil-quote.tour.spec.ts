/**
 * Tour log — Montar orçamento (oil quote) after background-oil-research
 *
 * Feature: the oil-quote dialog opened from a vehicle on the contact rail. Since
 * background-oil-research the quote calls no provider: it answers from the
 * compatibility caches and the identity's research state, and a car with no
 * cache row shows the research under way.
 *
 * Run reports: `runs/2026-10-04-oil-quote-happy-path.md` (the happy path:
 * filter choice, price edit, message — close-stated-coverage-gaps 2.2/3.2),
 * `runs/2026-10-01-oil-quote-research.md` (background-oil-research task 5.5),
 * after `runs/2026-09-10-conversas-oil-quote.md` and
 * `runs/2026-09-17-oil-quote-reuse.md`. Every step below was driven live through
 * the Playwright MCP first; each `expect` cites the delta scenario that is its
 * oracle and asserts the scenario's copy, never a value the drive displayed.
 *
 * Guidebook (openspec/changes/background-oil-research/specs):
 * - quotes/oil-quote — "The quote answers from the research state and calls no
 *   provider" (A verified identity opens on its options; A cached identity with
 *   no research record starts nothing; An incomplete identity names what is
 *   missing); "The dialog shows research progress while an identity is
 *   researched" (No worker running is said plainly).
 * - conversations/conversas — "A vehicle being researched says so on the rail"
 *   (Research not running shows nothing).
 * - openspec/specs/conversations/conversas/spec.md — each vehicle offers Montar
 *   orçamento for itself.
 * - openspec/specs/quotes/oil-quote/spec.md — "Inactive item is not offered"
 *   and the offerable-oil rule; the pre-filled price (oil subtotal plus the
 *   CHOSEN filters, a multi-candidate type contributing nothing until chosen);
 *   an edited price is never overwritten; the message's Valor is the card's price.
 * - openspec/changes/block-send-until-filter-chosen/specs — quotes/oil-quote
 *   "Each oil option is priced with one filter per type" (An unchosen filter
 *   blocks the send; Choosing every multi-candidate type unblocks the send).
 *   Owner ruling 2026-10-04, from finding 1 of the 2026-10-04 happy-path run.
 *
 * Fixtures (`seed-e2e.ts`): vehicle A is a Gol 2019 with NO make and NO version;
 * the Polo 2021 has both cache rows; the Kwid 2023 is complete with no cache
 * row. The seed clears both identities' research state (and the Kwid's caches)
 * every run. The tour stack runs no worker, so research reads as not running.
 *
 * NOT PROVIDER-FREE WITH A WORKER. Opening the Kwid queues a research of it at
 * the front. The quote itself calls no provider, but a dev worker pointed at
 * this database would run that research for real — web search, OpenAI, Tecfil.
 * Run the tours only on their own database, with no worker attached.
 *
 * Tours:
 * - Guiado (Negócio) — the three things an attendant meets: a car with missing
 *   data, a car already researched, a car not yet researched.
 * - Correios (Negócio) — does opening any of them reach Motul, Tecfil, OpenAI or
 *   any other provider? It must not: the read calls no provider, whatever the identity.
 * - Guiado, continued — the quote an attendant actually sends: choose the oil
 *   filter, edit one price, read the message.
 * - Ator Coadjuvante (Entretenimento) — every vehicle row has its own trigger.
 * - Período Chuvoso (Hoteleiro) — `Fechar` writes nothing and breaks nothing.
 *
 * SERVER-SIDE EVIDENCE (close-stated-coverage-gaps, ruling 2026-10-04). The
 * Correios tour below watches the browser request listener, which cannot see a
 * call the API makes, so on its own it is not evidence that no provider was
 * reached. Two things are: the quote path structurally calls no provider since
 * background-oil-research PR 4, and `test/tour-provider-guard.test.ts` proves
 * on the real clients' call path that a tour API's env sends Motul and Tecfil
 * to a loopback rather than their compiled-in hosts. The API-log grep the
 * 2026-09-17 version carried was dropped on purpose and is not re-added.
 *
 * Never clicked here: `Buscar novamente`. It only queues a research now, but a
 * worker pointed at the same database would run it for real.
 */
import { CATALOG_SEED_ROWS } from "@select-lub/core/db";
import { E2E } from "../ids.js";
import { expect, test } from "./fixtures.js";

/** Hosts no request may reach on the tour stack. */
// Named for what these hosts ARE: a suite must not depend on a third party's
// uptime, nor fire unsolicited traffic at someone's production service.
const OFF_BOX_PROVIDERS = /motul\.|tecfil\.|openai\.com/i;

/** The rail labels of the plate-less vehicles: make, model and year. */
const POLO_LABEL = `${E2E.quoteVehicleMake} ${E2E.quoteVehicleModel} ${E2E.quoteVehicleYear}`;
const KWID_LABEL = `${E2E.researchVehicleMake} ${E2E.researchVehicleModel} ${E2E.researchVehicleYear}`;

/** Shape of `GET /vehicles/:id/quote-options` that the Correios tour reads. */
type QuoteOptions = { status: string; consultedAt?: string; paused?: { reason: string } | null; refresh?: unknown };

test("Tour Guiado: a car missing its make and version says which data to complete", async ({
  conversasPage,
  mainPane,
}) => {
  await conversasPage.gotoConversation(E2E.tourConversationId);
  await mainPane();

  await conversasPage.montarOrcamento(E2E.tourVehicleAPlate).click();
  await expect(conversasPage.quoteDialog()).toBeVisible();

  // Oracle: oil-quote — "An incomplete identity names what is missing", with
  // D17's field order and join (marca, modelo, versão, ano; ", " and " e ").
  await expect(conversasPage.quoteStatus()).toHaveText(
    "Para pesquisar o lubrificante, complete os dados do veículo: marca e versão.",
  );
  // An incomplete identity queues no research, so nothing offers a new one.
  await expect(conversasPage.quoteRefetch()).toHaveCount(0);
  await expect(conversasPage.quoteDialog().getByText(/R\$/)).toHaveCount(0);
});

test("Tour Guiado: a researched car opens on its options, with no new search and no polling", async ({
  conversasPage,
  page,
  mainPane,
}) => {
  const reads: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes(`/vehicles/${E2E.quoteVehicleId}/quote-options`)) reads.push(request.url());
  });
  await conversasPage.gotoConversation(E2E.tourConversationId);
  await mainPane();

  await conversasPage.quoteTriggerFor(POLO_LABEL).click();

  // Oracle: oil-quote — "A verified identity opens on its options": the row's
  // date, "Buscar novamente", and no reuse-vs-refetch prompt.
  // The seeded Polo fits two oil filters (PSL545 and FOL0545), so the status also
  // carries the send block's hint (block-send-until-filter-chosen).
  await expect(conversasPage.quoteStatus()).toHaveText(
    /^Dados consultados em \d{2}\/\d{2}\/\d{4}\. Escolha o filtro de óleo antes de enviar\.$/,
  );
  await expect(conversasPage.quoteRefetch()).toBeVisible();
  await expect(conversasPage.quoteDialog().getByRole("button", { name: /^Usar dados de/ })).toHaveCount(0);
  await expect(conversasPage.quoteMessage()).toBeVisible();

  // Oracle: oil-quote (block-send-until-filter-chosen) — "An unchosen filter
  // blocks the send" and "Choosing every multi-candidate type unblocks the
  // send". The chooser writes nothing; the send button is never clicked here.
  await expect(conversasPage.quoteSend()).toHaveAttribute("aria-disabled", "true");
  await expect(conversasPage.quoteSend()).toHaveAccessibleDescription("Escolha o filtro de óleo antes de enviar.");
  await conversasPage.quoteDialog().getByRole("button", { name: /FOL0545/ }).click();
  await expect(conversasPage.quoteSend()).not.toHaveAttribute("aria-disabled");
  await expect(conversasPage.quoteStatus()).toHaveText(/^Dados consultados em \d{2}\/\d{2}\/\d{4}\.$/);

  // Oracle: oil-quote — "A cached identity with no research record starts
  // nothing": no new search is said to be under way, and the dialog stops
  // refreshing. Measured over more than one 3 s poll interval.
  await expect(conversasPage.quoteDialog().getByText(/Buscando dados novos/)).toHaveCount(0);
  await expect(conversasPage.quoteTimer()).toHaveCount(0);
  await page.waitForTimeout(4_000);
  expect(reads).toHaveLength(1);
});

test("Tour Guiado: a car not yet researched says research is not running, and counts from the request", async ({
  conversasPage,
  mainPane,
}) => {
  await conversasPage.gotoConversation(E2E.tourConversationId);
  await mainPane();

  await conversasPage.quoteTriggerFor(KWID_LABEL).click();

  // Oracle: oil-quote — "No worker running is said plainly": the stopped
  // sentence, no range, and the time reads "Na fila há …".
  await expect(conversasPage.quoteStatus()).toHaveText(
    "A pesquisa automática não está rodando agora; o pedido fica na fila.",
  );
  await expect(conversasPage.quoteDialog().getByText(/pode levar entre/)).toHaveCount(0);
  await expect(conversasPage.quoteTimer()).toHaveText(/^Na fila há \d/);
  // Oracle: D17 — the counter is a timer outside the one status region.
  await expect(conversasPage.quoteStatus()).toHaveCount(1);
  await expect(conversasPage.quoteStatus().getByRole("timer")).toHaveCount(0);

  await conversasPage.quoteClose().click();

  // Oracle: conversas — "Research not running shows nothing": the row carries
  // no research line while research is stopped.
  const kwidRow = conversasPage.quoteTriggerFor(KWID_LABEL).locator("xpath=..");
  await expect(kwidRow.getByText("Pesquisando lubrificante…")).toHaveCount(0);
  await expect(conversasPage.quoteTriggerFor(KWID_LABEL)).toBeEnabled();
});

/** Catalogue price of one seeded item: a litre of oil, or one filter. */
function catalogPrice(id: string): number {
  const row = CATALOG_SEED_ROWS.find((item) => item.id === id);
  if (!row) throw new Error(`catalog seed has no ${id}`);
  return row.price;
}

/** BRL in the dialog's notation, without the currency sign: `403,50`. */
function brl(value: number): string {
  return value.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Escapes a literal for use inside a RegExp. */
function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * pt-BR label of each stored oil type — the oracle is the oil-quote scenario "Each oil type has
 * its pt-BR label" (add-lubricant-oil-type), not the web's map.
 */
const OIL_TYPE_LABEL = { SINTETICO: "Sintético", SEMISSINTETICO: "Semissintético", MINERAL: "Mineral" } as const;

/**
 * One option block of the assembled message, built from the seeded catalogue row. Oracle:
 * oil-quote "Cards carry editable prices and assemble the message live" — the option line is
 * brand, description and viscosity; "➡️ Tipo:" carries the pt-BR oil type and is omitted for a
 * lubricant with none ("A lubricant without a type omits the type line"); then "➡️ Valor:".
 */
function messageOption(id: string, price: string): RegExp {
  const row = CATALOG_SEED_ROWS.find((item) => item.id === id);
  if (!row?.viscosity) throw new Error(`catalog seed has no lubricant ${id}`);
  const lines = [`${row.brand} ${row.description} ${row.viscosity}`];
  if (row.oilType) lines.push(`➡️ Tipo: ${OIL_TYPE_LABEL[row.oilType]}`);
  lines.push(`➡️ Valor: R$ ${price}`);
  return new RegExp(literal(lines.join("\n")));
}

test("Tour Guiado: the attendant chooses a filter, edits a price, and the message carries it", async ({
  conversasPage,
  mainPane,
}) => {
  await conversasPage.gotoConversation(E2E.tourConversationId);
  await mainPane();
  await conversasPage.quoteTriggerFor(POLO_LABEL).click();
  await expect(conversasPage.quoteStatus()).toHaveText(/^Dados consultados em /);

  // Oracle: oil-quote — the offerable-oil rule. The cited grades are 0W-20,
  // 5W-40, 0W-40 and 5W-30; the active catalogue items at those grades are the
  // four below. Both sides pinned: the four ARE offered, and "Inactive item is
  // not offered" — the inactive 5W-30 Lubrax Essencial is NOT, though its grade
  // is listed. A card count alone would pass with the active filter broken.
  const cards = [
    { name: "Motul 8100 Eco-nergy", id: "cat-motul-8100-5w30" },
    { name: "Lubrax Tecno", id: "cat-lubrax-tecno-5w30" },
    { name: "Motul 8100 X-cess", id: "cat-motul-8100-5w40" },
    { name: "Ipiranga F1 Master", id: "cat-ipiranga-5w40" },
  ];
  for (const card of cards) await expect(conversasPage.quoteCard(card.name)).toBeVisible();
  // Oracle: add-lubricant-oil-type — the card shows its pt-BR oil type beside the price, and an
  // untyped lubricant shows none. The types come from the seeded catalogue, not from the drive.
  for (const card of cards) {
    const oilType = CATALOG_SEED_ROWS.find((item) => item.id === card.id)?.oilType;
    const paper = conversasPage.quoteCard(card.name).locator("xpath=..");
    for (const [value, label] of Object.entries(OIL_TYPE_LABEL)) {
      await expect(paper.getByText(label, { exact: true })).toHaveCount(value === oilType ? 1 : 0);
    }
  }
  await expect(conversasPage.quoteDialog().getByText(/Lubrax Essencial/)).toHaveCount(0);
  await expect(conversasPage.quoteDialog().getByRole("textbox", { name: "Preço" })).toHaveCount(cards.length);

  // Prices from the catalogue data (`catalog-seed.ts`) and the spec's formula —
  // never from what the drive displayed. Litres: the cited row's em_servico fill.
  const liters = 4;
  const oilSubtotal = (id: string) => Math.round(catalogPrice(id) * liters * 100) / 100;
  const fuelFilter = catalogPrice("cat-tecfil-gi50-7");
  const oilFilter = catalogPrice("cat-tecfil-psl545");

  // Oracle: "until the attendant chooses, that type SHALL contribute nothing to
  // the price". Two oil-filter candidates, none chosen: the price is the oil
  // subtotal plus the fuel filter, auto-chosen as the only candidate.
  await expect(conversasPage.quoteCardPrice(cards[0]!.name)).toHaveValue(brl(oilSubtotal(cards[0]!.id) + fuelFilter));
  // Oracle: block-send-until-filter-chosen — "An unchosen filter blocks the send".
  await expect(conversasPage.quoteStatus()).toHaveText(/Escolha o filtro de óleo antes de enviar\.$/);
  await expect(conversasPage.quoteSend()).toHaveAttribute("aria-disabled", "true");

  // Oracle: the pre-filled price is the oil subtotal plus the CHOSEN oil filter
  // plus the chosen fuel filter, recomputed when a chooser changes.
  await conversasPage.quoteFilterChoice("Filtro de óleo", "PSL545").click();
  // Oracle: "Choosing every multi-candidate type unblocks the send".
  await expect(conversasPage.quoteSend()).not.toHaveAttribute("aria-disabled");
  const prefilled = new Map(cards.map((card) => [card.name, brl(oilSubtotal(card.id) + oilFilter + fuelFilter)]));
  for (const card of cards) {
    await expect(conversasPage.quoteCardPrice(card.name)).toHaveValue(prefilled.get(card.name)!);
  }

  // Oracle: "a price the attendant edited MUST NOT be overwritten", and the
  // others keep their pre-filled value. 399,90 is far from every pre-filled
  // price, so the message assertion below cannot match by coincidence.
  const edited = "399,90";
  await conversasPage.quoteCardPrice(cards[0]!.name).fill(edited);
  await expect(conversasPage.quoteCardPrice(cards[0]!.name)).toHaveValue(edited);
  await expect(conversasPage.quoteCardPrice(cards[1]!.name)).toHaveValue(prefilled.get(cards[1]!.name)!);

  // Oracle: "The proposal message's Valor is the card's price" — the edited one
  // for the edited card, the pre-filled one for the rest.
  const message = conversasPage.quoteMessage();
  await expect(message).toHaveValue(messageOption(cards[0]!.id, edited));
  await expect(message).not.toHaveValue(messageOption(cards[0]!.id, prefilled.get(cards[0]!.name)!));
  for (const card of cards.slice(1)) {
    await expect(message).toHaveValue(messageOption(card.id, prefilled.get(card.name)!));
  }
  await expect(message).not.toHaveValue(/Lubrax Essencial/);
});

test("Tour dos Correios: no request leaves for Motul, Tecfil or OpenAI, and the cache row is untouched", async ({
  conversasPage,
  crmApi,
  page,
  mainPane,
}) => {
  const offBoxRequests: string[] = [];
  page.on("request", (request) => {
    if (OFF_BOX_PROVIDERS.test(request.url())) offBoxRequests.push(request.url());
  });
  async function quoteOptions(vehicleId: string) {
    const response = await crmApi.get(`/vehicles/${vehicleId}/quote-options`);
    expect(response.ok()).toBe(true);
    return (await response.json()) as QuoteOptions;
  }
  const before = await quoteOptions(E2E.quoteVehicleId);

  await conversasPage.gotoConversation(E2E.tourConversationId);
  await mainPane();
  for (const label of [E2E.tourVehicleAPlate, POLO_LABEL, KWID_LABEL]) {
    await conversasPage.quoteTriggerFor(label).click();
    await expect(conversasPage.quoteStatus()).not.toHaveText("Carregando opções de orçamento…");
    await conversasPage.quoteClose().click();
  }

  // Oracle: oil-quote — "Opening a quote calls no provider". Collected across
  // the whole tour, not sampled at one instant.
  expect(offBoxRequests).toEqual([]);
  // Oracle: oil-quote — "Reuse does not search the web": the shown row is the
  // same row, and no new search was started for it.
  const after = await quoteOptions(E2E.quoteVehicleId);
  expect(after.status).toBe("options");
  expect(after.consultedAt).toBe(before.consultedAt);
  expect(after.refresh).toBeUndefined();
  // And the uncached car is queued with research not running (D15 rule 1: no runner).
  const kwid = await quoteOptions(E2E.researchVehicleId);
  expect(kwid.status).toBe("researching");
  expect(kwid.paused).toEqual({ reason: "stopped" });
});

test("Tour do Ator Coadjuvante: each trigger opens the quote for its own vehicle", async ({
  conversasPage,
  mainPane,
}) => {
  await conversasPage.gotoConversation(E2E.tourConversationId);
  await mainPane();

  // Oracle: conversas — "Trigger opens the quote for the clicked vehicle".
  // Driven on both vehicles because with one car the assertion cannot fail.
  await conversasPage.montarOrcamento(E2E.tourVehicleAPlate).click();
  await expect(conversasPage.quoteDialog()).toContainText(E2E.tourVehicleAPlate);
  await expect(conversasPage.quoteDialog()).not.toContainText(E2E.tourVehicleBPlate);
  await conversasPage.quoteClose().click();
  await expect(conversasPage.quoteDialog()).toHaveCount(0);

  await conversasPage.montarOrcamento(E2E.tourVehicleBPlate).click();
  await expect(conversasPage.quoteDialog()).toContainText(E2E.tourVehicleBPlate);
  await expect(conversasPage.quoteDialog()).not.toContainText(E2E.tourVehicleAPlate);
});

test("Tour em Período Chuvoso: closing the quote leaves the rail intact", async ({
  conversasPage,
  mainPane,
}) => {
  await conversasPage.gotoConversation(E2E.tourConversationId);
  await mainPane();

  await conversasPage.montarOrcamento(E2E.tourVehicleAPlate).click();
  await expect(conversasPage.quoteDialog()).toBeVisible();

  await conversasPage.quoteClose().click();
  await expect(conversasPage.quoteDialog()).toHaveCount(0);

  // Período Chuvoso — leaving mid-operation writes nothing and breaks nothing.
  await mainPane();
  await expect(conversasPage.vehicleRow(E2E.tourVehicleAPlate)).toBeVisible();
  await expect(conversasPage.vehicleRow(E2E.tourVehicleBPlate)).toBeVisible();
  await expect(conversasPage.serviceRow("Troca de óleo e2e retorno")).toBeVisible();
});

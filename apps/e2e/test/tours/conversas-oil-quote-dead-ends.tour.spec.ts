/**
 * Tour log — Montar orçamento's three dead ends and their ways out (background-oil-research D24)
 *
 * Feature: the missing volume, the clarification and the conflicting sources each offer the
 * attendant an action on the spot: type the volume, pick the engine (or correct the version), and
 * choose the grade and the volume among the sources'.
 *
 * Run report: `runs/2026-10-01-oil-quote-dead-ends.md` (task 5.12). The steps were driven live
 * first, through the same route mocks, by the visual-QA capture of task 5.6; each `expect` cites
 * the delta scenario that is its oracle and asserts the scenario's copy, never a value the drive
 * displayed.
 *
 * THE QUOTE READ IS ROUTE-MOCKED. The tour stack runs no worker, so none of these outcomes can be
 * reached on it: a clarification, a conflict or a missing volume is only ever written by research.
 * `page.route` answers the Polo's `GET /vehicles/:id/quote-options` with each outcome, and answers
 * the two dead-end POSTs itself, so the tour writes nothing — no attendant volume, no version, no
 * queued research. Everything else on the page (the rail, the vehicle list, the drill-in) is the
 * live tour stack. The api's side of these routes is covered by its `app.inject` tests (task 5.9).
 *
 * Guidebook (openspec/changes/background-oil-research/specs):
 * - quotes/oil-quote — "The attendant can type a missing fill volume" (A value that is not a
 *   volume is refused; A volume above 30 L warns; A confirmed high volume prices and can be kept;
 *   Only this quote stores nothing); "Ambiguous engine is clarification" (Choosing a named engine
 *   appends it and re-reads the source; No engine named opens the vehicle's form); "Disagreeing
 *   sources are surfaced, never silently decided" (A grade conflict offers every grade's cards,
 *   each citing its source; Grade and volume both in conflict ask for both).
 * - conversations/conversas — "The quote's clarification corrects the vehicle through the rail"
 *   (Correcting the version opens the form).
 *
 * Tours:
 * - Guiado (Negócio) — each dead end, walked to its way out.
 * - Obsessivo (Intelectual) — the values the volume field must refuse or question: 0 and 42.
 * - Ator Coadjuvante (Entretenimento) — the keyboard alone moves a conflict's choice.
 *
 * Never clicked here: `Enviar via WhatsApp` (it saves a quote), `Guardar para este modelo` and
 * `Buscar novamente`.
 */
import type { Page, Route } from "@playwright/test";
import { E2E } from "../ids.js";
import { expect, test } from "./fixtures.js";

const POLO_LABEL = `${E2E.quoteVehicleMake} ${E2E.quoteVehicleModel} ${E2E.quoteVehicleYear}`;

const STAMP = { createdAt: "2026-08-21T10:00:00.000Z", updatedAt: "2026-08-26T12:00:00.000Z" };
/** A mocked oil card. `oilType` is required-nullable on the contract since add-lubricant-oil-type; the canvas's "Sintético". */
function oil(id: string, brand: string, description: string, viscosity: string, price: number, gradeSource?: object) {
  return { id, brand, description, price, stock: 6, active: true, ...STAMP, lubricant: { catalogItemId: id, viscosity, classification: "", oilType: "SINTETICO" }, ...(gradeSource ? { gradeSource } : {}) };
}
const NO_FILTERS = { source: "cached", consultedAt: "2026-09-12T15:00:00.000Z", application: null, oil: { status: "no_fitment" }, fuel: { status: "no_fitment" } };
const MANUAL = { sourcePublisher: "Volkswagen", sourceDocument: "Manual do proprietário Polo 2021", sourcePage: "p. 287", sourceAuthority: 1, sourceUrl: null, sourceClassification: "manufacturer_manual" };
const GUIDE = { sourcePublisher: "Lubrax", sourceDocument: "Guia de aplicação VW", sourcePage: "p. 31", sourceAuthority: 4, sourceUrl: null, sourceClassification: null };

const NO_CAPACITY = {
  status: "no_capacity",
  viscosityGrades: ["5W-40"],
  viscosity: "5W-40",
  classification: "",
  consultedAt: "2026-09-12T15:00:00.000Z",
  options: [oil("tour-motul", "Motul", "8100 X-cess 5W-40", "5W-40", 40)],
  filters: NO_FILTERS,
};

const GRADE_AND_VOLUME_CONFLICT = {
  status: "conflicting_sources",
  conflicts: [
    {
      field: "viscosityGrades",
      values: [
        { value: "0W-20", sourcePublisher: "Volkswagen", sourceDocument: MANUAL.sourceDocument, sourcePage: "p. 287", sourceAuthority: 1 },
        { value: "5W-40", sourcePublisher: "Lubrax", sourceDocument: GUIDE.sourceDocument, sourcePage: "p. 31", sourceAuthority: 4 },
      ],
    },
    {
      field: "fillLiters",
      values: [
        { value: "3.6", sourcePublisher: "Volkswagen", sourceDocument: MANUAL.sourceDocument, sourcePage: "p. 287", sourceAuthority: 1 },
        { value: "4", sourcePublisher: "Lubrax", sourceDocument: GUIDE.sourceDocument, sourcePage: "p. 31", sourceAuthority: 4 },
      ],
    },
  ],
  viscosityGrades: ["0W-20", "5W-40"],
  classification: "",
  gradeSources: [{ grade: "0W-20", ...MANUAL }, { grade: "5W-40", ...GUIDE }],
  options: [oil("tour-mobil", "Mobil", "Super 3000 0W-20", "0W-20", 45, MANUAL), oil("tour-motul", "Motul", "8100 X-cess 5W-40", "5W-40", 40, GUIDE)],
  filters: NO_FILTERS,
  volumeChoices: [
    { liters: 3.6, fillCondition: "with_filter", source: MANUAL },
    { liters: 4, fillCondition: "unlabeled", source: GUIDE },
  ],
};

/** Answers the Polo's quote read with `body`, and the two dead-end POSTs locally; returns their bodies. */
async function mockQuote(page: Page, body: object, enginePick?: object) {
  const posts: Array<{ url: string; body: unknown }> = [];
  await page.route(`**/api/vehicles/${E2E.quoteVehicleId}/quote-options`, (route: Route) => route.fulfill({ json: body }));
  await page.route(`**/api/vehicles/${E2E.quoteVehicleId}/oil-fill-volume`, (route: Route) => {
    posts.push({ url: route.request().url(), body: route.request().postDataJSON() });
    return route.fulfill({ status: 201, json: { liters: 42, recordedBy: "Tour", recordedAt: "2026-10-01T12:00:00.000Z" } });
  });
  await page.route(`**/api/vehicles/${E2E.quoteVehicleId}/oil-research/engine-pick`, (route: Route) => {
    posts.push({ url: route.request().url(), body: route.request().postDataJSON() });
    return route.fulfill({ json: enginePick ?? {} });
  });
  return posts;
}

test("Tour Obsessivo: the volume field refuses 0, questions 42, and prices 42 once confirmed", async ({ conversasPage, page, mainPane }) => {
  const posts = await mockQuote(page, NO_CAPACITY);
  await conversasPage.gotoConversation(E2E.tourConversationId);
  await mainPane();
  await conversasPage.quoteTriggerFor(POLO_LABEL).click();

  // Oracle: oil-quote — "A value that is not a volume is refused".
  await conversasPage.quoteVolumeInput().fill("0");
  await conversasPage.quoteUseVolume().click();
  await expect(conversasPage.quoteStatus()).toContainText("Informe o volume em litros, maior que zero.");
  await expect(conversasPage.quoteDialog().getByLabel("Preço")).toHaveCount(0);

  // Oracle: oil-quote — "A volume above 30 L warns": no card is priced yet.
  await conversasPage.quoteVolumeInput().fill("42");
  await conversasPage.quoteUseVolume().click();
  await expect(conversasPage.quoteStatus()).toContainText("Volume alto — confira antes de usar.");
  await expect(conversasPage.quoteDialog().getByLabel("Preço")).toHaveCount(0);

  // Oracle: oil-quote — "A confirmed high volume prices and can be kept": the prompt asks.
  await conversasPage.quoteUseHighVolume().click();
  await expect(conversasPage.saveFillPrompt()).toContainText("Guardar 42 L como volume da troca para os próximos orçamentos de");
  // Oracle: oil-quote — "Only this quote stores nothing".
  await conversasPage.saveFillPrompt().getByRole("button", { name: "Só neste orçamento" }).click();
  await expect(conversasPage.quoteDialog().getByText("Volume informado pelo atendente: 42 L")).toBeVisible();
  await expect(conversasPage.quoteDialog().getByLabel("Preço")).toBeVisible();
  expect(posts).toEqual([]);
  // D17: the warnings went through the one status element, never an alert.
  await expect(conversasPage.quoteDialog().getByRole("alert")).toHaveCount(0);
});

test("Tour Guiado: choosing a named engine sends the pick and shows the re-read with no range", async ({ conversasPage, page, mainPane }) => {
  const posts = await mockQuote(
    page,
    { status: "needs_clarification", coverage: "several", options: ["1.0 TSI", "1.4 TSI"] },
    {
      status: "researching",
      requestedAt: "2026-10-01T12:00:00.000Z",
      now: "2026-10-01T12:00:03.000Z",
      expectedMinutes: { min: 1, max: 2 },
      queuePosition: 0,
      path: "engine_pick",
      engine: "1.4 TSI",
      paused: null,
    },
  );
  await conversasPage.gotoConversation(E2E.tourConversationId);
  await mainPane();
  await conversasPage.quoteTriggerFor(POLO_LABEL).click();

  // Oracle: oil-quote — "Ambiguous engine is clarification": one button per engine, verbatim,
  // and the smaller fallback below them, a real button.
  await expect(conversasPage.quoteEngine("1.0 TSI")).toBeVisible();
  await expect(conversasPage.quoteNoneOfTheseEngines()).toBeVisible();

  await conversasPage.quoteEngine("1.4 TSI").click();

  // Oracle: oil-quote — "Choosing a named engine appends it and re-reads the source".
  await expect(conversasPage.quoteStatus()).toHaveText("Lendo a fonte para o motor 1.4 TSI…");
  await expect(conversasPage.quoteDialog().getByText(/pode levar entre/)).toHaveCount(0);
  await expect(conversasPage.quoteTimer()).toHaveText(/^Pesquisando há /);
  expect(posts.map((post) => post.body)).toEqual([{ engine: "1.4 TSI" }]);
});

test("Tour Guiado: a clarification naming no engine opens the vehicle's form on the version", async ({ conversasPage, page, mainPane }) => {
  const posts = await mockQuote(page, { status: "needs_clarification", coverage: "mismatch", options: [] });
  await conversasPage.gotoConversation(E2E.tourConversationId);
  await mainPane();
  await conversasPage.quoteTriggerFor(POLO_LABEL).click();

  await conversasPage.quoteDialog().getByRole("button", { name: "Corrigir versão do veículo", exact: true }).click();

  // Oracle: conversas — "Correcting the version opens the form".
  await expect(conversasPage.quoteDialog()).toHaveCount(0);
  const drillIn = page.getByRole("region", { name: "Veículo" });
  await expect(drillIn.getByLabel("Versão")).toBeFocused();
  await expect(drillIn.getByLabel("Versão")).toHaveValue(E2E.quoteVehicleVersion);
  expect(posts).toEqual([]);
});

test("Tour do Ator Coadjuvante: a grade-and-volume conflict asks for both, by keyboard alone", async ({ conversasPage, page, mainPane }) => {
  const posts = await mockQuote(page, GRADE_AND_VOLUME_CONFLICT);
  await conversasPage.gotoConversation(E2E.tourConversationId);
  await mainPane();
  await conversasPage.quoteTriggerFor(POLO_LABEL).click();

  // Oracle: oil-quote — "A grade conflict offers every grade's cards, each citing its source":
  // nothing selected, each grade cited to the source that lists it, with its class or tier.
  await expect(conversasPage.quoteStatus()).toHaveText(
    "As fontes consultadas discordam sobre a viscosidade deste veículo. Mostramos as opções de cada fonte — escolha a que vale para este carro.",
  );
  await expect(conversasPage.quoteGradeChoice("0W-20")).toHaveAttribute("aria-checked", "false");
  await expect(conversasPage.quoteGradeChoice("0W-20")).toContainText("Volkswagen, Manual do proprietário Polo 2021 (p. 287) — manual da montadora");
  await expect(conversasPage.quoteGradeChoice("5W-40")).toContainText("Lubrax, Guia de aplicação VW (p. 31) — guia de aplicação do fabricante de lubrificante");
  await expect(conversasPage.quoteSend()).toBeDisabled();

  // The keyboard alone: focus the grade group, then the arrow keys move the choice.
  await conversasPage.quoteGradeChoice("0W-20").focus();
  await page.keyboard.press("ArrowDown");
  await expect(conversasPage.quoteGradeChoice("5W-40")).toHaveAttribute("aria-checked", "true");
  await expect(conversasPage.quoteGradeChoice("5W-40")).toBeFocused();

  // Oracle: oil-quote — "Grade and volume both in conflict ask for both": no message yet.
  await expect(conversasPage.quoteMessage()).toHaveCount(0);
  await expect(conversasPage.quoteDialog().getByText("Preço: escolha o volume")).toBeVisible();
  await conversasPage.quoteVolumeChoice("3,6 L").focus();
  await page.keyboard.press("Space");
  await expect(conversasPage.quoteVolumeChoice("3,6 L")).toHaveAttribute("aria-checked", "true");
  await expect(conversasPage.quoteMessage()).toBeVisible();
  await expect(conversasPage.quoteMessage()).toHaveValue(/Motul 8100 X-cess 5W-40/);
  await expect(conversasPage.quoteMessage()).not.toHaveValue(/Mobil/);
  await expect(conversasPage.quoteSend()).toBeEnabled();
  expect(posts).toEqual([]);
});

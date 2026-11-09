/**
 * Tour log — Serviços (read-only list of Omie-owned service orders)
 *
 * Feature: `/servicos` — the unit-wide service list, its filters, its detail
 * pane, and the claim that the screen offers no write.
 *
 * Run report: `runs/2026-09-10-servicos-usuarios.md` (one drive covered this
 * screen and Usuários). Every step below was driven live through the Playwright
 * MCP first and is transcribed from the steps that succeeded there.
 *
 * Guidebook (openspec/specs/services/customer-services/spec.md):
 * - Standalone Serviços screen lists all customers' services
 * - Selecting a row shows its detail beside the list
 * - No search result is distinguished from an empty unit
 * - The screen offers no write
 *
 * Tours:
 * - Guiado (Negócio) — find a service and read it, which is what the screen is
 *   for.
 * - Rumo Errado (Decadente) — a search matching nothing must be distinguishable
 *   from a unit with nothing.
 * - Desinteressado (Hoteleiro) — the screen claims to be read-only; go looking
 *   for a write and fail to find one.
 *
 * Findings: no defect. One usability surprise in the run report — the detail's
 * `Abrir conversa` and `Programar mensagem` both navigate to a bare `/`, losing
 * the customer. Deliberately not asserted here: no scenario says where they
 * should land, so pinning today's `to="/"` would freeze the behaviour.
 *
 * Out of scope: paging (needs more rows than the seed carries), the `Situação`
 * return-state filter, and the two navigation links' destinations.
 */
import { ServicosPage } from "../pages/servicos-page.js";
import { E2E } from "../ids.js";
import { expect, test } from "./fixtures.js";

/** OS number of the seeded service, unique enough to search on. */
const SEEDED_OS = "e2e-omie-os-return";

/** A search term chosen so no seeded or demo service can match it. */
const NO_MATCH_TERM = "zzzz-nao-existe-servico";

test("Tour Guiado: find a service by its OS number and read its detail", async ({
  page,
  mainPane,
}) => {
  const servicos = new ServicosPage(page);
  await servicos.goto();
  await mainPane();

  // Oracle: customer-services — the screen lists services with a summary.
  await expect(servicos.heading()).toBeVisible();
  await expect(servicos.summary()).toBeVisible();
  await expect(servicos.rows().first()).toBeVisible();

  // Oracle: customer-services — the search matches the OS number.
  await servicos.searchField().fill(SEEDED_OS);
  await expect(servicos.rows()).toHaveCount(1);
  await expect(servicos.row(SEEDED_OS)).toBeVisible();

  // Oracle: customer-services — "Selecting a row shows its detail beside the
  // list". The list is still there; this is a detail pane, not a new screen.
  await servicos.row(SEEDED_OS).click();
  await expect(page.getByText(new RegExp(`OS ${SEEDED_OS}`)).first()).toBeVisible();
  await expect(page.getByText(E2E.tourVehicleAPlate).first()).toBeVisible();
  await expect(servicos.rows()).toHaveCount(1);
});

test("Tour do Desinteressado: the screen offers no way to change a service", async ({
  page,
  mainPane,
}) => {
  const servicos = new ServicosPage(page);
  await servicos.goto();
  await mainPane();

  await servicos.searchField().fill(SEEDED_OS);
  await servicos.row(SEEDED_OS).click();

  // Oracle: customer-services — "The screen offers no write". The note is the
  // stated half; the absence of a save control is the observable half.
  await expect(servicos.readOnlyNote()).toBeVisible();
  await expect(page.getByRole("button", { name: /Salvar|Editar|Excluir/ })).toHaveCount(0);
});

test("Tour do Rumo Errado: no search result names the filters, not an empty unit", async ({
  page,
  mainPane,
}) => {
  const servicos = new ServicosPage(page);
  await servicos.goto();
  await mainPane();

  // Read the populated state first, so the emptiness below is a change rather
  // than the state the screen was already in.
  await expect(servicos.rows().first()).toBeVisible();

  await servicos.searchField().fill(NO_MATCH_TERM);

  // Oracle: customer-services — "No search result is distinguished from an
  // empty unit". The copy names the filters as the cause, which is the
  // distinction; a bare "no services" would not be.
  await expect(servicos.rows()).toHaveCount(0);
  await expect(page.getByText("Nenhum serviço para esses filtros")).toBeVisible();
  await expect(page.getByText(/Ajuste a busca ou o período/)).toBeVisible();
  await mainPane();
});

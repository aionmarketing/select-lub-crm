/**
 * Tour log — Relatórios (period filters, KPI bands, empty period)
 *
 * Feature: the manager's dashboard — the period and dimension filters, the six
 * named regions of metrics, the clear control that counts what it clears, and
 * what the screen does when the cut is empty.
 *
 * Run report: `runs/2026-09-10-relatorios.md`. Every step below was driven live
 * through the Playwright MCP first and is transcribed from the steps that
 * succeeded there; nothing here asserts a value that the drive merely displayed.
 *
 * Guidebook (openspec/specs/reports/relatorios/spec.md):
 * - Manager can open Relatórios from the app
 * - Changing granularity reaggregates
 * - Granularity day week month without double-count
 * - A set filter is distinguishable
 * - Clear appears only when something is set, and counts what it clears
 * - Empty cut is not fake metrics
 * - The alert strip sits above the filters / The strip survives an empty cut
 * - Sections are named, not parked behind a disclosure
 * - The corner mark explains the metric
 * - The period table sits behind the Leads mark
 *
 * Tours:
 * - Guiado (Negócio) — a dashboard is read before it is used; walk the default
 *   period through every region.
 * - Colecionador (Turístico) — six regions, three tables, two KPI bands, a
 *   funnel; reaggregating is how you tell distinct outputs from one drawn six
 *   times.
 * - Rumo Errado (Decadente) — ask for a period with nothing in it; answering
 *   zero when you mean "no data" is a lie a manager acts on.
 * - Período Chuvoso (Hoteleiro) — set a filter, change your mind, clear it, and
 *   land exactly where you started.
 *
 * Findings: no defect. One surprise (the period is not counted among the
 * filters the clear control clears) in the run report. Nothing pinned in
 * production code. A later red of the Colecionador tour (2026-10-04) was the
 * fixture, not the screen: the seed put every conversation on one São Paulo
 * day, so the default period drew one daily bucket and the tour's
 * `dailyRows > 1` precondition could not hold. The seed now spreads three
 * days (`seed-novas.ts`, pinned by `seed-novas.test.ts`); the tour is unchanged.
 *
 * Out of scope: attribution-rule versioning (API-level, no control here), the
 * funnel's stage navigation and the origin table's row navigation, and the
 * comparison-period deltas — the seed spans a few days, so no previous period
 * exists to compare against.
 */
import { RelatoriosPage, RELATORIOS_REGIONS } from "../pages/relatorios-page.js";
import { expect, test } from "./fixtures.js";

/** A window chosen to contain nothing: the seed and demo data are far later. */
const EMPTY_PERIOD = { from: "2019-01-01", to: "2019-01-07" };

test("Tour Guiado: every region is named and drawn on the default period", async ({
  page,
  mainPane,
}) => {
  const relatorios = new RelatoriosPage(page);
  await relatorios.goto();
  await mainPane();
  await expect(relatorios.heading()).toBeVisible();

  // Oracle: relatorios — "Sections are named, not parked behind a disclosure".
  for (const region of RELATORIOS_REGIONS) {
    await expect(relatorios.region(region)).toBeVisible();
  }

  // Oracle: relatorios — the default cut draws metrics.
  await expect(relatorios.metricValues().first()).toBeVisible();

  // Oracle: relatorios — "Clear appears only when something is set". Nothing is
  // set yet, so the control must be absent rather than merely disabled.
  await expect(relatorios.clearFilters()).toHaveCount(0);

  // Oracle: relatorios — "The corner mark explains the metric".
  await expect(relatorios.explainer("Total de Leads")).toBeVisible();
});

test("Tour do Colecionador: a coarser granularity reaggregates without double-counting", async ({
  page,
  mainPane,
}) => {
  const relatorios = new RelatoriosPage(page);
  await relatorios.goto();
  await mainPane();

  // Oracle: relatorios — "The period table sits behind the Leads mark".
  await relatorios.explainer("Total de Leads").click();
  await expect(relatorios.periodTable()).toBeVisible();

  const dailyRows = await relatorios.periodRows().count();
  const leadsByDay = await relatorios.metricValues().first().innerText();
  expect(dailyRows).toBeGreaterThan(1);

  // Oracle: relatorios — "Changing granularity reaggregates".
  await relatorios.chooseOption(relatorios.granularidade(), "month");
  await expect.poll(() => relatorios.periodRows().count()).toBeLessThan(dailyRows);

  // Oracle: relatorios — "Granularity day week month without double-count".
  // The bucket count must fall while the total stays put; asserting the drive's
  // 3 → 1 and `6` would pin the fixture instead of the aggregation rule.
  await expect(relatorios.metricValues().first()).toHaveText(leadsByDay);
});

test("Tour em Período Chuvoso: a set filter is named, and clearing restores the cut", async ({
  page,
  mainPane,
}) => {
  const relatorios = new RelatoriosPage(page);
  await relatorios.goto();
  await mainPane();

  const before = await relatorios.metricValues().first().innerText();

  // Oracle: relatorios — "A set filter is distinguishable" and "The clear
  // control names the number of set filters".
  await relatorios.chooseOption(relatorios.origem(), "AD");
  await expect(relatorios.clearFilters()).toBeVisible();
  await expect(relatorios.clearFilters()).toHaveText(/1 filtro/);

  // The cut must actually move, or the restoration below proves nothing.
  await expect.poll(async () => relatorios.metricValues().first().innerText()).not.toBe(before);

  // Oracle: relatorios — clearing returns the screen to its unset state.
  await relatorios.clearFilters().click();
  await expect(relatorios.clearFilters()).toHaveCount(0);
  await expect.poll(async () => relatorios.metricValues().first().innerText()).toBe(before);
});

test("Tour do Rumo Errado: an empty period draws no metrics rather than zeros", async ({
  page,
  mainPane,
}) => {
  const relatorios = new RelatoriosPage(page);
  await relatorios.goto();
  await mainPane();

  // The populated default is read first so the emptiness below is a change,
  // not the state the screen was already in.
  await expect(relatorios.metricValues().first()).toBeVisible();

  await relatorios.setPeriod(EMPTY_PERIOD.from, EMPTY_PERIOD.to);

  // Oracle: relatorios — "Empty cut is not fake metrics". No cards at all: a
  // rendered `0` would be indistinguishable from a real zero.
  await expect(relatorios.emptyCut()).toBeVisible({ timeout: 15_000 });
  await expect(relatorios.metricValues()).toHaveCount(0);

  // Oracle: relatorios — "The strip survives an empty cut" and "The alert strip
  // sits above the filters". The strip reports now, not the cut.
  await expect(relatorios.region("Alertas de follow-up")).toBeVisible();
  await mainPane();
});

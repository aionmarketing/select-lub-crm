/**
 * Page object for the Relatórios dashboard at `/relatorios`.
 *
 * A filter bar over five named regions of metric cards. Every card carries an
 * explanation button named `O que é <metric>`, which is the most stable handle
 * on the screen: the metric *values* move with the seed and the clock, so a tour
 * asserts that a card is present and legible, never that it reads a given
 * number.
 *
 * `Início` and `Fim` are `input[type=date]` and so are located by label; the
 * four dropdowns are MUI selects and expose the `combobox` role.
 *
 * Oracle: openspec/specs/reports/relatorios/spec.md (Relatórios screen shows filters
 * summary and buckets; Primary KPI row with deltas; Alert strip navigates to
 * Follow-up).
 */
import type { Page } from "@playwright/test";

/** The dashboard's named regions, in the order the screen draws them. */
export const RELATORIOS_REGIONS = [
  "Alertas de follow-up",
  "Indicadores principais",
  "Funil de Vendas",
  "Tabela de Origem",
  "Atendimento e clientes",
  "Tags e mensagens programadas",
] as const;

/** Name of one Relatórios region. */
export type RelatoriosRegion = (typeof RELATORIOS_REGIONS)[number];

/** Locators for the `/relatorios` filters and metric regions. */
export class RelatoriosPage {
  /**
   * Binds locators to the Playwright page under test.
   * @param page - Browser tab hosting the CRM SPA.
   */
  constructor(private readonly page: Page) {}

  /**
   * Navigates to the Relatórios route.
   * @returns Playwright navigation promise for `/relatorios`.
   */
  goto() {
    return this.page.goto("/relatorios");
  }

  /**
   * Locator for the screen's level-1 heading.
   * @returns Playwright locator for the `Relatórios` heading.
   */
  heading() {
    return this.page.getByRole("heading", { level: 1, name: "Relatórios" });
  }

  /**
   * Locator for the period start filter.
   * @returns Playwright locator for the `Início` date field.
   */
  inicioField() {
    return this.page.getByLabel("Início", { exact: true });
  }

  /**
   * Locator for the period end filter.
   * @returns Playwright locator for the `Fim` date field.
   */
  fimField() {
    return this.page.getByLabel("Fim", { exact: true });
  }

  /**
   * Locator for the bucket-size selector.
   * @returns Playwright locator for the `Granularidade` select.
   */
  granularidade() {
    return this.page.getByRole("combobox", { name: "Granularidade" });
  }

  /**
   * Locator for the origin classification filter.
   * @returns Playwright locator for the `Origem` select.
   */
  origem() {
    return this.page.getByRole("combobox", { name: "Origem" });
  }

  /**
   * Locator for the tag filter, disabled while the unit has no tags.
   * @returns Playwright locator for the `Tag` select.
   */
  tag() {
    return this.page.getByRole("combobox", { name: "Tag" });
  }

  /**
   * Locator for the campaign filter.
   * @returns Playwright locator for the `Campanha/Anúncio` select.
   */
  campanha() {
    return this.page.getByRole("combobox", { name: "Campanha/Anúncio" });
  }

  /**
   * Locator for the clear-filters control, which the spec requires to appear
   * only when something is set and to name how many filters it clears.
   * @returns Playwright locator for the clear button.
   */
  clearFilters() {
    return this.page.getByRole("button", { name: /Limpar/ });
  }

  /**
   * Locator for one named region of the dashboard.
   * @param region - Region to locate.
   * @returns Playwright locator for that region.
   */
  region(region: RelatoriosRegion) {
    return this.page.getByRole("region", { name: region });
  }

  /**
   * Locator for a metric's explanation mark.
   * @param metric - Metric name as printed on its card.
   * @returns Playwright locator for the `O que é <metric>` button.
   */
  explainer(metric: string) {
    return this.page.getByRole("button", { name: `O que é ${metric}` });
  }

  /**
   * Locator for every metric value rendered on the screen.
   * @returns Playwright locator for `data-testid="metric-value"`.
   */
  metricValues() {
    return this.page.getByTestId("metric-value");
  }

  /**
   * Locator for the follow-up alert strip's chips.
   * @returns Playwright locator for the chips inside the alert region.
   */
  alertChips() {
    return this.region("Alertas de follow-up").getByRole("button");
  }

  /**
   * Locator for the per-period bucket table behind the Leads mark.
   * @returns Playwright locator for the `Conversas por período` table.
   */
  periodTable() {
    return this.page.getByRole("table", { name: "Conversas por período" });
  }

  /**
   * Counts the data rows of the per-period table.
   * @returns Number of bucket rows currently drawn.
   */
  periodRows() {
    return this.periodTable().locator("tbody tr");
  }

  /**
   * Locator for the explicit empty-cut statement.
   * @returns Playwright locator for the no-data line.
   */
  emptyCut() {
    return this.page.getByText(/Nenhuma conversa no recorte selecionado/);
  }

  /**
   * Chooses a value in one of the dashboard's MUI selects.
   *
   * The options render in a portal outside the select, so the choice is made in
   * two steps rather than with `selectOption` — these are comboboxes, not
   * native `<select>` elements.
   * @param combobox - Locator for the select to open.
   * @param value - The option's `data-value` (e.g. `month`, `AD`).
   * @returns Promise resolving once the option has been chosen.
   */
  async chooseOption(combobox: ReturnType<RelatoriosPage["granularidade"]>, value: string) {
    await combobox.click();
    await this.page.locator(`[role="option"][data-value="${value}"]`).click();
  }

  /**
   * Sets the reporting period.
   *
   * `input[type=date]` is filled directly; both ends are set before the screen
   * is read, since each change refetches.
   * @param from - Start date as `YYYY-MM-DD`.
   * @param to - End date as `YYYY-MM-DD`.
   * @returns Promise resolving once both fields hold the new values.
   */
  async setPeriod(from: string, to: string) {
    await this.inicioField().fill(from);
    await this.fimField().fill(to);
  }
}

/**
 * Page object for the read-only Serviços list at `/servicos`.
 *
 * The screen is a filter bar over a list of service rows plus a detail pane;
 * every OS is owned by Omie, so the only writes reachable from here are the two
 * links back into Conversas. Rows are buttons whose accessible name is the whole
 * card text (date, amount, customer, vehicle, OS), which is what lets a tour
 * find a seeded service by its OS number without a `data-testid`.
 *
 * The `De` and `Até` filters are `input[type=date]`, which has no `textbox`
 * role, so they are located by label rather than by role — the one place on this
 * screen where the two differ.
 *
 * Oracle: openspec/specs/services/customer-services/spec.md (service list and detail are
 * read-only mirrors of Omie).
 */
import type { Page } from "@playwright/test";

/** Locators for the `/servicos` list and its detail pane. */
export class ServicosPage {
  /**
   * Binds locators to the Playwright page under test.
   * @param page - Browser tab hosting the CRM SPA.
   */
  constructor(private readonly page: Page) {}

  /**
   * Navigates to the Serviços route.
   * @returns Playwright navigation promise for `/servicos`.
   */
  goto() {
    return this.page.goto("/servicos");
  }

  /**
   * Locator for the screen's level-1 heading.
   * @returns Playwright locator for the `Serviços` heading.
   */
  heading() {
    return this.page.getByRole("heading", { level: 1, name: "Serviços" });
  }

  /**
   * Locator for the count-and-total summary under the heading.
   *
   * Matched by shape (`N serviços · R$ …`) rather than by a frozen value: the
   * seed and the demo dataset both feed this line, so asserting the number
   * would pin the fixture instead of the behaviour.
   * @returns Playwright locator for the summary paragraph.
   */
  summary() {
    return this.page.getByText(/\d+ serviços? · R\$/);
  }

  /**
   * Locator for the free-text filter over customer, plate, and OS number.
   * @returns Playwright locator for the search field.
   */
  searchField() {
    return this.page.getByRole("textbox", { name: "Cliente, placa ou OS" });
  }

  /**
   * Locator for the period start filter.
   * @returns Playwright locator for the `De` date field.
   */
  fromField() {
    return this.page.getByLabel("De", { exact: true });
  }

  /**
   * Locator for the period end filter.
   * @returns Playwright locator for the `Até` date field.
   */
  toField() {
    return this.page.getByLabel("Até", { exact: true });
  }

  /**
   * Locator for the vehicle-return state filter.
   * @returns Playwright locator for the `Situação` select.
   */
  situacaoFilter() {
    return this.page.getByRole("combobox", { name: "Situação" });
  }

  /**
   * Locator for every service row currently listed.
   * @returns Playwright locator matching all row buttons.
   */
  rows() {
    return this.page.getByRole("button", { name: /· OS / });
  }

  /**
   * Locator for the row carrying a given Omie OS number.
   * @param osNumber - OS identifier as printed on the row (`OS <number>`).
   * @returns Playwright locator for that row button.
   */
  row(osNumber: string) {
    return this.page.getByRole("button", { name: new RegExp(`OS ${osNumber}\\b`) });
  }

  /**
   * Locator for the detail pane's link back to the customer's conversation.
   * @returns Playwright locator for the `Abrir conversa` link.
   */
  abrirConversa() {
    return this.page.getByRole("link", { name: "Abrir conversa" });
  }

  /**
   * Locator for the detail pane's link into the schedule flow.
   * @returns Playwright locator for the `Programar mensagem` link.
   */
  programarMensagem() {
    return this.page.getByRole("link", { name: "Programar mensagem" });
  }

  /**
   * Locator for the note stating the screen never writes to the OS.
   * @returns Playwright locator for the read-only note.
   */
  readOnlyNote() {
    return this.page.getByText("Somente leitura — a OS é mantida no Omie");
  }
}

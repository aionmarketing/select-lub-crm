/**
 * Page object for the Configurações catalogs at `/configuracoes`.
 *
 * Two named regions — Tags and Templates — each a card holding a create form
 * above its list. The spec requires an empty catalog to keep its form, so the
 * form locators must not be scoped to "there is a list"; they are scoped to the
 * region instead, which holds in both states.
 *
 * Oracle: openspec/specs/conversations/tags-templates/spec.md (Configurações catalogs screen;
 * Tags persist per unit; Templates persist per unit; Tag and template HTTP CRUD).
 */
import type { Page } from "@playwright/test";

/** Locators for the `/configuracoes` tag and template catalogs. */
export class ConfiguracoesPage {
  /**
   * Binds locators to the Playwright page under test.
   * @param page - Browser tab hosting the CRM SPA.
   */
  constructor(private readonly page: Page) {}

  /**
   * Navigates to the Configurações route.
   * @returns Playwright navigation promise for `/configuracoes`.
   */
  goto() {
    return this.page.goto("/configuracoes");
  }

  /**
   * Locator for the screen's level-1 heading.
   * @returns Playwright locator for the `Configurações` heading.
   */
  heading() {
    return this.page.getByRole("heading", { level: 1, name: "Configurações" });
  }

  /**
   * Locator for the Tags catalog region.
   * @returns Playwright locator for the `Tags` region.
   */
  tagsCard() {
    return this.page.getByRole("region", { name: "Tags" });
  }

  /**
   * Locator for the Templates catalog region.
   * @returns Playwright locator for the `Templates` region.
   */
  templatesCard() {
    return this.page.getByRole("region", { name: "Templates" });
  }

  /**
   * Locator for the new tag's name field.
   * @returns Playwright locator for the `Nome da tag` textbox.
   */
  tagNameField() {
    return this.tagsCard().getByRole("textbox", { name: "Nome da tag" });
  }

  /**
   * Locator for the new tag's colour select.
   * @returns Playwright locator for the `Cor` combobox.
   */
  tagColorField() {
    return this.tagsCard().getByRole("combobox", { name: "Cor" });
  }

  /**
   * Locator for the tag create submit.
   * @returns Playwright locator for the `Criar tag` button.
   */
  createTagButton() {
    return this.tagsCard().getByRole("button", { name: "Criar tag" });
  }

  /**
   * Locator for the Tags catalog's empty state.
   * @returns Playwright locator for the `Nenhuma tag cadastrada` paragraph.
   */
  tagsEmptyState() {
    return this.tagsCard().getByText("Nenhuma tag cadastrada");
  }

  /**
   * Locator for a listed tag by its name.
   * @param name - Tag name as created.
   * @returns Playwright locator for that tag's row inside the Tags card.
   */
  tagRow(name: string) {
    return this.tagsCard().getByText(name, { exact: true });
  }

  /**
   * Locator for the new template's name field.
   * @returns Playwright locator for the `Nome do template` textbox.
   */
  templateNameField() {
    return this.templatesCard().getByRole("textbox", { name: "Nome do template" });
  }

  /**
   * Locator for the new template's body field.
   * @returns Playwright locator for the `Texto` textbox.
   */
  templateTextField() {
    return this.templatesCard().getByRole("textbox", { name: "Texto" });
  }

  /**
   * Locator for the template create submit.
   * @returns Playwright locator for the `Criar template` button.
   */
  createTemplateButton() {
    return this.templatesCard().getByRole("button", { name: "Criar template" });
  }

  /**
   * Locator for the Templates catalog's empty state.
   * @returns Playwright locator for the `Nenhum template cadastrado` paragraph.
   */
  templatesEmptyState() {
    return this.templatesCard().getByText("Nenhum template cadastrado");
  }

  /**
   * Locator for a listed template by its name.
   * @param name - Template name as created.
   * @returns Playwright locator for that template's row inside the card.
   */
  templateRow(name: string) {
    return this.templatesCard().getByText(name, { exact: true });
  }

  // --- Per-row controls (added for task 5.9's tour) ---

  /**
   * Locator for the innermost row element carrying a catalog entry's name.
   *
   * Row controls (`Editar`, `Desativar`, `Reativar`) render with identical
   * accessible names on every row, so nothing but structure distinguishes one
   * row's control from another's. Matches come back in document order, so the
   * last container that holds both the name and a control is the row itself.
   * @param card - The catalog card to search within.
   * @param name - Entry name as listed.
   * @returns Locator for that entry's row.
   */
  private entryRow(card: ReturnType<ConfiguracoesPage["tagsCard"]>, name: string) {
    return card
      .locator("div")
      .filter({ hasText: name })
      .filter({ has: this.page.getByRole("button", { name: /Desativar|Reativar/ }) })
      .last();
  }

  /**
   * Locator for a tag row's deactivate control.
   * @param name - Tag name as listed.
   * @returns Locator for that row's `Desativar` button.
   */
  deactivateTag(name: string) {
    return this.entryRow(this.tagsCard(), name).getByRole("button", { name: "Desativar" });
  }

  /**
   * Locator for a tag row's reactivate control, present once deactivated.
   * @param name - Tag name as listed.
   * @returns Locator for that row's `Reativar` button.
   */
  reactivateTag(name: string) {
    return this.entryRow(this.tagsCard(), name).getByRole("button", { name: "Reativar" });
  }

  /**
   * Locator for the inactive marker on a deactivated tag row.
   * @param name - Tag name as listed.
   * @returns Locator for the row's `Inativa` marker.
   */
  tagInactiveMark(name: string) {
    return this.entryRow(this.tagsCard(), name).getByText("Inativa");
  }

  /**
   * Locator for every tag row's edit control, used to count catalog entries.
   * @returns Locator matching one control per listed tag.
   */
  tagEntries() {
    return this.tagsCard().getByRole("button", { name: "Editar" });
  }

  /**
   * Locator for every template row's edit control.
   * @returns Locator matching one control per listed template.
   */
  templateEntries() {
    return this.templatesCard().getByRole("button", { name: "Editar" });
  }
}

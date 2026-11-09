/**
 * Page object for the Usuários team screen at `/usuarios`.
 *
 * A `Equipe` table of users and their units above a `Criar usuário` card. Rows
 * are located by the user's e-mail rather than their display name: e-mail is the
 * unique key the API enforces (duplicate e-mail is 409), while two people may
 * share a name.
 *
 * Note for tours: creating a user here creates a real Supabase Auth account, and
 * the tour stack shares the project's Supabase. A tour therefore exercises unit
 * attachment on the *seeded* users and the refusal paths of the create form, and
 * never completes a create with a fresh e-mail.
 *
 * Oracle: openspec/specs/accounts/auth/spec.md (Admin can create users and attach units;
 * Users and units are listable for the Usuários screen).
 */
import type { Page } from "@playwright/test";

/** Locators for the `/usuarios` team table and create form. */
export class UsuariosPage {
  /**
   * Binds locators to the Playwright page under test.
   * @param page - Browser tab hosting the CRM SPA.
   */
  constructor(private readonly page: Page) {}

  /**
   * Navigates to the Usuários route.
   * @returns Playwright navigation promise for `/usuarios`.
   */
  goto() {
    return this.page.goto("/usuarios");
  }

  /**
   * Locator for the screen's level-1 heading.
   * @returns Playwright locator for the `Usuários` heading.
   */
  heading() {
    return this.page.getByRole("heading", { level: 1, name: "Usuários" });
  }

  /**
   * Locator for the team table.
   * @returns Playwright locator for the `Usuários` table.
   */
  teamTable() {
    return this.page.getByRole("table", { name: "Usuários" });
  }

  /**
   * Locator for the table's loading state.
   * @returns Playwright locator for the `Carregando usuários` status.
   */
  loading() {
    return this.page.getByRole("status", { name: "Carregando usuários" });
  }

  /**
   * Locator for every data row in the team table.
   * @returns Playwright locator matching the body rows.
   */
  rows() {
    return this.teamTable().locator("tbody tr");
  }

  /**
   * Locator for the row of a given user.
   * @param email - The user's e-mail as listed.
   * @returns Playwright locator for that row.
   */
  row(email: string) {
    return this.teamTable().getByRole("row").filter({ hasText: email });
  }

  /**
   * Locator for a row's unit-editing control.
   * @param email - The user's e-mail as listed.
   * @returns Playwright locator for that row's `Editar unidades` button.
   */
  editUnitsButton(email: string) {
    return this.row(email).getByRole("button", { name: "Editar unidades" });
  }

  /**
   * Locator for the unit-editing dialog opened from a row.
   * @returns Playwright locator for the dialog.
   */
  editDialog() {
    return this.page.getByRole("dialog");
  }

  /**
   * Locator for one unit toggle inside the edit dialog.
   * @param unitName - Unit name as displayed.
   * @returns Playwright locator for that toggle.
   */
  unitToggle(unitName: string) {
    return this.editDialog().getByRole("button", { name: unitName });
  }

  /**
   * Locator for the edit dialog's cancel control.
   * @returns Playwright locator for the `Cancelar` button.
   */
  cancelEdit() {
    return this.editDialog().getByRole("button", { name: "Cancelar" });
  }

  /**
   * Locator for the create form's name field.
   * @returns Playwright locator for the `Nome` textbox.
   */
  nameField() {
    return this.page.getByRole("textbox", { name: "Nome", exact: true });
  }

  /**
   * Locator for the create form's e-mail field.
   * @returns Playwright locator for the `E-mail` textbox.
   */
  emailField() {
    return this.page.getByRole("textbox", { name: "E-mail" });
  }

  /**
   * Locator for the create form's password field.
   * @returns Playwright locator for the `Senha` field.
   */
  passwordField() {
    return this.page.getByLabel("Senha", { exact: true });
  }

  /**
   * Locator for the create form's submit.
   * @returns Playwright locator for the `Criar usuário` button.
   */
  createButton() {
    return this.page.getByRole("button", { name: "Criar usuário", exact: true });
  }
}

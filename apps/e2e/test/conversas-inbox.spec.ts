/**
 * Test design (testing-strategy + testing-playwright)
 *
 * Setup: Playwright Chromium against API + Vite. Auto-login env required.
 * No worker, no Evolution.
 *
 * Oracle: repo-foundation "Auto-login lands on the Conversas inbox".
 *
 * Axes: session hydrated vs login-failed (this spec samples hydrated).
 * Locators: conversas-inbox test id. No XPath, no waitForTimeout.
 *
 * Out of scope: empty/error inbox copy variants (component tests).
 */
import { expect, test } from "./fixtures.js";

test("auto-login lands on Conversas with a visible inbox", async ({ conversasPage, page }) => {
  await conversasPage.goto();

  await expect(conversasPage.inbox()).toBeVisible();
  await expect(page.getByRole("form", { name: /login/i })).toHaveCount(0);
  await expect(page.getByText("Não foi possível entrar. Verifique o e-mail e a senha.")).toHaveCount(0);
});

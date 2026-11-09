/**
 * Oracle: auth — "Login screen" (the SPA has no credential form; it signs in
 *   with the build's MVP credentials or shows a Portuguese error) and deploy —
 *   "Published origins are verified by a read-only remote smoke run" /
 *   "Login works against the published environment".
 *
 * Why this is not redundant with the health check: the MVP credentials are
 * inlined into the bundle at BUILD time. A deploy that forgot them produces an
 * image whose /health is perfectly correct and whose link cannot sign anyone
 * in. Only loading the page catches that.
 */
import { expect, test } from "./fixtures.js";

test("opening the published link reaches Conversas without a credential form", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByTestId("conversas-inbox")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("heading", { name: "Entrar" })).toHaveCount(0);
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
});

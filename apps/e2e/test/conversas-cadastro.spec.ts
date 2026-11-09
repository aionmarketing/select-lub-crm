/**
 * Test design (testing-strategy + testing-playwright)
 *
 * Setup: SQL-seeded conversation whose customer name is null; rail save via
 * PATCH customer. No WhatsApp send on save.
 *
 * Oracle: conversas contact label (name or phone) + cadastro rail save +
 * repo-foundation nameless / cadastro-save scenarios.
 *
 * Out of scope: Omie pending resolve; prefill accept-all.
 */
import { expect, test } from "./fixtures.js";
import { E2E } from "./ids.js";

test("nameless customer is labelled by phone, not Omie", async ({ conversasPage, page }) => {
  await conversasPage.goto();
  await conversasPage.inbox().waitFor();

  const row = conversasPage.listItem(E2E.namelessPhone);
  await expect(row).toBeVisible();
  await expect(row).not.toContainText("Omie");
  await row.click();
  await expect(page.getByText(E2E.namelessPhone).first()).toBeVisible();
  await expect(page.getByText("Omie")).toHaveCount(0);
});

test("cadastro save from the rail persists and does not send WhatsApp", async ({
  conversasPage,
  crmApi,
  page,
}) => {
  await conversasPage.goto();
  await conversasPage.inbox().waitFor();
  await conversasPage.listItem(E2E.cadastroPhone).click();
  await conversasPage.cadastroEdit().click();
  await conversasPage.cadastroName().fill(E2E.cadastroName);
  await conversasPage.cadastroSave().click();

  await expect(page.getByText(E2E.cadastroName).first()).toBeVisible();
  await expect(page.getByText(/enviad[oa] no WhatsApp/i)).toHaveCount(0);

  const loaded = await crmApi.get(`/conversations/${E2E.cadastroConversationId}/customer`);
  expect(loaded.ok()).toBe(true);
  const body = (await loaded.json()) as { customer: { name: string | null } | null };
  expect(body.customer?.name).toBe(E2E.cadastroName);
});

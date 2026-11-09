/**
 * Test design (testing-strategy + testing-playwright)
 *
 * Setup: SQL-seeded service with no non-cancelled schedule, and one with a
 * non-cancelled schedule, on e2e-conv-schedule. Channel CONNECTED via mock.
 * Worker not started.
 *
 * Oracle: conversas Programar mensagem confirm-does-not-send-now + occupied
 * service (Este serviço já tem uma mensagem programada.).
 *
 * Locators: conversas-programar-free / occupied + data-service-id +
 * conversas-schedule-confirm; dialog fields labeled Data and Hora (not a
 * combined datetime-local).
 * Out of scope: channel-down schedule; due dispatch (worker).
 */
import { expect, test } from "./fixtures.js";
import { E2E } from "./ids.js";

test("Programar mensagem confirm creates a schedule without sending now", async ({
  conversasPage,
  crmApi,
  page,
}) => {
  await conversasPage.goto();
  await conversasPage.inbox().waitFor();
  await conversasPage.listConversation(E2E.scheduleConversationId).click();

  await conversasPage.programarFree(E2E.freeServiceId).click();
  await expect(page.getByRole("dialog", { name: "Programar mensagem" })).toBeVisible();
  // Two fields, as the canvas draws them — leftover `Data e hora` was the
  // combined `datetime-local` the form no longer has. Wait until the suggest
  // query fills both; they open empty with "Carregando data sugerida".
  await expect(conversasPage.scheduleDate()).not.toHaveValue("");
  await expect(conversasPage.scheduleTime()).not.toHaveValue("");
  await conversasPage.scheduleText().fill("Retorno e2e combinado");
  const confirm = conversasPage.scheduleConfirm();
  await expect(confirm).toBeEnabled();
  await confirm.click();

  // WAIT ON THE SIGNAL, not on luck. `createSchedule.mutate()` is fire-and-
  // forget, and the dialog's `onSuccess` closes it — so the dialog going away
  // IS the app saying the POST resolved. This used to assert the dialog was
  // still VISIBLE, which is the in-flight state: it passed instantly, every
  // time, and the API read below then raced a request that had not landed.
  // Measured over 24 runs, that race was the single most frequent failure in
  // the suite (11 of 15 failures of this spec, at the `.toBe(true)` below);
  // the visible-assertion itself never once failed, which is exactly what a
  // vacuous assertion looks like.
  await expect(page.getByRole("dialog", { name: "Programar mensagem" })).toBeHidden();
  await expect(page.getByText(/já enviad/i)).toHaveCount(0);

  const listed = await crmApi.get(`/conversations/${E2E.scheduleConversationId}/scheduled-messages`);
  expect(listed.ok()).toBe(true);
  const rows = (await listed.json()) as Array<{ serviceId: string | null; status: string; text: string }>;
  expect(
    rows.some(
      (row) =>
        row.serviceId === E2E.freeServiceId &&
        row.status === "SCHEDULED" &&
        row.text === "Retorno e2e combinado",
    ),
  ).toBe(true);
});

test("occupied service opens the form and blocks Confirmar", async ({ conversasPage, page }) => {
  await conversasPage.goto();
  await conversasPage.inbox().waitFor();
  await conversasPage.listConversation(E2E.scheduleConversationId).click();

  await conversasPage.programarOccupied(E2E.occupiedServiceId).click();
  const dialog = page.getByRole("dialog", { name: "Programar mensagem" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Este serviço já tem uma mensagem programada.")).toBeVisible();
  await expect(conversasPage.scheduleConfirm()).toBeDisabled();
});

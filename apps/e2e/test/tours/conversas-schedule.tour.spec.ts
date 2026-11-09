/**
 * Tour log — Programar mensagem (Conversas)
 *
 * Feature: the schedule dialog on the Conversas contact rail — confirming a
 * future message without sending it, the occupied-service block, and cancel.
 *
 * Run report: `runs/2026-09-10-conversas-schedule.md`. Every step below was
 * driven live in a browser first and is transcribed from the steps that
 * succeeded there; nothing here asserts a value that the drive merely displayed.
 *
 * Guidebook (openspec/specs/repo-foundation/spec.md — Critical attendant flows
 * have Playwright coverage):
 * - Programar mensagem confirm does not send now
 * - Occupied service blocks confirm and still allows cancel
 *
 * Tours:
 * - Guiado (Negócio) — walk the guidebook in order; this feature's value is that
 *   confirming does not send, and nothing had driven that end to end.
 * - Rumo Errado (Decadente) — the dialog has a blocked state, and blocked states
 *   leak when legal actions arrive in an illegal order.
 * - Obsessivo-Compulsivo (Decadente) — confirm writes a row, so repetition
 *   before confirming is how a duplicate would appear.
 * - Período Chuvoso (Hoteleiro) — the form is long enough to abandon halfway;
 *   Escape must leave no partial schedule.
 *
 * Findings: no defect. One surprise (`conversas-schedule.spec.ts` asserts a
 * dialog mid-close — green today, brittle to a transition change) and one
 * tooling note, both in the run report. Nothing pinned in production code.
 *
 * Out of scope: due dispatch (worker — `test/live/`), channel-down scheduling,
 * mid-form navigation to another conversation (the modal backdrop makes it
 * unreachable by clicking; see the run report's Diagnosis), Tour do Colecionador
 * (this dialog has two outcomes, not many).
 */
import { E2E } from "../ids.js";
import { expect, test } from "./fixtures.js";

const SCHEDULE_DIALOG = "Programar mensagem";
const OCCUPIED_REASON = "Este serviço já tem uma mensagem programada.";

/** Shape of one row from `GET /conversations/:id/scheduled-messages`. */
type ScheduleRow = { serviceId: string | null; status: string; text: string };

/**
 * Reads the toured conversation's schedules straight from the API.
 * @param crmApi - Authed request context from the default fixtures
 * @returns Every scheduled message on the schedule fixture conversation
 */
async function scheduleRows(crmApi: {
  get: (url: string) => Promise<{ ok: () => boolean; json: () => Promise<unknown> }>;
}) {
  const response = await crmApi.get(
    `/conversations/${E2E.scheduleConversationId}/scheduled-messages`,
  );
  expect(response.ok()).toBe(true);
  return (await response.json()) as ScheduleRow[];
}

test("Tour Guiado: confirm schedules the service without claiming a send", async ({
  conversasPage,
  crmApi,
  page,
  mainPane,
}) => {
  await conversasPage.goto();
  await conversasPage.inbox().waitFor();
  await mainPane();

  await conversasPage.gotoConversation(E2E.scheduleConversationId);
  await conversasPage.programarFree(E2E.freeServiceId).click();

  const dialog = page.getByRole("dialog", { name: SCHEDULE_DIALOG });
  await expect(dialog).toBeVisible();

  // Drive step 4: the dialog opens with the date suggestion still loading and
  // Confirmar unavailable until a text exists. Waiting on the values is what
  // makes the confirm below deterministic.
  await expect(conversasPage.scheduleDate()).not.toHaveValue("");
  await expect(conversasPage.scheduleTime()).not.toHaveValue("");
  await expect(conversasPage.scheduleConfirm()).toBeDisabled();

  const body = "Tour Guiado retorno combinado";
  await conversasPage.scheduleText().fill(body);
  await expect(conversasPage.scheduleConfirm()).toBeEnabled();
  await conversasPage.scheduleConfirm().click();

  // Oracle: "the composer does not show the text as already sent on WhatsApp".
  await expect(page.getByText(/já enviad/i)).toHaveCount(0);

  // Oracle: "a ScheduledMessage exists for that service".
  await expect
    .poll(async () =>
      (await scheduleRows(crmApi)).some(
        (row) =>
          row.serviceId === E2E.freeServiceId && row.status === "SCHEDULED" && row.text === body,
      ),
    )
    .toBe(true);

  // Drive step 7: the service flips to the occupied control once it holds a
  // non-cancelled schedule. The drive found this, and it is what makes the
  // occupied tour below reachable without a second fixture.
  await expect(conversasPage.programarOccupied(E2E.freeServiceId)).toBeVisible();
});

test("Tour Guiado: an occupied service opens the form and blocks Confirmar", async ({
  conversasPage,
  page,
}) => {
  await conversasPage.gotoConversation(E2E.scheduleConversationId);
  await conversasPage.programarOccupied(E2E.occupiedServiceId).click();

  const dialog = page.getByRole("dialog", { name: SCHEDULE_DIALOG });
  // Oracle: the form still opens so the attendant can cancel, Confirmar is
  // unavailable, and the Portuguese reason is shown.
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(OCCUPIED_REASON)).toBeVisible();
  await expect(conversasPage.scheduleConfirm()).toBeDisabled();
});

test("Tour em Período Chuvoso: Escape mid-form leaves no schedule behind", async ({
  conversasPage,
  crmApi,
  page,
}) => {
  await conversasPage.gotoConversation(E2E.scheduleConversationId);
  const before = await scheduleRows(crmApi);

  await conversasPage.programarFree(E2E.freeServiceId).click();
  const dialog = page.getByRole("dialog", { name: SCHEDULE_DIALOG });
  await expect(dialog).toBeVisible();
  await conversasPage.scheduleText().fill("Periodo Chuvoso abandonado");
  await page.keyboard.press("Escape");

  await expect(dialog).toBeHidden();
  // Abandoning the form must write nothing and must leave the thread usable:
  // the row count is unchanged and the composer is still there and empty.
  expect(await scheduleRows(crmApi)).toHaveLength(before.length);
  await expect(conversasPage.composer()).toBeVisible();
  await expect(conversasPage.composer()).toHaveValue("");
  await expect(conversasPage.programarFree(E2E.freeServiceId)).toBeVisible();
});

test("Tour Obsessivo-Compulsivo: five open-and-abandon cycles still schedule once", async ({
  conversasPage,
  crmApi,
  page,
}) => {
  await conversasPage.gotoConversation(E2E.scheduleConversationId);
  const dialog = page.getByRole("dialog", { name: SCHEDULE_DIALOG });

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await conversasPage.programarFree(E2E.freeServiceId).click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  }

  await conversasPage.programarFree(E2E.freeServiceId).click();
  await expect(dialog).toBeVisible();
  const body = "Obsessivo Compulsivo uma vez";
  await conversasPage.scheduleText().fill(body);
  await conversasPage.scheduleConfirm().click();

  // The point of the tour: repetition before the write must not accumulate
  // rows. Exactly one non-cancelled schedule on that service, not "at least".
  await expect
    .poll(async () =>
      (await scheduleRows(crmApi)).filter(
        (row) => row.serviceId === E2E.freeServiceId && row.status === "SCHEDULED",
      ).length,
    )
    .toBe(1);
  const rows = await scheduleRows(crmApi);
  expect(
    rows.filter((row) => row.serviceId === E2E.freeServiceId && row.status === "SCHEDULED")[0].text,
  ).toBe(body);
});

test("Tour do Rumo Errado: a blocked Confirmar and a modal that refuses to be bypassed", async ({
  conversasPage,
  crmApi,
  page,
}) => {
  await conversasPage.gotoConversation(E2E.scheduleConversationId);
  const before = await scheduleRows(crmApi);

  await conversasPage.programarOccupied(E2E.occupiedServiceId).click();
  const dialog = page.getByRole("dialog", { name: SCHEDULE_DIALOG });
  await expect(dialog).toBeVisible();

  // Illegal action #1: press the control the spec says is unavailable. `force`
  // because a disabled button rejects an ordinary click — the tour is asking
  // what happens when someone gets the click through anyway.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await conversasPage.scheduleConfirm().click({ force: true });
  }
  expect(await scheduleRows(crmApi)).toHaveLength(before.length);

  // Illegal action #2: change conversation while the form is open. The drive
  // found the modal backdrop absorbs the click, so the switch never happens —
  // this asserts that refusal, which is what the app actually does, rather than
  // the mid-form navigation the tour set out to reach.
  await conversasPage.listConversation(E2E.sendConversationId).click({ force: true });
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/conversation=e2e-conv-schedule/);
  expect(await scheduleRows(crmApi)).toHaveLength(before.length);
});

/**
 * Tour log — Services, vehicle drill-ins, returns and reminders
 *
 * Feature: the service side of the contact rail — the services preview, the
 * vehicle drill-in and its per-vehicle history, the service drill-in — plus the
 * vehicle return those services produce and the reminder form on Follow-up.
 *
 * Run report: `runs/2026-09-10-conversas-services.md`. Every step below was
 * driven live through the Playwright MCP first and is transcribed from the steps
 * that succeeded there; nothing here asserts a value that the drive merely
 * displayed.
 *
 * Guidebook:
 * - openspec/specs/conversations/conversas/spec.md — Vehicle row opens the Veículo drill-in;
 *   Drill-in shows that vehicle's services only; Back restores the profile
 *   stack; No services is an empty state
 * - openspec/specs/conversations/follow-up/spec.md — The form opens without leaving Follow-up;
 *   Prefill comes from the return; Overdue return defaults ahead of today; Blank
 *   body takes the composed default; Criar lembrete stays available when
 *   reminders exist; The planned summary updates without a reload
 *
 * Tours:
 * - Guiado (Negócio) — rail → vehicle → service, the drill-down that answers
 *   "when was this car last in".
 * - Colecionador (Turístico) — several distinct outputs: a vehicle with
 *   history, one without, a service detail, a return, a reminder summary.
 * - Rumo Errado (Decadente) — the vehicle with no services must state its own
 *   emptiness and must not borrow the other vehicle's history.
 * - Período Chuvoso (Hoteleiro) — the reminder form commits scheduled messages;
 *   abandoning it must leave the return untouched.
 *
 * Findings: no defect. Two notes in the run report — the rail's service
 * drill-in carries no return date (the return lives on Follow-up), and
 * Follow-up counts moved during the session on an unchanged database, which is
 * why nothing here asserts a literal count. One fixture fix (the seed now
 * clears scheduled messages a reminder tour creates). Nothing pinned in
 * production code.
 *
 * Out of scope: archiving a return and the section counts contract (the
 * Follow-up tour), the schedule dialog on this same rail (already covered by
 * `conversas-schedule.tour.spec.ts`), and reminder dispatch — the tour stack
 * runs no worker, so a reminder is written and never fires.
 */
import { FollowUpPage } from "../pages/follow-up-page.js";
import { E2E } from "../ids.js";
import { expect, test } from "./fixtures.js";

/** Description of the seeded service on vehicle A. */
const SERVICE_DESCRIPTION = "Troca de óleo e2e retorno";

test("Tour Guiado: rail to vehicle to service", async ({ conversasPage, page, mainPane }) => {
  await conversasPage.gotoConversation(E2E.tourConversationId);
  await mainPane();

  // Oracle: conversas — the rail previews the customer's services.
  await expect(conversasPage.serviceRow(SERVICE_DESCRIPTION)).toBeVisible();

  // Oracle: conversas — "Vehicle row opens the Veículo drill-in".
  await conversasPage.vehicleRow(E2E.tourVehicleAPlate).first().click();
  await expect(conversasPage.drillInTitle(E2E.tourVehicleAPlate)).toBeVisible();
  await expect(page.getByText("Histórico de serviços")).toBeVisible();
  await expect(page.getByText(SERVICE_DESCRIPTION).first()).toBeVisible();

  // Oracle: conversas — "Back restores the profile stack". Both vehicles and
  // the add control are back, which is what "the stack" means here.
  await conversasPage.railBack().click();
  await expect(conversasPage.vehicleRow(E2E.tourVehicleBPlate)).toBeVisible();
  await expect(conversasPage.addVehicleButton()).toBeVisible();

  // Oracle: customer-services — the detail mirrors the Omie OS.
  await conversasPage.serviceRow(SERVICE_DESCRIPTION).first().click();
  await expect(page.getByText(/Origem/).first()).toBeVisible();
  await expect(page.getByText(/OS e2e-omie-os-return/)).toBeVisible();
});

test("Tour do Rumo Errado: the vehicle with no services says so and borrows nothing", async ({
  conversasPage,
  page,
  mainPane,
}) => {
  await conversasPage.gotoConversation(E2E.tourConversationId);
  await mainPane();

  await conversasPage.vehicleRow(E2E.tourVehicleBPlate).first().click();
  await expect(conversasPage.drillInTitle(E2E.tourVehicleBPlate)).toBeVisible();

  // Oracle: conversas — "No services is an empty state".
  await expect(conversasPage.vehicleHistoryEmpty()).toBeVisible();

  // Oracle: conversas — "Drill-in shows that vehicle's services only". The
  // other vehicle *does* have this service, which is what stops this from
  // passing vacuously: absence here is scoping, not an empty database.
  await expect(page.getByText(SERVICE_DESCRIPTION)).toHaveCount(0);
});

test("Tour do Colecionador: the overdue return and its prefilled reminder form", async ({
  page,
  mainPane,
}) => {
  const followUp = new FollowUpPage(page);
  await followUp.goto();
  await mainPane();

  // Oracle: vehicle-returns — an open, past-due return is listed as vencido.
  const vencido = followUp.section("Retorno vencido");
  await expect(vencido).toBeVisible();
  await expect(vencido.getByText(E2E.tourName)).toBeVisible();
  await expect(vencido.getByText(E2E.tourVehicleAPlate)).toBeVisible();

  // Oracle: follow-up — "The section heading names its ordering above the card".
  await expect(followUp.sectionOrdering("Retorno vencido")).toBeVisible();

  // Oracle: follow-up — "The form opens without leaving Follow-up".
  await followUp.criarLembreteButtons("Retorno vencido").first().click();
  await expect(followUp.reminderDialog()).toBeVisible();
  await expect(page).toHaveURL(/\/follow-up$/);

  // Oracle: follow-up — "Prefill comes from the return". The dialog names the
  // customer and the car it was opened from.
  await expect(followUp.reminderDialog().getByText(E2E.tourVehicleAPlate)).toBeVisible();

  // Oracle: follow-up — "Overdue return defaults ahead of today". Compared
  // against the clock rather than against the drive's 2026-09-11, which would
  // have expired the day after it was written.
  const noticeDate = await followUp.reminderNoticeDate().inputValue();
  // `today` must be the LOCAL calendar day, not the UTC one. The form defaults
  // an overdue return to tomorrow computed in the browser's timezone
  // (`defaultMoment` in ReminderForm.tsx), and this machine runs America/
  // Sao_Paulo at UTC-3. Between 00:00 and 03:00 UTC the UTC day is already
  // tomorrow locally, so a UTC `today` equals the form's "tomorrow" and the
  // strict comparison fails — green all day, red for three hours after
  // midnight UTC. Caught that way on 2026-09-13 at 01:22 UTC.
  const now = new Date();
  const today = new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 10);
  expect(noticeDate > today).toBe(true);
});

test("Tour em Período Chuvoso: cancel leaves the return alone, confirm adds a reminder", async ({
  page,
  mainPane,
}) => {
  const followUp = new FollowUpPage(page);
  await followUp.goto();
  await mainPane();

  const vencido = followUp.section("Retorno vencido");
  await expect(vencido.getByText(E2E.tourName)).toBeVisible();

  // The seed clears this customer's scheduled messages, so the row starts with
  // no planned summary. Asserting that first is what makes the appearance
  // below a change rather than a coincidence.
  await expect(followUp.plannedSummary()).toHaveCount(0);

  // Período Chuvoso — cancel mid-operation leaves no partial write.
  await followUp.criarLembreteButtons("Retorno vencido").first().click();
  await expect(followUp.reminderDialog()).toBeVisible();
  await followUp.reminderCancel().click();
  await expect(followUp.reminderDialog()).toHaveCount(0);
  await expect(followUp.plannedSummary()).toHaveCount(0);
  await expect(vencido.getByText(E2E.tourName)).toBeVisible();

  // Oracle: follow-up — "Blank body takes the composed default" (the body is
  // never typed into) and "The planned summary updates without a reload".
  await followUp.criarLembreteButtons("Retorno vencido").first().click();
  await expect(followUp.reminderDialog()).toBeVisible();
  await expect(followUp.reminderBody()).toHaveValue("");
  await followUp.reminderConfirm().click();
  await expect(followUp.reminderDialog()).toHaveCount(0);

  // No reload between confirming and reading — that is the scenario.
  await expect(followUp.plannedSummary()).toBeVisible();

  // Oracle: follow-up — "Criar lembrete stays available when reminders exist"
  // and "Existing planned reminders do not hide".
  await expect(followUp.criarLembreteButtons("Retorno vencido").first()).toBeVisible();
  await expect(vencido.getByText(E2E.tourName)).toBeVisible();
});

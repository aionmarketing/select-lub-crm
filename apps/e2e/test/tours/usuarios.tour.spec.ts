/**
 * Tour log — Usuários (team table, unit editing, create refusal)
 *
 * Feature: `/usuarios` — the team table with each user's units, the unit editor
 * opened from a row, and the create form's refusal path.
 *
 * Run report: `runs/2026-09-10-servicos-usuarios.md` (one drive covered this
 * screen and Serviços). Every step below was driven live through the Playwright
 * MCP first and is transcribed from the steps that succeeded there.
 *
 * Guidebook (openspec/specs/accounts/auth/spec.md):
 * - Users and units are listable for the Usuários screen
 * - List returns users with their memberships
 * - Units are named, not just identified
 * - No secret material is returned
 * - Duplicate e-mail is 409
 *
 * Tours:
 * - Guiado (Negócio) — read the team and their units, which is the screen's job.
 * - Rumo Errado (Decadente) — an e-mail that already exists must be refused,
 *   visibly, and must create nothing.
 * - Período Chuvoso (Hoteleiro) — the unit editor is the only write a tour may
 *   safely make here; toggling and cancelling must leave the membership alone.
 *
 * **Standing constraint: this tour never creates a Supabase account.** The tour
 * stack shares the project's Supabase project, so a completed create would make
 * a real account that no seed can clean up. The create form is therefore driven
 * only down its duplicate-e-mail path, which provably writes nothing, and unit
 * changes are exercised on the *seeded* users and always cancelled.
 *
 * Findings: no defect. Notably this screen *does* show a `role="alert"` on
 * refusal, which is the contrast that turns the silent refusals in
 * `runs/2026-09-10-configuracoes.md` into a consistency gap rather than a
 * missing capability.
 *
 * Out of scope: completing a create, detaching a unit for real (the seed does
 * not restore other users' memberships), and the multi-unit rows' "+N fora do
 * seu acesso" summary.
 */
import { UsuariosPage } from "../pages/usuarios-page.js";
import { expect, test } from "./fixtures.js";

/** A seeded test user, safe to open the unit editor on. */
const SEEDED_USER_EMAIL = "attendant-a@selectlub.example";

/** Values for the refusal path only — this create is expected to fail. */
const DUPLICATE_ATTEMPT = {
  name: "Tour Duplicado",
  password: "valor-descartavel-de-teste",
};

test("Tour Guiado: the team lists each user's units by name and no secrets", async ({
  page,
  mainPane,
}) => {
  const usuarios = new UsuariosPage(page);
  await usuarios.goto();
  await mainPane();

  // Oracle: auth — "Users and units are listable for the Usuários screen".
  await expect(usuarios.heading()).toBeVisible();
  await expect(usuarios.teamTable()).toBeVisible();
  await expect(usuarios.rows().first()).toBeVisible();

  // Oracle: auth — "List returns users with their memberships" and "Units are
  // named, not just identified": the cell holds a unit name, not an id.
  const seeded = usuarios.row(SEEDED_USER_EMAIL);
  await expect(seeded).toBeVisible();
  await expect(seeded).toContainText("Select Lub");

  // Oracle: auth — "No secret material is returned". Checked against the
  // rendered table rather than the payload, which is where a leak would show a
  // person. `Senha` appears on the create form below, so the check is scoped
  // to the table.
  await expect(usuarios.teamTable()).not.toContainText(/senha|password|token|hash/i);
});

test("Tour do Rumo Errado: a duplicate e-mail is refused, visibly, and creates nothing", async ({
  page,
  tourLog,
  mainPane,
}) => {
  // The refusal is a 409, which the browser logs as a console error. Declared
  // per-test so an unexpected conflict elsewhere is still a finding.
  tourLog.expect(/Failed to load resource.*409/i);

  const usuarios = new UsuariosPage(page);
  await usuarios.goto();
  await mainPane();
  await expect(usuarios.rows().first()).toBeVisible();

  const before = await usuarios.rows().count();

  await usuarios.nameField().fill(DUPLICATE_ATTEMPT.name);
  await usuarios.emailField().fill(SEEDED_USER_EMAIL);
  await usuarios.passwordField().fill(DUPLICATE_ATTEMPT.password);
  await usuarios.createButton().click();

  // Oracle: auth — "Duplicate e-mail is 409". The observable halves: the screen
  // says so, and the team is unchanged.
  await expect(page.getByRole("alert")).toContainText("Não foi possível criar o usuário");
  await expect(usuarios.rows()).toHaveCount(before);
  await expect(usuarios.teamTable()).not.toContainText(DUPLICATE_ATTEMPT.name);
});

test("Tour em Período Chuvoso: cancelling the unit editor leaves the membership alone", async ({
  page,
  mainPane,
}) => {
  const usuarios = new UsuariosPage(page);
  await usuarios.goto();
  await mainPane();

  const seeded = usuarios.row(SEEDED_USER_EMAIL);
  await expect(seeded).toContainText("Select Lub");

  await usuarios.editUnitsButton(SEEDED_USER_EMAIL).click();
  await expect(usuarios.editDialog()).toBeVisible();

  // Toggled before cancelling so the cancel has something to discard —
  // cancelling an untouched form would pass against a dialog that cannot edit
  // at all. Never saved: detaching a seeded user is not something the seed
  // restores.
  await usuarios.unitToggle("Select Lub").click();
  await usuarios.cancelEdit().click();
  await expect(usuarios.editDialog()).toHaveCount(0);

  // Período Chuvoso — cancel mid-operation leaves no partial write.
  await expect(usuarios.row(SEEDED_USER_EMAIL)).toContainText("Select Lub");
});

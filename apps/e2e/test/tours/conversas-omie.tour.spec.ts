/**
 * Tour log — Omie reconciliation pendings (the panel, and resolving one field)
 *
 * Feature: the `Pendências com o Omie` panel opened from the inbox header —
 * every open conflict across all customers, each showing what the CRM holds
 * against what Omie holds, with a per-field choice.
 *
 * Run report: `runs/2026-09-16-omie-reconciliation.md`. Every step below was
 * driven live through the Playwright MCP first and is transcribed from the steps
 * that succeeded there; nothing here asserts a value that the drive merely
 * displayed.
 *
 * Guidebook:
 * - openspec/specs/erp/omie-sync/spec.md — Shared fields follow the four-cell
 *   conflict policy; Resolved pendings are retained history; HTTP apply and list
 *   pendings (`GET /customers/:id/reconciliation-pendings` returns `open` rows)
 *
 * Tours:
 * - Colecionador (Turístico) — count everything. The header and the panel
 *   headline count FIELDS, not customers, and the fixture holds two conflicts on
 *   one customer precisely so the two readings can be told apart.
 * - Rumo Errado (Negócio) — resolve ONE field and check the others. The panel
 *   promises "Resolva campo a campo"; this asks whether the code agrees.
 *
 * Findings: no defect. The panel does what its footer promises.
 *
 * Out of scope: `Editar valor` (a third resolution path, which writes a value
 * neither side holds), vehicle pendings (the fixture's conflicts are person
 * fields), and the Omie snapshot ingest that OPENS a pending — that is a
 * function, not an HTTP route, by the spec's own requirement, so no browser
 * reaches it.
 */
import { E2E } from "../ids.js";
import { expect, test } from "./fixtures.js";

/** Shape of `GET /customers/:id/reconciliation-pendings`, which returns OPEN rows only. */
type PendingRow = { fieldKey: string };

/** Shape of `GET /conversations/:id/customer`, whose customer is nested. */
type CadastroState = { customer: { city: string | null; postalCode: string | null } | null };

/**
 * Reads the headline's field count out of the panel.
 *
 * The number is parsed rather than asserted whole, because the demo fixtures
 * contribute conflicts of their own and a tour pinned to an absolute total
 * would go red whenever those change. What this tour pins is how the number
 * MOVES, which is a property of the code rather than of the dataset.
 * @param text - The headline text, e.g. `4 campos ainda sem resolução`.
 * @returns The leading integer.
 */
function fieldCountOf(text: string) {
  const match = /(\d+)/.exec(text);
  expect(match, `headline did not carry a count: ${text}`).not.toBeNull();
  return Number(match![1]);
}

test("Tour do Colecionador: the panel counts fields, not customers, and resolving one is per-field", async ({
  conversasPage,
  crmApi,
  mainPane,
}) => {
  /**
   * Reads this customer's OPEN pendings straight from the API.
   * @returns The open rows' field keys, sorted for a stable comparison.
   */
  async function openFields() {
    const response = await crmApi.get(
      `/customers/${E2E.omieConflictCustomerId}/reconciliation-pendings`,
    );
    expect(response.ok()).toBe(true);
    return ((await response.json()) as PendingRow[]).map((row) => row.fieldKey).sort();
  }

  /**
   * Reads the stored address columns for the fixture's customer.
   * @returns The stored city and postal code, each null when unset.
   */
  async function storedAddress() {
    const response = await crmApi.get(
      `/conversations/${E2E.omieConflictConversationId}/customer`,
    );
    expect(response.ok()).toBe(true);
    const customer = ((await response.json()) as CadastroState).customer;
    return { city: customer?.city ?? null, postalCode: customer?.postalCode ?? null };
  }

  await conversasPage.goto();
  await mainPane();

  // The fixture's preconditions, asserted rather than assumed: both conflicts
  // open, and the chosen side not already stored. A leftover resolve would make
  // every assertion below pass without this tour doing anything.
  expect(await openFields()).toEqual(["city", "postalCode"]);
  // Both columns hold the CRM side, which is what makes the conflict coherent
  // and the assertions below non-vacuous. The seed enforces this on every run;
  // it did not at first, and this very assertion is what caught that.
  expect(await storedAddress()).toEqual({
    city: E2E.omieConflictCityCrm,
    postalCode: E2E.omieConflictPostalCrm,
  });

  // Oracle: omie-sync — open pendings are listed for the unit.
  await conversasPage.omiePendingsButton().click();
  await expect(conversasPage.omiePendingsDialog()).toBeVisible();

  const group = conversasPage.omiePendingGroup(E2E.omieConflictCustomerName);
  await expect(group).toBeVisible();

  // Oracle: omie-sync — a pending carries BOTH sides for one field. Both values
  // of both conflicts are on screen, so the attendant can choose rather than
  // guess. Read from the fixture, never from what the drive displayed.
  await expect(group).toContainText(E2E.omieConflictCityCrm);
  await expect(group).toContainText(E2E.omieConflictCityOmie);
  await expect(group).toContainText(E2E.omieConflictPostalCrm);
  await expect(group).toContainText(E2E.omieConflictPostalOmie);

  const before = fieldCountOf((await conversasPage.omiePendingsHeadline().innerText()) ?? "");

  // Oracle: omie-sync — the four-cell policy is per-field, not all-or-nothing.
  await conversasPage
    .omiePendingField(E2E.omieConflictCityCrm)
    .getByRole("button", { name: "Usar Omie" })
    .click();

  // THE FIELDS-NOT-CUSTOMERS PIN, and the reason the fixture carries two
  // conflicts on ONE customer. This customer still has an open conflict after
  // the resolve, so a count of CUSTOMERS would not move at all. Only a count of
  // fields falls by exactly one.
  await expect
    .poll(
      async () => fieldCountOf((await conversasPage.omiePendingsHeadline().innerText()) ?? ""),
      { timeout: 15_000 },
    )
    .toBe(before - 1);

  // Oracle: omie-sync — the chosen side is applied to the CRM record, AND the
  // field nobody chose for is untouched. Both columns in one read, so a resolve
  // that overwrote the whole address could not slip past a city-only check.
  await expect
    .poll(storedAddress, { timeout: 15_000 })
    .toEqual({
      city: E2E.omieConflictCityOmie,
      postalCode: E2E.omieConflictPostalCrm,
    });

  // Oracle: omie-sync — resolve is per-field. The OTHER conflict is still open,
  // at the source rather than by reading the panel that was just re-rendered.
  // This is the half that a count-only tour would skip, and the half that would
  // catch a resolve which closed everything on the customer.
  expect(await openFields()).toEqual(["postalCode"]);

  // And the untouched field is still offered, with both its sides intact.
  await expect(group).toContainText(E2E.omieConflictPostalCrm);
  await expect(group).toContainText(E2E.omieConflictPostalOmie);

  // The resolved field is no longer offered as a choice.
  await expect(group).not.toContainText(E2E.omieConflictCityCrm);
});

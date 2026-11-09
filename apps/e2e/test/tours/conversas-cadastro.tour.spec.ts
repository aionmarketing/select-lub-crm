/**
 * Tour log — Conversas cadastro rail (contact, vehicles, plate lookup, prefill)
 *
 * Feature: the contact rail beside an open thread — click-to-edit cadastro
 * fields, the vehicle list and its add form, the plate lookup that fills a
 * vehicle's identity, and the switch that opts a conversation into cadastro
 * extraction.
 *
 * Run report: `runs/2026-09-10-conversas-cadastro.md`. Every step below was
 * driven live through the Playwright MCP first and is transcribed from the steps
 * that succeeded there; nothing here asserts a value that the drive merely
 * displayed.
 *
 * Guidebook:
 * - openspec/specs/conversations/conversas/spec.md — Rail is read-only until Editar is
 *   clicked; Editar reveals inputs in place; Unlinked shared field persists
 *   without Omie; Two vehicles appear on the rail; Add vehicle from the rail;
 *   Add does not send WhatsApp; Default off; Toggle persists for that
 *   conversation; Turning on does not write cadastro
 * - openspec/specs/plate-lookup/plate-lookup/spec.md — the mock hit and not-found paths
 *
 * Tours:
 * - Guiado (Negócio) — edit → save → vehicle add, the rail's actual job.
 * - Correios (Negócio) — the plate lookup is this screen's one system boundary;
 *   follow the data in and out, and check nothing left the box.
 * - Rumo Errado (Decadente) — a plate the provider does not know must be stated,
 *   not invented.
 * - Período Chuvoso (Hoteleiro) — the prefill switch is per-conversation state
 *   that must survive a reload without writing a cadastro.
 *
 * Findings: no defect in the rail's behaviour. One accessibility defect found
 * during transcription and deliberately NOT asserted here — the vehicle row's
 * `aria-label="Ver <make> <model> <year>"` replaces its visible plate, so the
 * plate is absent from the accessible name (WCAG 2.5.3 Label in Name). Pinning
 * today's name would pin the bug, and no scenario yet says what the name should
 * be, so it is raised for the spec owner instead. Also one fixture fix (the seed
 * now removes vehicles a tour adds), one coverage gap, and one refetch-cadence
 * note, all in the run report. Nothing pinned in production code.
 *
 * Ghost accept and dismiss ARE toured, as of `close-stated-coverage-gaps` task
 * 3.1 — run report `runs/2026-09-16-conversas-prefill-ghost.md`. They were out
 * of scope while a ghost was thought to need a live extraction; it does not. The
 * seed writes the suggestion row directly, which is the product of an
 * extraction rather than a simulation of one, so the two tours run with
 * `OPENAI_API_KEY` blank exactly as before. Also out: Omie
 * reconciliation pendings (the seeded
 * customer is CRM-origin), vehicle drill-ins (the services tour), and Montar
 * orçamento (the oil-quote tour).
 */
import { E2E } from "../ids.js";
import { expect, test } from "./fixtures.js";

/** A plate present in the `PLACAS_MOCK` canned dataset, with no `versao` row. */
const KNOWN_PLATE = "DEF2E34";

/**
 * What the canned dataset holds for {@link KNOWN_PLATE}.
 *
 * Pinned deliberately. Asserting only that the fields are non-empty cannot tell
 * the mock apart from a live provider answering the same request, which is
 * exactly the confusion that let the tour reach APIBrasil unnoticed. These
 * strings are the only thing in the test that distinguishes "the mock ran" from
 * "something answered".
 */
const KNOWN_PLATE_MAKE = "HONDA";
// `FIT`, not the dataset's `modelo: "FIT 1.5"`: `mapAgregadosPropriaData` prefers a
// string `modeloDetalhes.sintetico` over `modelo`, and the mock runs through that
// same mapper the live adapter does.
const KNOWN_PLATE_MODEL = "FIT";

/** A plate deliberately absent from the canned dataset. */
const UNKNOWN_PLATE = "TES7T01";

/** Name the Guiado tour writes; the seed restores the original on the next run. */
const EDITED_NAME = "E2E Turista Editado";

test("Tour Guiado: the rail edits and saves a cadastro in place", async ({
  conversasPage,
  page,
  mainPane,
}) => {
  await conversasPage.gotoConversation(E2E.tourConversationId);
  await mainPane();

  // Oracle: conversas — "Rail is read-only until Editar is clicked". The name
  // is visible as text and there is no input to type into yet.
  await expect(page.getByText(E2E.tourPhone).first()).toBeVisible();
  await expect(conversasPage.cadastroName()).toHaveCount(0);

  // Oracle: conversas — "Two vehicles appear on the rail".
  await expect(conversasPage.vehicleRow(E2E.tourVehicleAPlate)).toBeVisible();
  await expect(conversasPage.vehicleRow(E2E.tourVehicleBPlate)).toBeVisible();

  // Oracle: conversas — "Editar reveals inputs in place".
  await conversasPage.cadastroEdit().click();
  await expect(conversasPage.cadastroName()).toBeVisible();

  // Oracle: conversas — "Unlinked shared field persists without Omie". The
  // seeded customer is CRM-origin, so this is the no-Omie write path.
  await conversasPage.cadastroName().fill(EDITED_NAME);
  await conversasPage.cadastroSave().click();
  await expect(conversasPage.cadastroName()).toHaveCount(0);
  await expect(page.getByText(EDITED_NAME).first()).toBeVisible();
});

test("Tour dos Correios: a known plate fills the vehicle and nothing leaves the box", async ({
  conversasPage,
  page,
  mainPane,
}) => {
  await conversasPage.gotoConversation(E2E.tourConversationId);
  await mainPane();

  // Any request to a real plate provider is a failure of the guard, not of the
  // feature — recorded across the whole tour rather than at one moment.
  const offBoxRequests: string[] = [];
  page.on("request", (request) => {
    if (/apibrasil|placas\.com|api-placas/i.test(request.url())) {
      offBoxRequests.push(request.url());
    }
  });

  await conversasPage.addVehicleButton().click();
  await expect(conversasPage.vehicleDialog()).toBeVisible();

  // The lookup is a *blur* handler (`vehicle-plate-fields.tsx`), so filling
  // alone never runs it. Without this the assertions below would pass or fail
  // against a lookup that never happened.
  await conversasPage.vehiclePlateField().fill(KNOWN_PLATE);
  await conversasPage.vehiclePlateField().blur();

  // Oracle: plate-lookup — a hit fills the identity fields and marks them as
  // plate-sourced. The values are pinned to the canned dataset, not merely
  // checked for being non-empty: a live provider fills them too, so "filled and
  // flagged" passes just as well when the request left the machine.
  await expect(conversasPage.vehicleField("Marca")).toHaveValue(KNOWN_PLATE_MAKE, {
    timeout: 15_000,
  });
  await expect(conversasPage.vehicleField("Modelo")).toHaveValue(KNOWN_PLATE_MODEL);
  await expect(conversasPage.vehicleDialog().getByText("Atualizado pela placa").first()).toBeVisible();

  // Oracle: conversas — "Add vehicle from the rail".
  await conversasPage.saveVehicleButton().click();
  await expect(conversasPage.vehicleDialog()).toHaveCount(0);
  await expect(conversasPage.vehicleRow(KNOWN_PLATE)).toBeVisible();

  // Oracle: conversas — "Add does not send WhatsApp".
  //
  // This listener sees BROWSER requests only. The plate lookup is a server-side
  // call from the API process, so it could never have caught one — it is kept
  // for the browser-side case it does cover, and the identity assertions above
  // are what actually prove the mock answered.
  expect(offBoxRequests).toEqual([]);
});

test("Tour do Rumo Errado: an unknown plate is stated, not invented", async ({
  conversasPage,
  mainPane,
}) => {
  await conversasPage.gotoConversation(E2E.tourConversationId);
  await mainPane();

  await conversasPage.addVehicleButton().click();
  await expect(conversasPage.vehicleDialog()).toBeVisible();

  await conversasPage.vehiclePlateField().fill(UNKNOWN_PLATE);
  await conversasPage.vehiclePlateField().blur();

  // Oracle: plate-lookup — a miss is reported. The identity fields staying
  // empty is the other half: a screen that guessed a car would be worse than
  // one that says nothing.
  await expect(conversasPage.plateNotFound()).toBeVisible({ timeout: 15_000 });
  await expect(conversasPage.vehicleField("Marca")).toHaveValue("");
  await expect(conversasPage.vehicleField("Modelo")).toHaveValue("");

  // The form is still usable afterwards, which is what separates "stated" from
  // "broke".
  await expect(conversasPage.saveVehicleButton()).toBeVisible();
});

/** Shape of `GET /conversations/:id/prefill` that this tour reads. */
type PrefillState = { extractEnabled: boolean };

test("Tour em Período Chuvoso: the prefill switch persists without writing a cadastro", async ({
  conversasPage,
  crmApi,
  page,
  mainPane,
}) => {
  /**
   * Reads the persisted extraction flag straight from the API.
   *
   * Persistence is asserted at the source rather than by reloading and
   * believing the checkbox: the switch flips optimistically, so the UI shows
   * the new value before — and even if — anything is stored.
   * @returns The stored `extractEnabled` flag.
   */
  async function storedExtractEnabled() {
    const response = await crmApi.get(`/conversations/${E2E.tourConversationId}/prefill`);
    expect(response.ok()).toBe(true);
    return ((await response.json()) as PrefillState).extractEnabled;
  }

  await conversasPage.gotoConversation(E2E.tourConversationId);
  await mainPane();

  const toggle = conversasPage.prefillSwitch();
  await expect(toggle).toBeVisible();

  // The seed does not reset this flag, so an earlier run may have left it on.
  // Normalise to off first, then restore at the end.
  if (await storedExtractEnabled()) {
    await conversasPage.prefillSwitchLabel().click();
    await expect.poll(storedExtractEnabled, { timeout: 15_000 }).toBe(false);
  }

  // Oracle: conversas — "Default off".
  await expect(toggle).not.toBeChecked();

  const nameBefore = await page.getByText(E2E.tourName, { exact: false }).first().innerText();

  // Oracle: conversas — "Turning on does not write cadastro".
  await conversasPage.prefillSwitchLabel().click();
  await expect(toggle).toBeChecked();
  await expect.poll(storedExtractEnabled, { timeout: 15_000 }).toBe(true);
  await expect(page.getByText(nameBefore, { exact: false }).first()).toBeVisible();

  // Oracle: conversas — "Toggle persists for that conversation".
  await conversasPage.gotoConversation(E2E.tourConversationId);
  await mainPane();
  await expect(conversasPage.prefillSwitch()).toBeChecked();

  // Leave the fixture as it was found.
  await conversasPage.prefillSwitchLabel().click();
  await expect.poll(storedExtractEnabled, { timeout: 15_000 }).toBe(false);
});


/**
 * Shape of `GET /conversations/:id/customer` that the ghost tours read.
 *
 * The customer is NESTED under `customer`, beside `pendings`. Reading `name` at
 * the top level yields `undefined`, which is not `null` — and an unset name is
 * genuinely `null` here, so the two must not be conflated.
 */
type CadastroState = { customer: { name: string | null } | null };

/**
 * The field label the ghost is offered under.
 *
 * Both UI variants build the control's accessible name as `Aceitar ${label}` /
 * `Recusar ${label}`, so this one string drives both tours under either variant.
 */
const GHOST_FIELD = "Nome";

test("Tour Guiado: accepting a suggested name writes it to the cadastro", async ({
  conversasPage,
  crmApi,
  mainPane,
}) => {
  /**
   * Reads the stored cadastro name straight from the API.
   *
   * At the source rather than from the rail: the rail renders the accepted
   * value optimistically, so it shows the new name before — and even if —
   * anything was written.
   *
   * Read through the conversation, because there is no `GET /customers/:id` —
   * only PATCH. `GET /conversations/:id/customer` is the endpoint the rail
   * itself reads, so this asserts on exactly what the screen is served.
   * @returns The customer's stored name, or null when unset.
   */
  async function storedName() {
    const response = await crmApi.get(
      `/conversations/${E2E.prefillAcceptConversationId}/customer`,
    );
    expect(response.ok()).toBe(true);
    return ((await response.json()) as CadastroState).customer?.name ?? null;
  }

  await conversasPage.gotoConversation(E2E.prefillAcceptConversationId);
  await mainPane();

  // The fixture's customer has no name, so the accept below has something to
  // change. Asserted rather than assumed: a leftover name would make every
  // assertion in this tour pass without the accept doing anything.
  expect(await storedName()).toBeNull();

  // Oracle: assistive-prefill — "a suggestion is offered beside the field it
  // fills", with both a control to take it and one to refuse it.
  const accept = conversasPage.prefillGhostAccept(GHOST_FIELD);
  await expect(accept).toBeVisible();
  await expect(conversasPage.prefillGhostReject(GHOST_FIELD)).toBeVisible();

  // Oracle: assistive-prefill — "accepting a suggested field writes it to the
  // cadastro". The expected value comes from the fixture, never from what the
  // drive displayed.
  await accept.click();
  await expect.poll(storedName, { timeout: 15_000 }).toBe(E2E.prefillSuggestedName);

  // Oracle: assistive-prefill — "a consumed suggestion is no longer offered".
  // Both controls, not just the one clicked: accepting must retire the whole
  // ghost rather than leave a refuse control behind for a field that is settled.
  await expect(accept).toHaveCount(0);
  await expect(conversasPage.prefillGhostReject(GHOST_FIELD)).toHaveCount(0);

  // What the attendant actually sees: the accepted name reaches the inbox row,
  // not only the rail that was open at the time.
  await expect(
    conversasPage.listConversation(E2E.prefillAcceptConversationId),
  ).toContainText(E2E.prefillSuggestedName);
});

test("Tour do Rumo Errado: refusing a suggestion discards it and writes nothing", async ({
  conversasPage,
  crmApi,
  mainPane,
}) => {
  /**
   * Reads the stored cadastro name for the DISMISS fixture's customer.
   * @returns The customer's stored name, or null when unset.
   */
  async function storedName() {
    const response = await crmApi.get(
      `/conversations/${E2E.prefillDismissConversationId}/customer`,
    );
    expect(response.ok()).toBe(true);
    return ((await response.json()) as CadastroState).customer?.name ?? null;
  }

  await conversasPage.gotoConversation(E2E.prefillDismissConversationId);
  await mainPane();

  expect(await storedName()).toBeNull();

  const reject = conversasPage.prefillGhostReject(GHOST_FIELD);
  await expect(reject).toBeVisible();

  // Oracle: assistive-prefill — "refusing a suggestion discards it without
  // writing".
  await reject.click();

  // The POSITIVE half first, so this tour cannot pass by simply not looking:
  // the ghost is gone, which is what proves the refusal was processed at all.
  // Without it, the null-name assertion below would hold just as well on a
  // click that did nothing.
  await expect(reject).toHaveCount(0);
  await expect(conversasPage.prefillGhostAccept(GHOST_FIELD)).toHaveCount(0);

  // The NEGATIVE half: nothing was written. Polled rather than read once, so a
  // write that lands late still fails this.
  await expect.poll(storedName, { timeout: 5_000 }).toBeNull();

  // And the refused value never reaches the inbox row either.
  await expect(
    conversasPage.listConversation(E2E.prefillDismissConversationId),
  ).not.toContainText(E2E.prefillSuggestedName);
});

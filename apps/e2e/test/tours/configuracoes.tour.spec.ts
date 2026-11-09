/**
 * Tour log — Configurações (tag and template catalogs)
 *
 * Feature: the two per-unit catalogs on `/configuracoes` — creating a tag and a
 * template, what happens on a blank or duplicate submit, deactivating an entry,
 * and whether a catalog change reaches the screens that consume it.
 *
 * Run report: `runs/2026-09-10-configuracoes.md`. Every step below was driven
 * live through the Playwright MCP first and is transcribed from the steps that
 * succeeded there; nothing here asserts a value that the drive merely displayed.
 *
 * Guidebook (openspec/specs/conversations/tags-templates/spec.md):
 * - Attendant opens Configurações
 * - A catalog is one card under its heading
 * - Create then list
 * - Duplicate active name is rejected
 * - Deactivate hides from apply options
 *
 * Tours:
 * - Guiado (Negócio) — create a tag, create a template, see them listed.
 * - Ator Coadjuvante (Entretenimento) — a catalog exists for *other* screens;
 *   follow a tag into the Conversas inbox filter and watch it leave again.
 * - Rumo Errado (Decadente) — submit nothing, then submit a name that already
 *   exists; both must be refused without damage.
 * - Período Chuvoso (Hoteleiro) — deactivation is a soft delete: the entry must
 *   leave the consumers without leaving the catalog.
 *
 * Findings: no defect. One usability surprise — blank and duplicate submits are
 * both refused *silently*, with no message of any kind — recorded in the run
 * report and deliberately NOT asserted here, since asserting the silence would
 * pin it as intended. One fixture fix (the seed now sweeps tour-created catalog
 * entries by name prefix). Nothing pinned in production code.
 *
 * Out of scope: editing an entry in place, template preview interpolation (no
 * control on this screen; API tests cover it), reactivation, and the tag-apply
 * path from a conversation — that is `conversas-inbox.tour.spec.ts`.
 */
import { ConfiguracoesPage } from "../pages/configuracoes-page.js";
import { TOUR_CREATED_PREFIX } from "../seed-e2e.js";
import { E2E } from "../ids.js";
import { expect, test } from "./fixtures.js";

/** Names this tour creates; the seed sweeps anything with this prefix. */
const NEW_TAG = `${TOUR_CREATED_PREFIX} Tag`;
const NEW_TEMPLATE = `${TOUR_CREATED_PREFIX} Template`;
const NEW_TEMPLATE_BODY = "Olá {{nome_cliente}}, tudo bem?";

test("Tour Guiado: a tag and a template are created and listed", async ({
  page,
  mainPane,
}) => {
  const config = new ConfiguracoesPage(page);
  await config.goto();
  await mainPane();

  // Oracle: tags-templates — "A catalog is one card under its heading".
  await expect(config.tagsCard()).toBeVisible();
  await expect(config.templatesCard()).toBeVisible();

  // Both cards render their create form before their rows arrive, so counting
  // straight after the card is visible reads zero and every delta below is off
  // by the seeded entries. Waiting on a known-seeded row is the fix.
  await expect(config.tagRow(E2E.tourTagName)).toBeVisible();
  await expect(config.templateRow(E2E.tourTemplateName)).toBeVisible();

  const tagsBefore = await config.tagEntries().count();
  const templatesBefore = await config.templateEntries().count();

  // Oracle: tags-templates — "Create then list".
  await config.tagNameField().fill(NEW_TAG);
  await config.createTagButton().click();
  await expect(config.tagRow(NEW_TAG)).toBeVisible();
  await expect(config.tagEntries()).toHaveCount(tagsBefore + 1);

  await config.templateNameField().fill(NEW_TEMPLATE);
  await config.templateTextField().fill(NEW_TEMPLATE_BODY);
  await config.createTemplateButton().click();
  await expect(config.templateRow(NEW_TEMPLATE)).toBeVisible();
  await expect(config.templateEntries()).toHaveCount(templatesBefore + 1);
});

test("Tour do Rumo Errado: blank and duplicate submits change nothing", async ({
  page,
  tourLog,
  mainPane,
}) => {
  // The duplicate submit is refused with 409, and the browser logs every
  // non-2xx fetch as a console error. Declared here rather than added to the
  // module allow-list: a 409 is expected in this one tour and is a finding in
  // any other.
  tourLog.expect(/Failed to load resource.*409/i);

  const config = new ConfiguracoesPage(page);
  await config.goto();
  await mainPane();
  await expect(config.tagsCard()).toBeVisible();

  // Same load race as the Guiado tour: wait for a seeded row before counting.
  await expect(config.tagRow(E2E.tourTagName)).toBeVisible();
  const before = await config.tagEntries().count();

  // Oracle: tags-templates — a nameless tag is not created. Transcribed as the
  // observed outcome (nothing changes); the run report notes that the screen
  // says nothing either, which is a finding, not something to assert here.
  await config.tagNameField().fill("");
  await config.createTagButton().click();
  await expect(config.tagEntries()).toHaveCount(before);

  // Oracle: tags-templates — "Duplicate active name is rejected". The seeded
  // tag is guaranteed present, so this is a genuine collision rather than a
  // create that happens to fail.
  await expect(config.tagRow(E2E.tourTagName)).toBeVisible();
  await config.tagNameField().fill(E2E.tourTagName);
  await config.createTagButton().click();
  await expect(config.tagEntries()).toHaveCount(before);
});

test("Tour do Ator Coadjuvante: a new tag reaches the inbox filter", async ({
  conversasPage,
  page,
  mainPane,
}) => {
  const config = new ConfiguracoesPage(page);
  await config.goto();
  await mainPane();

  await config.tagNameField().fill(NEW_TAG);
  await config.createTagButton().click();
  await expect(config.tagRow(NEW_TAG)).toBeVisible();

  // Oracle: tags-templates — the catalog feeds the inbox filter. A catalog
  // whose entries never reach a consumer would pass every check on its own
  // screen, which is why this tour crosses to another one.
  await conversasPage.goto();
  await conversasPage.inbox().waitFor();
  await expect(conversasPage.tagFilterChip(NEW_TAG)).toBeVisible();
});

test("Tour em Período Chuvoso: deactivating removes it from consumers, not from the catalog", async ({
  conversasPage,
  page,
  mainPane,
}) => {
  const config = new ConfiguracoesPage(page);
  await config.goto();
  await mainPane();

  await config.tagNameField().fill(NEW_TAG);
  await config.createTagButton().click();
  await expect(config.tagRow(NEW_TAG)).toBeVisible();

  await config.deactivateTag(NEW_TAG).click();

  // Oracle: tags-templates — deactivation is reversible, so the entry stays
  // catalogued and offers its way back.
  await expect(config.tagInactiveMark(NEW_TAG)).toBeVisible();
  await expect(config.reactivateTag(NEW_TAG)).toBeVisible();

  // Oracle: tags-templates — "Deactivate hides from apply options". The seeded
  // tag is still active and must survive, or this would also pass against a
  // filter that simply stopped listing anything.
  await conversasPage.goto();
  await conversasPage.inbox().waitFor();
  await expect(conversasPage.tagFilterChip(E2E.tourTagName)).toBeVisible();
  await expect(conversasPage.tagFilterChip(NEW_TAG)).toHaveCount(0);
});

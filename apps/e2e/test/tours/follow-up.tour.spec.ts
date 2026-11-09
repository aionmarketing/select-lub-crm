/**
 * Tour log — Follow-up (counts, sections, links back, archiving)
 *
 * Feature: the Follow-up queue — four counted cards over three lists, the
 * fourth list reachable by selecting its card, the links back into Conversas,
 * and archiving an entry off the queue.
 *
 * Run report: `runs/2026-09-10-follow-up.md`. Every step below was driven live
 * through the Playwright MCP first and is transcribed from the steps that
 * succeeded there; nothing here asserts a value that the drive merely displayed.
 *
 * Guidebook (openspec/specs/conversations/follow-up/spec.md):
 * - Four counts, three lists by default
 * - The fourth list is reachable by selecting its card
 * - Selecting the selected card clears the filter
 * - The section heading names its ordering above the card
 * - Every entry can open its conversation and be archived
 * - Empty section is explicit
 * - Closed entry leaves the section and its count
 * - The archived strip belongs to its section
 * - Badge totals the four sections
 *
 * Tours:
 * - Guiado (Negócio) — counts → lists → an entry → its conversation, the shift
 *   an attendant actually works.
 * - Colecionador (Turístico) — four counts, three default lists, a fourth
 *   behind its card, empty states, an archived strip: one of each.
 * - Rumo Errado (Decadente) — re-selecting a selected card, and archiving the
 *   thing you are looking at.
 * - Desinteressado (Hoteleiro) — do nothing interesting; counts, lists and the
 *   rail badge must still agree afterwards.
 *
 * Findings: **this tour found a real defect and it is fixed.** `Arquivar este
 * retorno` and its unarchive never worked — `send()` in
 * `apps/web/src/api/returnReminders.ts` declared `content-type:
 * application/json` on a bodyless POST, which Fastify refuses with 400
 * `FST_ERR_CTP_EMPTY_JSON_BODY`. Fixed there and pinned by
 * `apps/web/src/api/returnReminders.test.ts` (red on the old code), because a
 * tour is quarantined from CI and cannot be the only guard. A second finding —
 * the SPA's session dies after about an hour and never recovers — is out of
 * this change's scope and is not asserted here. A later red of the Rumo Errado
 * and Desinteressado tours (2026-10-04) was the tour, not the screen: the demo
 * seed's Omie mock customer (overdue since July, no conversation) is the first
 * Retorno vencido entry, so `.first()` archived her and counting `Abrir
 * conversa` links under-counted by one. The tour now archives its own
 * customer's entry and counts entries through `FollowUpPage.entryCount`.
 *
 * Out of scope: the reminder form (toured in `conversas-services.tour.spec.ts`),
 * unarchiving, closing the two message-pendency sections against their anchors,
 * and the count cap.
 */
import { FollowUpPage, FOLLOW_UP_SECTIONS } from "../pages/follow-up-page.js";
import { AppShell } from "../pages/app-shell.js";
import { E2E } from "../ids.js";
import { expect, test } from "./fixtures.js";

/** Sections that render a list by default; the fourth needs its card selected. */
const DEFAULT_SECTIONS = [
  "Orçamentos sem resposta",
  "Retorno vencido",
  "Retorno se aproximando",
] as const;

/** The section that is counted but not listed until its card is chosen. */
const CARD_ONLY_SECTION = "Mensagens aguardando resposta";

test("Tour Guiado: counts, ordering, and the way back into a conversation", async ({
  page,
  mainPane,
}) => {
  const followUp = new FollowUpPage(page);
  const shell = new AppShell(page);

  await followUp.goto();
  await mainPane();

  // Oracle: follow-up — "Four counts, three lists by default".
  for (const section of FOLLOW_UP_SECTIONS) {
    await expect(followUp.countCard(section)).toBeVisible();
  }
  for (const section of DEFAULT_SECTIONS) {
    await expect(followUp.section(section)).toBeVisible();
    // Oracle: "The section heading names its ordering above the card".
    await expect(followUp.sectionOrdering(section)).toBeVisible();
  }
  await expect(followUp.section(CARD_ONLY_SECTION)).toHaveCount(0);

  // Oracle: follow-up — "Badge totals the four sections". Summed from the cards
  // rather than compared to a literal, so it holds whatever the fixture holds.
  const counts = await Promise.all(FOLLOW_UP_SECTIONS.map((s) => followUp.countValue(s)));
  const total = counts.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  await expect(shell.followUpBadge()).toHaveText(String(total));

  // Oracle: follow-up — "Every entry can open its conversation".
  await followUp
    .section("Retorno vencido")
    .getByRole("link", { name: E2E.tourName })
    .click();
  await expect(page).toHaveURL(new RegExp(`conversation=${E2E.tourConversationId}`));
  await mainPane();
});

test("Tour do Colecionador: the fourth list, and the sections that are empty", async ({
  page,
  mainPane,
}) => {
  const followUp = new FollowUpPage(page);
  await followUp.goto();
  await mainPane();

  // Oracle: follow-up — "The fourth list is reachable by selecting its card".
  await followUp.countCard(CARD_ONLY_SECTION).click();
  await expect(followUp.section(CARD_ONLY_SECTION)).toBeVisible();

  // Oracle: follow-up — "Selecting the selected card clears the filter".
  await followUp.countCard(CARD_ONLY_SECTION).click();
  await expect(followUp.section(CARD_ONLY_SECTION)).toHaveCount(0);
  await expect(followUp.section("Retorno vencido")).toBeVisible();

  // Oracle: follow-up — "Empty section is explicit". Driven only on sections the
  // fixture actually leaves empty, so it never asserts emptiness into a
  // populated list.
  for (const section of DEFAULT_SECTIONS) {
    const count = await followUp.countValue(section);
    if (count === 0) {
      await expect(followUp.emptyState(section)).toBeVisible();
    }
  }
});

test("Tour do Rumo Errado: archiving takes the entry out of its list and its count", async ({
  page,
  mainPane,
}) => {
  const followUp = new FollowUpPage(page);
  const shell = new AppShell(page);

  await followUp.goto();
  await mainPane();

  const vencido = followUp.section("Retorno vencido");
  await expect(vencido.getByText(E2E.tourName)).toBeVisible();
  const before = (await followUp.countValue("Retorno vencido")) ?? 0;
  expect(before).toBeGreaterThan(0);
  const badgeBefore = Number(await shell.followUpBadge().innerText());
  const liveEntriesBefore = await followUp.entryCount("Retorno vencido");

  // This is the step that failed on the drive and produced the fix in
  // `apps/web/src/api/returnReminders.ts`. It is transcribed as the corrected
  // behaviour because the defect was fixed, pinned in Vitest, and re-driven.
  //
  // The tour customer's own entry, not the first one on screen. The queue is
  // ordered most overdue first and the demo seed's Omie mock customer ("Maria
  // Linked", overdue since July, no conversation) sits above E2E Turista, so
  // `.first()` archived HER return: the count still fell, `Abrir conversa` did
  // not (she has none), and the tour went red on a database that had never seen
  // a defect. Oracle for the order: follow-up — "Section is ordered most urgent
  // first".
  await followUp
    .overdueEntryOf(E2E.tourName)
    .getByRole("button", { name: "Arquivar este retorno" })
    .click();

  // Oracle: follow-up — "Closed entry leaves the section and its count".
  //
  // Measured on the live entries, not on the customer's name: an archived entry
  // is still named in the section's archived strip ("1 arquivado · E2E
  // Turista"), which is the spec working, not the archive failing. The strip
  // carries no archive control, so counting those counts the live list.
  await expect
    .poll(() => followUp.entryCount("Retorno vencido"))
    .toBe(liveEntriesBefore - 1);
  await expect(vencido.getByRole("link", { name: E2E.tourName })).toHaveCount(0);
  await expect.poll(() => followUp.countValue("Retorno vencido")).toBe(before - 1);

  // Oracle: follow-up — "The archived strip belongs to its section".
  await expect(followUp.verArquivado("Retorno vencido")).toBeVisible();

  // Oracle: follow-up — "Badge totals the four sections", still, after a change.
  await expect(shell.followUpBadge()).toHaveText(String(badgeBefore - 1));
});

test("Tour do Desinteressado: after a reload the counts still match their lists", async ({
  page,
  mainPane,
}) => {
  const followUp = new FollowUpPage(page);
  const shell = new AppShell(page);

  await followUp.goto();
  await mainPane();
  await page.reload();
  await mainPane();

  // Oracle: follow-up — "Section counts are a shared contract" (Count matches
  // list). Checked on the listed sections, whose entries are countable on screen.
  for (const section of DEFAULT_SECTIONS) {
    const count = await followUp.countValue(section);
    if (count === null) continue;
    if (count === 0) {
      await expect(followUp.emptyState(section)).toBeVisible();
    } else {
      // Entries, not `Abrir conversa` links: a queued customer with no
      // conversation has no link (follow-up — "A return without a conversation
      // has no Abrir conversa") and is still one of the count.
      await expect.poll(() => followUp.entryCount(section)).toBe(count);
    }
  }

  const counts = await Promise.all(FOLLOW_UP_SECTIONS.map((s) => followUp.countValue(s)));
  const total = counts.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  await expect(shell.followUpBadge()).toHaveText(String(total));
});

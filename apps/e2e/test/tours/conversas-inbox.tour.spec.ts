/**
 * Tour log — Conversas inbox (list, search, thread, send, tags, Nova conversa)
 *
 * Feature: the attendant's front door — the unit-scoped thread list, its search
 * and tag filter, opening a thread, queueing a text through the outbox, and
 * starting a conversation from a phone number.
 *
 * Run report: `runs/2026-09-10-conversas-inbox.md`. Every step below was driven
 * live through the Playwright MCP first and is transcribed from the steps that
 * succeeded there; nothing here asserts a value that the drive merely displayed.
 *
 * Guidebook:
 * - openspec/specs/conversations/conversas/spec.md — Phone digits find the thread; Name search
 *   is case-insensitive; Empty search match is explicit; Unknown is not labelled
 *   organic; Send queues an outbound text; Empty send is rejected; Apply from
 *   the open conversation; Single tag filter
 * - openspec/specs/conversations/tags-templates/spec.md — Inbox filter by tag (Filter keeps
 *   matching threads)
 *
 * Tours:
 * - Guiado (Negócio) — list → search → thread → send, the pass every attendant
 *   makes and that no browser test had walked end to end.
 * - Rumo Errado (Decadente) — Enviar with nothing typed, and a search matching
 *   nothing: states the screen must state rather than break in.
 * - Ator Coadjuvante (Entretenimento) — the tag is applied in the contact rail
 *   but filters in the toolbar; one region must change the other.
 * - Período Chuvoso (Hoteleiro) — Nova conversa abandoned halfway must leave no
 *   thread behind.
 *
 * Findings: one candidate defect, deliberately not asserted here — a session
 * that starts being refused mid-life is never recovered and the SPA retries
 * forever (`AppProviders.tsx:104` snapshots the token once, with no
 * `onAuthStateChange`). It is unreachable from a spec because every tour starts
 * from a clean browser context, and the `auth` spec has no scenario to pin it
 * against yet. Two surprises (a ~7.6 h clock skew on issued tokens; `Enviar`
 * enabled while the composer is empty) are in the run report. Nothing pinned in
 * production code.
 *
 * Out of scope: media send and attachments (no fixture bytes in this seed),
 * channel-down behaviour (the seed forces CONNECTED), actually completing Nova
 * conversa (it would create a thread the seed does not own), and delivery
 * status beyond `queued` — the worker is not started on the tour stack.
 */
import { E2E } from "../ids.js";
import { expect, test } from "./fixtures.js";

/** Body the Guiado tour queues; unique enough to find in the thread. */
const SENT_TEXT = "Tour Guiado inbox mensagem";

/** A search term chosen so that no seeded or demo thread can match it. */
const NO_MATCH_TERM = "zzzz-nao-existe-zzzz";

/** A number deliberately never committed — the Período Chuvoso tour abandons it. */
const ABANDONED_PHONE = "11988887777";

test("Tour Guiado: find a thread, open it, and queue a text", async ({
  conversasPage,
  page,
  mainPane,
}) => {
  await conversasPage.goto();
  await conversasPage.inbox().waitFor();
  await mainPane();

  // Oracle: conversas — "Phone digits find the thread".
  await conversasPage.searchField().fill(E2E.tourPhone);
  await expect(conversasPage.listItems()).toHaveCount(1);
  await expect(conversasPage.listConversation(E2E.tourConversationId)).toBeVisible();

  // Oracle: conversas — "Unknown is not labelled organic". The seeded
  // conversation has no classification, so it must not claim one.
  await expect(conversasPage.listConversation(E2E.tourConversationId)).toContainText(
    "Desconhecida",
  );

  // Oracle: conversas — "Name search is case-insensitive". Lower-cased on
  // purpose; the seeded name is "E2E Turista".
  await conversasPage.searchField().fill(E2E.tourName.toLowerCase());
  await expect(conversasPage.listItems()).toHaveCount(1);

  await conversasPage.listConversation(E2E.tourConversationId).click();
  await expect(conversasPage.composer()).toBeVisible();

  // Oracle: conversas — "Send queues an outbound text". `queued`, not `sent`:
  // the tour stack runs no worker, so the CRM's job ends at the outbox.
  await conversasPage.composer().fill(SENT_TEXT);
  await conversasPage.sendButton().click();
  await expect(conversasPage.composer()).toHaveValue("");
  await expect(page.getByText(SENT_TEXT)).toBeVisible();
  await expect(page.getByText(/queued/)).toBeVisible();
});

test("Tour do Rumo Errado: an empty send and a search that matches nothing", async ({
  conversasPage,
  page,
  mainPane,
}) => {
  await conversasPage.goto();
  await conversasPage.inbox().waitFor();
  await mainPane();

  await conversasPage.searchField().fill(E2E.tourPhone);
  await conversasPage.listConversation(E2E.tourConversationId).click();
  await expect(conversasPage.composer()).toBeVisible();

  // Oracle: conversas — "Empty send is rejected". Watching the network is the
  // point: the drive proved nothing left the page, which is stronger than
  // observing that no bubble appeared.
  let messagePosts = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/messages?\b/.test(request.url())) messagePosts += 1;
  });
  await conversasPage.composer().fill("");
  await conversasPage.sendButton().click();
  expect(messagePosts).toBe(0);

  // Oracle: conversas — "Empty search match is explicit". The screen names the
  // term back rather than rendering an empty list with no explanation.
  await conversasPage.searchField().fill(NO_MATCH_TERM);
  await expect(conversasPage.listItems()).toHaveCount(0);
  await expect(conversasPage.emptySearchMessage(NO_MATCH_TERM)).toBeVisible();
  await mainPane();
});

test("Tour do Ator Coadjuvante: a tag applied in the rail filters the inbox", async ({
  conversasPage,
  mainPane,
}) => {
  await conversasPage.goto();
  await conversasPage.inbox().waitFor();
  await mainPane();

  // Captured before filtering so the narrowing below is a real comparison. The
  // drive saw 31; asserting that literal would pin the demo dataset instead of
  // the filter.
  //
  // The wait is load-bearing: `inbox()` is the panel, and it exists before its
  // rows arrive, so counting straight after it reads 0 and the comparison below
  // would pass against an empty list.
  await expect(conversasPage.listItems().first()).toBeVisible();
  const unfiltered = await conversasPage.listItems().count();
  expect(unfiltered).toBeGreaterThan(1);

  await conversasPage.searchField().fill(E2E.tourPhone);
  await conversasPage.listConversation(E2E.tourConversationId).click();

  // Oracle: conversas — "Apply from the open conversation". Applying is
  // idempotent from the tour's point of view: the seed may leave the tag
  // already applied from an earlier run, in which case the control is absent.
  const apply = conversasPage.applyTagButton(E2E.tourTagName);
  if (await apply.isVisible()) {
    await apply.click();
    await expect(apply).toHaveCount(0);
  }

  // Oracle: tags-templates — "Filter keeps matching threads"; conversas —
  // "Single tag filter".
  await conversasPage.searchField().fill("");
  await expect(conversasPage.listItems()).toHaveCount(unfiltered);
  await conversasPage.tagFilterChip(E2E.tourTagName).click();

  await expect(conversasPage.listItems()).toHaveCount(1);
  await expect(conversasPage.listConversation(E2E.tourConversationId)).toBeVisible();

  // Oracle: conversas — "Applied filters are visible and removable".
  await conversasPage.tagFilterAll().click();
  await expect(conversasPage.listItems()).toHaveCount(unfiltered);
});

test("Tour em Período Chuvoso: Nova conversa abandoned leaves no thread", async ({
  conversasPage,
  mainPane,
}) => {
  await conversasPage.goto();
  await conversasPage.inbox().waitFor();
  await mainPane();

  // Same load-bearing wait as the tag-filter tour above: `inbox()` is the panel
  // and exists before its rows arrive, so counting straight after it reads 0 —
  // and then `toHaveCount(before)` at the end compares the loaded list against
  // that 0 and fails. This tour went red exactly that way on 2026-09-11.
  await expect(conversasPage.listItems().first()).toBeVisible();
  const before = await conversasPage.listItems().count();

  await conversasPage.novaConversaButton().click();
  await expect(conversasPage.novaConversaDialog()).toBeVisible();

  // Oracle: conversas — "Nova conversa opens or creates a 1:1 thread". The
  // commit is unavailable until a number exists, which is what makes the
  // abandon below meaningful rather than a no-op on a dead form.
  await expect(conversasPage.novaConversaStart()).toBeDisabled();
  await conversasPage.novaConversaPhone().fill(ABANDONED_PHONE);
  await expect(conversasPage.novaConversaStart()).toBeEnabled();

  // Período Chuvoso — cancel mid-operation leaves no partial write.
  await conversasPage.novaConversaCancel().click();
  await expect(conversasPage.novaConversaDialog()).toHaveCount(0);
  await expect(conversasPage.listItems()).toHaveCount(before);
  await expect(conversasPage.listItem(ABANDONED_PHONE)).toHaveCount(0);
  await mainPane();
});

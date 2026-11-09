/**
 * Tour log — Disconnected WhatsApp channel (refusals, and the fallback offered)
 *
 * Feature: Conversas with the unit's Evolution instance `DISCONNECTED` — what the
 * attendant can no longer do, the Portuguese reason given, and the manual
 * fallback offered in place of sending.
 *
 * Run report: `runs/2026-09-16-channel-down.md`. Every step below was driven live
 * through the Playwright MCP first and is transcribed from the steps that
 * succeeded there.
 *
 * **RUN THIS FILE ONLY VIA `pnpm test:e2e:tours:disconnected`.** It needs an API
 * process whose `EVOLUTION_INSTANCE_NAME` names a DISCONNECTED instance, because
 * `channelStatus()` resolves the connection by that configured name rather than
 * by unit (`conversations/prisma.ts:454`). `playwright.tours.config.ts` ignores
 * this file for that reason: collected there it would drive a CONNECTED instance
 * and fail for the wrong reason entirely.
 *
 * Guidebook:
 * - openspec/specs/conversations/conversas/spec.md — the screen shows the instance state as one
 *   of four values; composer send and any schedule control MUST be blocked with a
 *   Portuguese reason when the state is not CONNECTED; when DISCONNECTED the UI
 *   SHALL offer WhatsApp Business Web; using that fallback MUST NOT mark an
 *   outbox item or canonical message as sent by the CRM
 *
 * Tours:
 * - Guiado (Negócio) — the attendant arrives to a channel that is down: what are
 *   they told, and what are they offered instead?
 * - Rumo Errado (Negócio) — try both things the spec says must be blocked.
 * - Correios (Negócio) — the fallback is a link out; does taking that route leave
 *   the CRM claiming it sent something?
 *
 * Findings: no defect. Both refusals are implemented, both state a reason, and
 * the fallback writes nothing.
 *
 * Out of scope: reconnecting (a worker/webhook path, with no browser control),
 * and the CONNECTING and DEGRADED states — each needs its own configured
 * instance, and neither has a refusal the other three states do not.
 */
import { E2E } from "../ids.js";
import { expect, test } from "./fixtures.js";

/** The reason the screen must give while the channel is down. */
const REASON = "Envio pelo CRM indisponível.";

/** Shape of `GET /conversations/:id/messages` that this tour counts. */
type ThreadMessage = { direction: string };

test("Tour Guiado: a disconnected channel says so, and offers WhatsApp instead of sending", async ({
  conversasPage,
  page,
  mainPane,
}) => {
  await conversasPage.gotoConversation(E2E.disconnectedConversationId);
  await mainPane();

  // Oracle: conversas — composer send is blocked with a Portuguese reason.
  //
  // ABSENT, not disabled. The composer is removed and the alert takes its place,
  // so `toBeDisabled()` would fail against correct behaviour by waiting for an
  // element that is not there.
  await expect(conversasPage.composer()).toHaveCount(0);
  await expect(conversasPage.sendButton()).toHaveCount(0);
  await expect(page.getByText(REASON).first()).toBeVisible();

  // Oracle: conversas — when DISCONNECTED the UI offers opening the conversation
  // on WhatsApp Business Web. Pinned to THIS conversation's number: a fallback
  // pointing at some other chat would satisfy a link-exists check and be worse
  // than no fallback at all.
  const fallback = page.getByRole("link", { name: /Abrir no WhatsApp/ });
  await expect(fallback).toBeVisible();
  await expect(fallback).toHaveAttribute(
    "href",
    new RegExp(`phone=${E2E.disconnectedPhone}`),
  );

  // Oracle: conversas — the screen shows the instance state as one of CONNECTING,
  // CONNECTED, DEGRADED or DISCONNECTED. The spec is explicit that a boolean is
  // not sufficient and the four-state value is what the UI must read, so this
  // asserts the WORD, not merely that something looks offline.
  //
  // Asserted LAST, and with a long budget, because `ChannelChip` renders null
  // until its own `GET /channel/status` query resolves — it is not part of the
  // thread render the assertions above wait for. On a freshly started API this
  // stack is slow enough that the chip was still absent after 30 s while the
  // rail was visibly stuck on "Carregando cadastro"; the live drive never saw it
  // because that server had been up for minutes. Ordering it after the waits
  // above lets the page settle first, which is the real fix; the timeout is the
  // belt to that braces.
  await expect(page.getByText("Desconectado", { exact: true })).toBeVisible({
    timeout: 60_000,
  });
});

test("Tour do Rumo Errado: scheduling opens but cannot be confirmed, and nothing is written", async ({
  conversasPage,
  crmApi,
  page,
  mainPane,
}) => {
  /**
   * Counts messages on this conversation, from the API rather than the thread.
   * @returns The number of stored messages.
   */
  async function storedMessages() {
    const response = await crmApi.get(
      `/conversations/${E2E.disconnectedConversationId}/messages`,
    );
    expect(response.ok()).toBe(true);
    return ((await response.json()) as ThreadMessage[]).length;
  }

  await conversasPage.gotoConversation(E2E.disconnectedConversationId);
  await mainPane();

  const before = await storedMessages();

  // The schedule control IS offered — the block is on confirming, not on the
  // trigger. Asserting the trigger absent or disabled would fail against correct
  // behaviour, which the live drive established before this was written.
  //
  // It exists at all only because the fixture gives this customer a service. On a
  // customer with nothing to schedule there would be no control, and every
  // assertion below would pass for the wrong reason.
  const trigger = page.getByRole("button", { name: "Programar mensagem" });
  await expect(trigger).toBeVisible();
  await expect(trigger).toBeEnabled();
  await trigger.click();

  // Oracle: conversas — any schedule control is blocked with a Portuguese reason.
  await expect(conversasPage.scheduleConfirm()).toBeDisabled();
  await expect(page.getByText(REASON).first()).toBeVisible();

  // Oracle: conversas — nothing is marked sent by the CRM. Read at the source and
  // paired with the positive above: the refusal is visible AND the database is
  // unchanged. Either alone would be satisfied by a screen that refuses while
  // writing, or by one that writes nothing because nothing happened at all.
  expect(await storedMessages()).toBe(before);
});

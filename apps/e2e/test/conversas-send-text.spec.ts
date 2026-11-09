/**
 * Test design (testing-strategy + testing-playwright)
 *
 * Setup: SQL-seeded CONNECTED conversation (e2e-conv-send). Worker is not started.
 * Enqueue talks to the loopback Evolution mock, not the hosted instance.
 *
 * Oracle: conversas "Attendant can send text through the outbox" + repo-foundation
 * "Open thread send-text enqueues without claiming WhatsApp delivery".
 *
 * Axes: non-empty send vs empty (empty is component-tested).
 * Out of scope: live Evolution delivery; media send.
 */
import { expect, test } from "./fixtures.js";
import { E2E } from "./ids.js";

test("send text enqueues and does not claim WhatsApp delivery", async ({
  conversasPage,
  crmApi,
  page,
}) => {
  await conversasPage.goto();
  await conversasPage.inbox().waitFor();

  await conversasPage.listConversation(E2E.sendConversationId).click();
  await conversasPage.composer().fill(E2E.sendText);
  await conversasPage.sendButton().click();

  await expect(conversasPage.composer()).toHaveValue("");
  await expect(page.getByText(/enviad[oa] no WhatsApp/i)).toHaveCount(0);

  const messages = await crmApi.get(`/conversations/${E2E.sendConversationId}/messages`);
  expect(messages.ok()).toBe(true);
  const body = (await messages.json()) as Array<{
    textBody: string | null;
    direction: string;
    outboxStatus?: string;
  }>;
  const queued = body.find((row) => row.direction === "outbound" && row.textBody === E2E.sendText);
  expect(queued?.outboxStatus).toBe("queued");
});

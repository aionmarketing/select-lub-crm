/**
 * Test design (testing-strategy + testing-playwright)
 *
 * Setup: live Playwright config (API + Vite + worker, real SERVER_URL). Gate
 *   skips unless E2E_LIVE_SCHEDULE=1, local DATABASE_URL, conversation
 *   chatKey 5519000000002, instance CONNECTED. No e2e SQL seed. Worker
 *   started. Retries 0. Cases serial. Cancel runs first so the due-send is
 *   the only case that lets scheduledAt elapse.
 *
 * Oracle: live-scheduled-messages repo-foundation — far-future cancel does
 *   not send; near-due Programar mensagem becomes SENT to 5519000000002;
 *   confirm does not claim WhatsApp delivery before scheduledAt. Product
 *   oracles: scheduled-messages due dispatch; conversas confirm does not
 *   send now.
 *
 * Locators: conversas-inbox, conversas-programar-free, Data/Hora labels,
 *   conversas-schedule-text/confirm, conversas-programada-row, Cancelar envio.
 *
 * Axes
 *   A1 action — cancel far-future / due send
 *   A2 dest — 5519000000002 vs 5519000000001
 *
 * Outputs
 *   O1 CANCELLED, and no outbox row at all for that body
 *   O2 SENT, exactly one outbox row `confirmed` with attemptCount 0 and an
 *      externalMessageId, one canonical outbound message, composer never
 *      "já enviad" at confirm
 *   O3 chatKey is 5519000000002
 *
 * Outbox oracle reads Postgres, not `outboxStatus` from
 *   `GET /conversations/:id/messages`: that field is attached only to rows that
 *   are NOT `confirmed`, so "confirmed" is unreachable there and a negative
 *   written against it passes vacuously.
 *
 * Sampled-cell
 *   cancel first     | A1 cancel | O1 | send
 *   due send second  | A1 send   | O2 O3 | dest 5519000000001
 *
 * Out of scope: occupied-service (optional); return reminders; CI.
 *
 * Clock: date/time inputs are minute resolution, so near-due is ~70s ahead
 *   (not 15s) so scheduledAt cannot land in the current minute (already past).
 */
import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "./fixtures.js";
import { FORBIDDEN_SCHEDULE_CHAT_KEY, LIVE_SCHEDULE_CHAT_KEY } from "./ids.js";
import { outboxRowsFor } from "./outbox.js";
import { LIVE_RUN_ID } from "./run-id.js";
import { saoPauloDateAndTime } from "./sao-paulo.js";

const cancelBody = `live-sched-cancel-${LIVE_RUN_ID}`;
const sendBody = `live-sched-send-${LIVE_RUN_ID}`;

type ScheduleRow = {
  text: string;
  status: string;
  serviceId: string | null;
};

type ThreadMessage = {
  textBody: string | null;
  direction: string;
  outboxStatus?: string;
};

async function listedSchedules(crmApi: APIRequestContext, conversationId: string) {
  const listed = await crmApi.get(`/conversations/${conversationId}/scheduled-messages`);
  expect(listed.ok()).toBe(true);
  return (await listed.json()) as ScheduleRow[];
}

async function listedMessages(crmApi: APIRequestContext, conversationId: string) {
  const messages = await crmApi.get(`/conversations/${conversationId}/messages`);
  expect(messages.ok()).toBe(true);
  return (await messages.json()) as ThreadMessage[];
}

test.describe.serial("live Programar mensagem", () => {
  test("far-future confirm then cancel does not send", async ({
    conversasPage,
    crmApi,
    liveConversation,
    liveServiceId,
    page,
  }) => {
    expect(liveConversation.chatKey).toBe(LIVE_SCHEDULE_CHAT_KEY);
    expect(liveConversation.chatKey).not.toBe(FORBIDDEN_SCHEDULE_CHAT_KEY);

    await conversasPage.gotoConversation(liveConversation.id);
    await conversasPage.inbox().waitFor();
    await expect(conversasPage.programarFree(liveServiceId)).toBeVisible();
    await conversasPage.programarFree(liveServiceId).click();
    await expect(page.getByRole("dialog", { name: "Programar mensagem" })).toBeVisible();
    await expect(conversasPage.scheduleDate()).not.toHaveValue("");

    await conversasPage.scheduleDate().fill("2099-06-15");
    await conversasPage.scheduleTime().fill("15:00");
    await conversasPage.scheduleText().fill(cancelBody);
    await expect(conversasPage.scheduleConfirm()).toBeEnabled();
    await conversasPage.scheduleConfirm().click();
    await expect(page.getByRole("dialog", { name: "Programar mensagem" })).toBeHidden();

    await conversasPage.programadaRow(cancelBody).click();
    await expect(conversasPage.scheduleCancelSend()).toBeEnabled();
    await conversasPage.scheduleCancelSend().click();
    await expect(page.getByText("Cancelada")).toBeVisible();

    const rows = await listedSchedules(crmApi, liveConversation.id);
    const cancelled = rows.find((row) => row.text === cancelBody);
    expect(cancelled?.status).toBe("CANCELLED");

    // Assert on the outbox table, not `outboxStatus` over HTTP: that field is only
    // attached to rows that are NOT confirmed, so a negative on it passes vacuously.
    expect(await outboxRowsFor(liveConversation.id, cancelBody)).toEqual([]);

    const body = await listedMessages(crmApi, liveConversation.id);
    expect(body.some((row) => row.textBody === cancelBody)).toBe(false);
  });

  test("near-due confirm becomes SENT to 5519000000002", async ({
    conversasPage,
    crmApi,
    liveConversation,
    liveServiceId,
    page,
  }) => {
    expect(liveConversation.chatKey).toBe(LIVE_SCHEDULE_CHAT_KEY);
    expect(liveConversation.chatKey).not.toBe(FORBIDDEN_SCHEDULE_CHAT_KEY);

    await conversasPage.gotoConversation(liveConversation.id);
    await conversasPage.inbox().waitFor();
    await expect(conversasPage.programarFree(liveServiceId)).toBeVisible();
    await conversasPage.programarFree(liveServiceId).click();
    await expect(page.getByRole("dialog", { name: "Programar mensagem" })).toBeVisible();
    await expect(conversasPage.scheduleDate()).not.toHaveValue("");

    const due = saoPauloDateAndTime(new Date(Date.now() + 70_000));
    await conversasPage.scheduleDate().fill(due.date);
    await conversasPage.scheduleTime().fill(due.time);
    await conversasPage.scheduleText().fill(sendBody);
    await expect(conversasPage.scheduleConfirm()).toBeEnabled();
    await conversasPage.scheduleConfirm().click();

    await expect(page.getByText(/já enviad/i)).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "Programar mensagem" })).toBeHidden();

    await expect
      .poll(
        async () => {
          const rows = await listedSchedules(crmApi, liveConversation.id);
          const outbox = await outboxRowsFor(liveConversation.id, sendBody);
          return {
            status: rows.find((row) => row.text === sendBody)?.status ?? "",
            outbox: outbox.map((row) => row.status),
          };
        },
        { timeout: 90_000 },
      )
      .toEqual({ status: "SENT", outbox: ["confirmed"] });

    // Exactly one send, and Evolution really accepted it.
    const [delivered] = await outboxRowsFor(liveConversation.id, sendBody);
    expect(delivered.attemptCount).toBe(0);
    expect(delivered.lastError).toBeNull();
    expect(delivered.externalMessageId).not.toBeNull();

    // The confirmed send is represented by a canonical outbound message.
    const messages = await listedMessages(crmApi, liveConversation.id);
    expect(
      messages.filter((row) => row.direction === "outbound" && row.textBody === sendBody),
    ).toHaveLength(1);
  });
});

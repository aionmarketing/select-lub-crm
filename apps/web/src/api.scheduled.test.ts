/**
 * Test design (testing-strategy)
 *
 * Setup: scheduled-message API wrappers against MSW.
 *
 * Oracle: shared-types scheduledMessageSchema / suggestScheduleDateResultSchema;
 * scheduled-messages HTTP — list, create, cancel, suggest-date.
 *
 * Axes
 *   A1 HTTP status: 2xx vs not
 *   A2 wrapper: list / create / cancel / suggest
 *
 * Outputs: O1 parsed body; O2 throw
 *
 * Sampled-cell
 *   list 200                | A1 2xx A2 list    | O1 | throw
 *   create 201              | A1 2xx A2 create  | O1 | throw
 *   cancel 200              | A1 2xx A2 cancel  | O1 | throw
 *   suggest 200             | A1 2xx A2 suggest | O1 | throw
 *   list 500                | A1 500 A2 list    | O2 | parses
 *
 * Decision map (api/scheduled.ts + api/http.ts parse)
 *   D1 parse() !ok T: list 500; F: 2xx its
 *
 * Out of scope: ConversasPage.scheduled.test; Fastify inject.
 */
import { afterEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import {
  cancelScheduledMessage,
  createScheduledMessage,
  fetchScheduledMessages,
  suggestScheduleDate,
} from "./api.js";
import { server } from "../test/msw/server.js";

const row = {
  id: "sch-1",
  customerId: "cus-1",
  conversationId: "conv-1",
  serviceId: "svc-1",
  returnReminderMessageId: null,
  templateId: null,
  text: "Retorno da troca de óleo",
  scheduledAt: "2099-01-15T13:00:00.000Z",
  timeZone: "America/Sao_Paulo",
  status: "SCHEDULED" as const,
  idempotencyKey: "idem-1",
  suggestedAt: "2026-07-15T03:00:00.000Z",
  suggestionSource: "six_months" as const,
  createdByUserId: "user-1",
  createdAt: "2026-08-31T12:00:00.000Z",
};

afterEach(() => {
  server.resetHandlers();
});

describe("scheduled messages API client", () => {
  it("parses a scheduled-message list", async () => {
    server.use(
      http.get("*/api/conversations/:id/scheduled-messages", () => HttpResponse.json([row])),
    );

    await expect(fetchScheduledMessages("conv-1")).resolves.toEqual([row]);
  });

  it("parses a created scheduled message", async () => {
    server.use(
      http.post("*/api/conversations/:id/scheduled-messages", () =>
        HttpResponse.json(row, { status: 201 }),
      ),
    );

    await expect(
      createScheduledMessage("conv-1", {
        text: "Retorno da troca de óleo",
        scheduledAt: "2099-01-15T13:00:00.000Z",
        serviceId: "svc-1",
      }),
    ).resolves.toEqual(row);
  });

  it("parses a cancelled scheduled message", async () => {
    server.use(
      http.post("*/api/conversations/:id/scheduled-messages/:scheduleId/cancel", () =>
        HttpResponse.json({ ...row, status: "CANCELLED" }),
      ),
    );

    await expect(cancelScheduledMessage("conv-1", "sch-1")).resolves.toEqual({
      ...row,
      status: "CANCELLED",
    });
  });

  it("parses a suggested schedule date", async () => {
    server.use(
      http.get("*/api/services/:id/suggest-schedule-date", () =>
        HttpResponse.json({
          suggestedAt: "2026-07-15T03:00:00.000Z",
          suggestionSource: "six_months",
        }),
      ),
    );

    await expect(suggestScheduleDate("svc-1")).resolves.toEqual({
      suggestedAt: "2026-07-15T03:00:00.000Z",
      suggestionSource: "six_months",
    });
  });

  it("throws when the list status is not ok", async () => {
    server.use(
      http.get("*/api/conversations/:id/scheduled-messages", () =>
        HttpResponse.json({ error: "fail" }, { status: 500 }),
      ),
    );

    await expect(fetchScheduledMessages("conv-1")).rejects.toThrow();
  });
});

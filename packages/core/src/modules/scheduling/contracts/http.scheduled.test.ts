/**
 * Test design (testing-strategy)
 *
 * Setup: zod parse / safeParse on scheduled-message contracts. No HTTP.
 *
 * Oracle: scheduled-messages shared-types delta — ScheduledMessage requires
 *   non-empty text and createdByUserId; create body requires future
 *   scheduledAt; suggest-date six_months parses; ConversationSummary has
 *   no schedules array; send-text/send-media parse with idempotencyKey
 *   omitted or present; OutboxStatus includes cancelled.
 *
 * Axes
 *   A1 ScheduledMessage.text — "Olá" / "" / "   "
 *   A2 createdByUserId — present / omitted
 *   A3 create.scheduledAt — future ISO / past ISO / unparseable
 *   A4 suggest.suggestionSource — six_months / rule
 *   A5 send idempotencyKey — omitted / non-empty
 *   A6 returnReminderMessageId — null (rail row) / set (reminder row) / absent
 *   A6 ConversationSummary keys — no schedules
 *   A7 OutboxStatus — cancelled
 *   A8 ScheduledMessageStatus — each of the six accepted values, and a
 *      plausible-but-absent one ("ARCHIVED", which is a vehicle_return status,
 *      not a scheduled-message one). Closed vocabulary, so no BVA row.
 *   BVA: text trim min(1) "" / "   " / "A"; scheduledAt past vs future
 *
 * Outputs: O1 parse ok; O2 safeParse fails; O3 PAUSED is not a member, so no
 *   set-aside state exists for a consumer to handle
 *
 * Sampled-cell
 *   scheduled row SCHEDULED     | A1 A2     | O1 | throw
 *   empty text                  | A1 BVA    | O2 | success
 *   whitespace text             | A1 BVA    | O2 | success
 *   omitted createdByUserId     | A2        | O2 | success
 *   create future scheduledAt   | A3        | O1 | throw
 *   create past scheduledAt     | A3 BVA    | O2 | success
 *   suggest six_months          | A4        | O1 | throw
 *   send-text omits key         | A5        | O1 | throw
 *   send-text with key          | A5        | O1 | throw
 *   send-media omits key        | A5        | O1 | throw
 *   summary has no schedules    | A6        | O1 | schedules in shape
 *   cancelled outbox status     | A7        | O1 | reject
 *
 * Decision / branch map (scheduled.ts + send schemas)
 *   text trim min(1)            T scheduled-row / create-future; F empty/ws
 *   createdByUserId required    T scheduled-row; F omitted it
 *   Date.parse ok && > now      T create-future; F past it
 *   suggestionSource enum       T six_months it
 *   idempotencyKey optional     T omitted its; F (present) with-key it
 *   outbox enum cancelled       T cancelled it
 *
 * Out of scope: HTTP 409 CONNECTED (task 2.2); Prisma tables (task 1.2);
 *   due-loop (task 3.x); rail UI (scheduled-messages-ui).
 */
import { describe, expect, it } from "vitest";
import { conversationSummarySchema, outboxStatusSchema, sendMediaBodySchema, sendTextBodySchema } from "../../conversations/contracts/http.js";
import { createScheduledMessageBodySchema, scheduledMessageSchema, scheduledMessageStatusSchema, suggestScheduleDateResultSchema } from "./http.scheduled.js";

const scheduledRow = {
  id: "sch-1",
  customerId: null,
  conversationId: "conv-1",
  serviceId: null,
  returnReminderMessageId: null,
  templateId: null,
  text: "Olá Maria",
  scheduledAt: "2026-09-15T12:00:00.000Z",
  timeZone: "America/Sao_Paulo",
  status: "SCHEDULED" as const,
  idempotencyKey: "key-1",
  suggestedAt: null,
  suggestionSource: null,
  createdByUserId: "user-1",
  createdAt: "2026-08-31T04:00:00.000Z",
};

describe("scheduledMessageStatusSchema", () => {
  it("accepts every lifecycle state a row can hold", () => {
    for (const value of ["SCHEDULED", "PROCESSING", "SENT", "CANCELLED", "FAILED"]) {
      expect(scheduledMessageStatusSchema.parse(value)).toBe(value);
    }
  });

  it("has no set-aside state, so stopping a reminder can only be terminal", () => {
    // PAUSED existed for one job: holding a return's reminders while the return
    // was archived. Archiving now takes the row off the Follow-up queue and
    // leaves reminders alone (decided 2026-09-03), so nothing could produce a
    // paused row — and a status nothing produces invites code for a state that
    // never occurs.
    expect(scheduledMessageStatusSchema.safeParse("PAUSED").success).toBe(false);
  });

  it("rejects a vehicle-return status, which is a different vocabulary", () => {
    expect(scheduledMessageStatusSchema.safeParse("ARCHIVED").success).toBe(false);
  });
});

describe("scheduledMessageSchema", () => {
  it("parses a SCHEDULED row with non-empty text and an idempotencyKey", () => {
    const parsed = scheduledMessageSchema.parse(scheduledRow);

    expect(parsed.text).toBe("Olá Maria");
    expect(parsed.status).toBe("SCHEDULED");
    expect(parsed.createdByUserId).toBe("user-1");
  });

  it("tells a return reminder apart from a rail-created row", () => {
    // The distinction decides who the per-service block applies to: a rail row
    // occupies its service, a reminder row names the same service and does not.
    expect(scheduledMessageSchema.parse(scheduledRow).returnReminderMessageId).toBeNull();
    expect(
      scheduledMessageSchema.parse({ ...scheduledRow, returnReminderMessageId: "rem-1" })
        .returnReminderMessageId,
    ).toBe("rem-1");
    // Not optional: an absent field would be a third state nobody defined.
    const without: Partial<typeof scheduledRow> = { ...scheduledRow };
    delete without.returnReminderMessageId;
    expect(scheduledMessageSchema.safeParse(without).success).toBe(false);
  });

  it("rejects empty scheduled text", () => {
    expect(scheduledMessageSchema.safeParse({ ...scheduledRow, text: "" }).success).toBe(false);
  });

  it("rejects whitespace-only scheduled text", () => {
    expect(scheduledMessageSchema.safeParse({ ...scheduledRow, text: "   " }).success).toBe(false);
  });

  it("rejects a payload that omits createdByUserId", () => {
    const without: Partial<typeof scheduledRow> = { ...scheduledRow };
    delete without.createdByUserId;

    expect(scheduledMessageSchema.safeParse(without).success).toBe(false);
  });
});

describe("createScheduledMessageBodySchema", () => {
  it("parses a create body with future scheduledAt", () => {
    const parsed = createScheduledMessageBodySchema.parse({
      text: "Olá Maria",
      scheduledAt: "2099-01-15T15:00:00.000Z",
      conversationId: "conv-1",
    });

    expect(parsed.text).toBe("Olá Maria");
    expect(parsed.conversationId).toBe("conv-1");
  });

  it("rejects a create body whose scheduledAt is in the past", () => {
    expect(
      createScheduledMessageBodySchema.safeParse({
        text: "Olá Maria",
        scheduledAt: "2020-01-15T15:00:00.000Z",
      }).success,
    ).toBe(false);
  });
});

describe("suggestScheduleDateResultSchema", () => {
  it("parses a six_months suggest-date payload", () => {
    const parsed = suggestScheduleDateResultSchema.parse({
      suggestedAt: "2026-07-15T03:00:00.000Z",
      suggestionSource: "six_months",
    });

    expect(parsed.suggestionSource).toBe("six_months");
  });
});

describe("send bodies accept optional idempotencyKey", () => {
  it("parses send-text with only text", () => {
    expect(sendTextBodySchema.parse({ text: "oi" })).toEqual({ text: "oi" });
  });

  it("parses send-text with a non-empty idempotencyKey", () => {
    expect(sendTextBodySchema.parse({ text: "oi", idempotencyKey: "idem-1" })).toEqual({
      text: "oi",
      idempotencyKey: "idem-1",
    });
  });

  it("parses send-media when idempotencyKey is omitted", () => {
    expect(sendMediaBodySchema.parse({ messageType: "image" })).toEqual({ messageType: "image" });
  });
});

describe("inbox contract stays without schedules", () => {
  it("does not put a schedules array on ConversationSummary", () => {
    expect("schedules" in conversationSummarySchema.shape).toBe(false);
  });

  it("parses cancelled as an OutboxStatus", () => {
    expect(outboxStatusSchema.parse("cancelled")).toBe("cancelled");
  });
});

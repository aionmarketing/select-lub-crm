/**
 * Zod contracts for deferred WhatsApp sends and schedule-date suggestions.
 *
 * Moved from `packages/shared-types/src/scheduled.ts` (5.1d) with declarations unchanged.
 */
import { z } from "zod";

/**
 * Outbox lifecycle state for a row in the scheduled-messages queue.
 *
 * There is deliberately no set-aside state. `PAUSED` existed only because
 * archiving a vehicle return used to stop that return's reminders; archiving
 * now takes the row off the Follow-up queue and nothing else (decided
 * 2026-09-03), so nothing could produce a paused row. Stopping a reminder is
 * its own action on the reminder, and it is `CANCELLED` — terminal, and chosen.
 */
export const scheduledMessageStatusSchema = z.enum([
  "SCHEDULED",
  "PROCESSING",
  "SENT",
  "CANCELLED",
  "FAILED",
]);

/** Origin of an auto-suggested send date (business rule vs. six-month follow-up). */
export const suggestionSourceSchema = z.enum(["rule", "six_months"]);

/** Response body for a scheduled message row in list and detail endpoints. */
export const scheduledMessageSchema = z.object({
  id: z.string(),
  customerId: z.string().nullable(),
  conversationId: z.string().nullable(),
  serviceId: z.string().nullable(),
  /**
   * Set when this row is one send moment of a return's reminder message.
   * Consumers use it to tell a reminder apart from a rail-created schedule:
   * only the latter occupies a service, so only the latter blocks Programar.
   */
  returnReminderMessageId: z.string().nullable(),
  templateId: z.string().nullable(),
  text: z.string().trim().min(1),
  scheduledAt: z.string().min(1),
  timeZone: z.string().min(1),
  status: scheduledMessageStatusSchema,
  idempotencyKey: z.string().min(1),
  suggestedAt: z.string().nullable(),
  suggestionSource: suggestionSourceSchema.nullable(),
  createdByUserId: z.string().min(1),
  createdAt: z.string().min(1),
});

/**
 * Response body for the detail read of one scheduled message.
 *
 * Extends the list row with what the Conversas rail drill-in shows and cannot
 * get from an id: the template's name, the originating service's own labels,
 * and the creator's name. Resolved here rather than left as three ids so the
 * drill-in is one request; a screen that had to fetch template, service and
 * user separately would render the moment before it could name its origin.
 *
 * `lastError` carries the recorded failure reason and is non-null only when
 * `status` is `FAILED` — the falhou state the spec requires to explain itself.
 */
export const scheduledMessageDetailSchema = scheduledMessageSchema.extend({
  lastError: z.string().nullable(),
  templateName: z.string().nullable(),
  createdByName: z.string().nullable(),
  originatingService: z
    .object({
      id: z.string(),
      omieId: z.string().nullable(),
      description: z.string().nullable(),
      performedAt: z.string().nullable(),
    })
    .nullable(),
});

/** One scheduled message in full: its row, its recorded error, and its resolved origin labels. */
export type ScheduledMessageDetail = z.infer<typeof scheduledMessageDetailSchema>;

/** Client error when a second non-cancelled schedule is confirmed for the same service. Reminder rows do not count — a return may carry several. Distinct from channel-down 409 `{ state }`. */
export const scheduleConflictErrorSchema = z.object({
  error: z.literal("conflict"),
});

/** Request body for `POST` to schedule a future outbound message; `scheduledAt` must be in the future. */
export const createScheduledMessageBodySchema = z.object({
  text: z.string().trim().min(1),
  scheduledAt: z
    .string()
    .min(1)
    .refine((value) => {
      const at = Date.parse(value);
      return !Number.isNaN(at) && at > Date.now();
    }, "scheduledAt must be a future instant"),
  conversationId: z.string().min(1).optional(),
  serviceId: z.string().min(1).optional(),
  templateId: z.string().min(1).optional(),
});

/** Response body for a suggested send date derived from service or follow-up rules. */
export const suggestScheduleDateResultSchema = z.object({
  suggestedAt: z.string().min(1),
  suggestionSource: suggestionSourceSchema,
});

/** Outbox lifecycle state for a row in the scheduled-messages queue. */
export type ScheduledMessageStatus = z.infer<typeof scheduledMessageStatusSchema>;

/** Origin of an auto-suggested send date (business rule vs. six-month follow-up). */
export type SuggestionSource = z.infer<typeof suggestionSourceSchema>;

/** Scheduled message row in list and detail API responses. */
export type ScheduledMessage = z.infer<typeof scheduledMessageSchema>;

/** Request body for `POST` to schedule a future outbound message; `scheduledAt` must be in the future. */
export type CreateScheduledMessageBody = z.infer<typeof createScheduledMessageBodySchema>;

/** Response body for a list of scheduled messages. */
export const scheduledMessageListSchema = z.array(scheduledMessageSchema);

/** Suggested send date derived from service or follow-up rules. */
export type SuggestScheduleDateResult = z.infer<typeof suggestScheduleDateResultSchema>;

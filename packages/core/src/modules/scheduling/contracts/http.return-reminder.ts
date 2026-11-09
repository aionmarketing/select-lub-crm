/**
 * Zod contracts for the return-reminder HTTP surface: create, edit and cancel a
 * reminder message on a vehicle return, and archive or unarchive the return.
 *
 * Send moments travel as named directions rather than a signed number — see
 * {@link ReminderTrigger} in `reminder-plan.ts`. Each offset moment carries its
 * own `time`, because the attendant may want a month-early nudge in the morning
 * and the on-the-day one after lunch.
 *
 * Errors are codes, not sentences: the web layer owns the Portuguese, the same
 * split the existing schedule routes already use.
 *
 * Moved from `packages/shared-types/src/return-reminder-http.ts` (5.1d) with declarations unchanged.
 */
import { z } from "zod";
import { scheduledMessageSchema } from "./http.scheduled.js";

/** São Paulo wall-clock time one offset moment fires at. */
export const reminderTimeOfDaySchema = z.object({
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59),
});

/**
 * One send moment.
 *
 * `before` and `after` are offsets from the return date; `days` is
 * non-negative in both, and 0 in either means the return date itself ("no dia").
 * `absolute` is the attendant naming an exact instant, which a later edit to
 * the return date MUST NOT move.
 */
export const reminderTriggerSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("before"),
    days: z.number().int().nonnegative(),
    time: reminderTimeOfDaySchema,
  }),
  z.object({
    kind: z.literal("after"),
    days: z.number().int().nonnegative(),
    time: reminderTimeOfDaySchema,
  }),
  z.object({ kind: z.literal("absolute"), at: z.string().min(1) }),
]);

/**
 * Body for creating a reminder message on a return.
 *
 * `triggers` is non-empty at the schema level: a message nobody will ever send
 * is not a plan, so an empty list is a malformed request rather than a
 * business rejection.
 */
export const createReturnReminderBodySchema = z.object({
  conversationId: z.string().min(1),
  triggers: z.array(reminderTriggerSchema).min(1).max(20),
  /** Omit to use the composed Portuguese default. */
  bodyTemplate: z.string().trim().min(1).optional(),
  templateId: z.string().min(1).nullable().optional(),
});

/**
 * Body for editing a reminder message. Every field optional; send what changed.
 *
 * `triggers` is a **replace**, not a delta: it is the complete desired set of
 * un-sent moments. The operator edits a list, so making the client compute a
 * diff would duplicate work they already expressed. Moments already sent are
 * never touched and never need listing.
 */
export const updateReturnReminderBodySchema = z.object({
  triggers: z.array(reminderTriggerSchema).min(1).max(20).optional(),
  bodyTemplate: z.string().trim().min(1).optional(),
});

/**
 * What a reminder message looks like to the screen.
 *
 * Carries EVERY scheduled message, sent ones included, ordered by send instant.
 * The overlay lists what the customer was already told beside what they will be
 * told, so a payload holding only pending rows could not draw it.
 */
export const returnReminderMessageSchema = z.object({
  reminderMessageId: z.string().min(1),
  vehicleReturnId: z.string().min(1),
  bodyTemplate: z.string(),
  cancelledAt: z.string().nullable(),
  scheduledMessages: z.array(scheduledMessageSchema),
});

/**
 * Why a reminder write was refused.
 *
 * `at` names the offending moment on the two trigger rejections, so the screen
 * can point at one row instead of saying "one of them".
 */
export const returnReminderErrorSchema = z.object({
  error: z.enum([
    "return_not_open",
    "return_not_archived",
    "no_performed_at",
    "trigger_in_past",
    "duplicate_trigger",
    "no_triggers",
    "message_cancelled",
  ]),
  at: z.string().optional(),
});

export type ReminderTimeOfDay = z.infer<typeof reminderTimeOfDaySchema>;

export type ReminderTriggerBody = z.infer<typeof reminderTriggerSchema>;

export type CreateReturnReminderBody = z.infer<typeof createReturnReminderBodySchema>;

export type UpdateReturnReminderBody = z.infer<typeof updateReturnReminderBodySchema>;

export type ReturnReminderMessage = z.infer<typeof returnReminderMessageSchema>;

export type ReturnReminderError = z.infer<typeof returnReminderErrorSchema>;

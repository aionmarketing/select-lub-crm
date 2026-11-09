/**
 * Zod contracts for `GET /follow-ups`: four section lists plus matching counts.
 *
 * Moved from `packages/shared-types/src/follow-up.ts` (5.1d) with declarations unchanged.
 */
import { z } from "zod";

/** Max rows returned per Follow-up section (same cap as unanswered). */
export const FOLLOW_UP_LIST_CAP = 100;

const isoInstant = z.string().min(1);

const id = z.string().min(1);

/**
 * A return closed out of its section, with who did it and when.
 *
 * Hangs off the VEHICLE rather than the entry. Closing acts on one
 * `VehicleReturn`, and a vencido entry covers every overdue car of one
 * customer — so an entry-level field could not say which of three cars was
 * closed, and would have had to invent an answer for a customer with two.
 */
export const followUpArchivedSchema = z.object({
  at: isoInstant,
  byUserId: z.string().min(1),
});

/** A message-pendency entry the attendant closed, against the anchor that qualified it. */
export const followUpClosedSchema = z.object({
  anchor: z.string().min(1),
  at: isoInstant,
  byUserId: z.string().min(1),
});

/** Conversation with an unanswered oil quote (collapsed to the newest quote). */
export const followUpQuoteEntrySchema = z.object({
  conversationId: id,
  quoteId: id,
  quoteSentAt: isoInstant,
  label: z.string(),
  /**
   * The thread message carrying this quote, so the entry opens the conversation
   * positioned on it.
   *
   * Null when it cannot be derived: `OilQuote` has no foreign key to `Message`,
   * so the server matches the quote text against the conversation's outbound
   * messages and falls back to the earliest outbound at or after the quote. A
   * null degrades to the conversation's normal position rather than blocking
   * the link.
   */
  quoteMessageId: id.nullable(),
  /** Present only in the closed-entries view. */
  closed: followUpClosedSchema.optional(),
});

/** Conversation with a pending `shouldReply: true` inbound and no later outbound. */
export const followUpWaitingEntrySchema = z.object({
  conversationId: id,
  oldestPendingAt: isoInstant,
  label: z.string(),
  /** Present only in the closed-entries view. */
  closed: followUpClosedSchema.optional(),
});

/* -------------------------------------------------------------------------
 * Return entries, reshaped (design approved 2026-09-02)
 *
 * The two sections no longer share a shape. Vencido groups per customer — one
 * message to one person about every late car of theirs. Aproximando is one row
 * per customer-vehicle pair, ordered by imminence, because grouping it would
 * destroy the only ordering that section is read for.
 * ------------------------------------------------------------------------- */

/**
 * What a return's reminders amount to, for a row that has some.
 *
 * Not a boolean. `hasScheduledFollowUp` could not say how many nor when the next
 * one lands, and a return may carry several. Absent entirely when the return
 * holds no un-sent reminder — `{ count: 0 }` would be a different claim.
 */
export const plannedRemindersSchema = z.object({
  /** Un-sent reminders on this return. At least one, or the field is absent. */
  count: z.number().int().positive(),
  /** Send instant of the earliest of them. */
  nextAt: isoInstant,
});

/** One vehicle inside a return entry, with the return it belongs to. */
export const followUpDueVehicleSchema = z.object({
  vehicleId: id,
  /** Absent when the vehicle carries neither, which the row renders as blank. */
  plate: z.string().nullable(),
  model: z.string().nullable(),
  returnId: id,
  /** The stored return date, authoritative and editable — never recomputed. */
  returnDate: z.string().min(1),
  /** The service the return was dated from. */
  sourceServiceId: id,
  plannedReminders: plannedRemindersSchema.optional(),
  /**
   * The thread message of the most recent reminder already SENT for this
   * return, so the planned-reminder indicator can open the conversation on it.
   * Absent while every reminder is still un-sent — there is no message to
   * position on until one has gone out.
   */
  sentReminderMessageId: id.optional(),
  /** Present only in the closed-entries view: this return is closed. */
  closed: followUpArchivedSchema.optional(),
});

/** Retorno vencido: one entry per customer, listing every overdue vehicle. */
export const followUpOverdueEntrySchema = z.object({
  customerId: id,
  conversationId: id.nullable(),
  label: z.string(),
  vehicles: z.array(followUpDueVehicleSchema).min(1),
});

/** Retorno se aproximando: one entry per customer-vehicle pair. */
export const followUpUpcomingEntrySchema = z.object({
  customerId: id,
  conversationId: id.nullable(),
  label: z.string(),
  vehicle: followUpDueVehicleSchema,
});

/**
 * Section counts, each optional.
 *
 * An absent count means "not known" — the lists failed, or this consumer asked
 * for counts alone. It is deliberately distinguishable from zero, which means
 * "nothing pending": rendering the two the same is what made the shipped error
 * state draw 0/0/0/0 at the moment nothing was known.
 */
export const followUpOptionalCountsSchema = z.object({
  unansweredQuotes: z.number().int().nonnegative().optional(),
  overdueReturns: z.number().int().nonnegative().optional(),
  upcomingReturns: z.number().int().nonnegative().optional(),
  waitingReply: z.number().int().nonnegative().optional(),
});

/** The two sections whose entries close through the closed-entry table. */
export const followUpCloseBodySchema = z.object({
  section: z.enum(["unansweredQuotes", "waitingReply"]),
  conversationId: id,
  /** What qualified the entry: the quote id, or the pending inbound instant. */
  anchor: z.string().min(1),
});

export type FollowUpCloseBody = z.infer<typeof followUpCloseBodySchema>;

export type FollowUpClosed = z.infer<typeof followUpClosedSchema>;

export type PlannedReminders = z.infer<typeof plannedRemindersSchema>;

export type FollowUpDueVehicle = z.infer<typeof followUpDueVehicleSchema>;

export type FollowUpOverdueEntry = z.infer<typeof followUpOverdueEntrySchema>;

export type FollowUpUpcomingEntry = z.infer<typeof followUpUpcomingEntrySchema>;

export type FollowUpOptionalCounts = z.infer<typeof followUpOptionalCountsSchema>;

/** Full `GET /follow-ups` payload: lists plus counts that match those lists. */
export const followUpResultSchema = z.object({
  counts: followUpOptionalCountsSchema,
  unansweredQuotes: z.array(followUpQuoteEntrySchema).max(FOLLOW_UP_LIST_CAP),
  overdueReturns: z.array(followUpOverdueEntrySchema).max(FOLLOW_UP_LIST_CAP),
  upcomingReturns: z.array(followUpUpcomingEntrySchema).max(FOLLOW_UP_LIST_CAP),
  waitingReply: z.array(followUpWaitingEntrySchema).max(FOLLOW_UP_LIST_CAP),
});

export type FollowUpQuoteEntry = z.infer<typeof followUpQuoteEntrySchema>;

export type FollowUpWaitingEntry = z.infer<typeof followUpWaitingEntrySchema>;

export type FollowUpResult = z.infer<typeof followUpResultSchema>;

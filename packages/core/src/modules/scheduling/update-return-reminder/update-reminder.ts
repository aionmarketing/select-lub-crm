/**
 * Editing a reminder message: replacing its un-sent moments and/or rewriting
 * its text. Moved from `packages/db/src/return-reminders.ts`
 * (`updateReturnReminderMessage`).
 *
 * It used to open its own transaction for the writes; it now runs on its
 * caller's `db.tx("scheduling", …)`, so the read and the writes are one commit.
 */
import { randomUUID } from "node:crypto";
import { planReminderMessage, resolveReminderText, type ReminderTrigger } from "../contracts/http.js";
import { SCHEDULE_TIME_ZONE } from "../../services/contracts/http.js";
import type { DbClient } from "../../../kernel/db.js";
import { cancelUnlessPickedUp, rewriteUnlessPickedUp } from "../contracts/unsent.js";
import { calendarDay, returnInterval, serviceLabel, vehicleLabel } from "../internal/reminder-text.js";

/** What an edit produced, or why nothing changed. */
export type UpdateReturnReminderResult =
  | { status: "ok"; created: number; cancelled: number; rewritten: number }
  | { status: "not_found" }
  | { status: "message_cancelled" }
  | { status: "return_not_open" }
  | { status: "no_performed_at" }
  | { status: "no_triggers" }
  | { status: "trigger_in_past"; at: Date }
  | { status: "duplicate_trigger"; at: Date };

/**
 * Replaces a reminder message's un-sent moments and/or rewrites its text.
 *
 * `triggers` is the COMPLETE desired set of un-sent moments, not a delta: the
 * attendant edits a list, so making the caller compute a diff would duplicate
 * work they already expressed. A moment that survives keeps its row — and so its
 * outbox idempotency key — rather than being cancelled and recreated.
 *
 * Rows that have left or finished are never touched: `SENT` cannot be recalled,
 * `FAILED` is over, and `PROCESSING` is mid-dispatch, where a write would race
 * the due tick for a row it has already claimed. A desired moment landing on an
 * already-sent instant is DROPPED rather than duplicated — the customer was told
 * at that moment, and a second row would tell them again.
 *
 * @param tx - A client under `module_scheduling`, inside one transaction.
 * @param input.reminderMessageId - The message to edit.
 * @param input.triggers - The complete desired un-sent set. Omit to leave the
 *   moments alone and change only the wording.
 * @param input.bodyTemplate - New wording. Omit to keep the current one.
 * @param input.createdByUserId - Who owns any newly created row.
 * @param input.now - Confirm instant a moment must be after. Injected so a test
 *   can place one either side of it without waiting.
 * @returns How many rows were created, cancelled and rewritten, or why nothing
 *   changed. Nothing is written unless every desired moment is accepted.
 */
export async function updateReminder(
  tx: DbClient,
  input: {
    reminderMessageId: string;
    triggers?: ReminderTrigger[];
    bodyTemplate?: string;
    createdByUserId: string;
    now?: Date;
  },
): Promise<UpdateReturnReminderResult> {
  const message = await tx.returnReminderMessage.findUnique({
    where: { id: input.reminderMessageId },
    include: {
      scheduledMessages: true,
      vehicleReturn: {
        include: {
          intervalRule: true,
          sourceService: { select: { performedAt: true, kind: true, description: true } },
          vehicle: { select: { customerId: true, make: true, model: true, plate: true } },
        },
      },
    },
  });
  if (!message) {
    return { status: "not_found" };
  }
  if (message.cancelledAt) {
    // Editing something already stopped would quietly bring it back to life.
    return { status: "message_cancelled" };
  }
  const vehicleReturn = message.vehicleReturn;
  if (vehicleReturn.status !== "OPEN") {
    return { status: "return_not_open" };
  }
  const performedAt = vehicleReturn.sourceService.performedAt;
  if (!performedAt) {
    return { status: "no_performed_at" };
  }

  const bodyTemplate = input.bodyTemplate ?? message.bodyTemplate;
  const now = input.now ?? new Date();
  const textInput = {
    bodyTemplate,
    performedAt,
    serviceLabel: serviceLabel(vehicleReturn.sourceService),
    vehicleLabel: vehicleLabel(vehicleReturn.vehicle),
    interval: returnInterval(vehicleReturn.intervalRule),
  };

  const untouchable = new Set(
    message.scheduledMessages
      .filter((row) => row.status === "SENT" || row.status === "FAILED" || row.status === "PROCESSING")
      .map((row) => row.scheduledAt.getTime()),
  );
  const live = message.scheduledMessages.filter((row) => row.status === "SCHEDULED");

  // Wording-only edit: every un-sent row keeps its instant and gets new text,
  // resolved for its own moment rather than for one shared moment.
  if (!input.triggers) {
    if (input.bodyTemplate === undefined) {
      return { status: "ok", created: 0, cancelled: 0, rewritten: 0 };
    }
    await tx.returnReminderMessage.update({
      where: { id: message.id },
      data: { bodyTemplate },
    });
    let rewrittenText = 0;
    for (const row of live) {
      const outcome = await rewriteUnlessPickedUp(
        tx,
        row.id,
        { frozenText: resolveReminderText({ ...textInput, sendAt: row.scheduledAt }) },
        now,
      );
      if (outcome === "rewritten") rewrittenText += 1;
    }
    return { status: "ok", created: 0, cancelled: 0, rewritten: rewrittenText };
  }

  const plan = planReminderMessage({
    returnDate: calendarDay(vehicleReturn.returnDate),
    ...textInput,
    triggers: input.triggers,
    now,
  });
  if (plan.status !== "ok") {
    return plan;
  }

  const desired = plan.rows.filter((row) => !untouchable.has(row.scheduledAt.getTime()));
  // A message with nothing pending AND nothing sent is a delete in disguise;
  // cancelling the message is the honest control for that.
  if (desired.length === 0 && untouchable.size === 0) {
    return { status: "no_triggers" };
  }

  const desiredInstants = new Set(desired.map((row) => row.scheduledAt.getTime()));
  const liveByInstant = new Map(live.map((row) => [row.scheduledAt.getTime(), row]));

  if (input.bodyTemplate !== undefined) {
    await tx.returnReminderMessage.update({
      where: { id: message.id },
      data: { bodyTemplate },
    });
  }

  let cancelled = 0;
  for (const row of live) {
    if (!desiredInstants.has(row.scheduledAt.getTime())) {
      // A dropped moment is cancelled with its outbox row, and skipped like a
      // row that left SCHEDULED when the worker has already picked it up
      // (owner rulings, 2026-09-25; see contracts/unsent.ts).
      const outcome = await cancelUnlessPickedUp(tx, row.id, { from: "scheduled", at: now });
      if (outcome === "cancelled") cancelled += 1;
    }
  }

  let created = 0;
  let rewritten = 0;
  for (const row of desired) {
    const existing = liveByInstant.get(row.scheduledAt.getTime());
    if (existing) {
      // Kept rather than recreated, so its outbox idempotency key survives. A
      // row the due tick claimed meanwhile is neither rewritten nor recreated:
      // it is going out as it was.
      const outcome = await rewriteUnlessPickedUp(
        tx,
        existing.id,
        { frozenText: row.frozenText, leadDays: row.leadDays },
        now,
      );
      if (outcome === "rewritten") rewritten += 1;
      continue;
    }
    await tx.scheduledMessage.create({
      data: {
        id: randomUUID(),
        customerId: vehicleReturn.vehicle.customerId,
        // A new moment joins the conversation the message already sends to.
        conversationId: message.scheduledMessages[0]?.conversationId ?? null,
        serviceId: vehicleReturn.sourceServiceId,
        returnReminderMessageId: message.id,
        leadDays: row.leadDays,
        templateId: message.templateId,
        frozenText: row.frozenText,
        scheduledAt: row.scheduledAt,
        timeZone: SCHEDULE_TIME_ZONE,
        status: "SCHEDULED",
        idempotencyKey: randomUUID(),
        intervalRuleId: vehicleReturn.intervalRuleId,
        intervalRuleVersion: vehicleReturn.intervalRuleVersion,
        createdByUserId: input.createdByUserId,
      },
    });
    created += 1;
  }

  return { status: "ok", created, cancelled, rewritten };
}

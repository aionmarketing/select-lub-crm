/**
 * Writing a return's reminder message and the scheduled messages it materialises.
 *
 * Moved from `packages/db/src/return-reminders.ts`
 * (`createReturnReminderMessage`). The decision of which rows to write is pure
 * and lives in `contracts/http.reminder-plan.ts` (`planReminderMessage`); this is the
 * half that reads the return and writes what the plan returned.
 *
 * Confirming never sends. Each row is an ordinary scheduled message from the
 * due tick's point of view — it dispatches on its own instant, cancels while
 * `SCHEDULED`, and carries its own outbox idempotency key — so nothing here
 * teaches the dispatcher about reminders.
 *
 * It used to open its own transaction around the writes. It now takes the
 * client of its caller's `db.tx("scheduling", …)`, which is one transaction, so
 * the reads and every write commit together: a reminder message with only some
 * of its moments written is a plan the attendant never confirmed.
 */
import { randomUUID } from "node:crypto";
import { DEFAULT_REMINDER_TEMPLATE, planReminderMessage, type ReminderTrigger } from "../contracts/http.js";
import { SCHEDULE_TIME_ZONE } from "../../services/contracts/http.js";
import type { DbClient } from "../../../kernel/db.js";
import { calendarDay, returnInterval, serviceLabel, vehicleLabel } from "../internal/reminder-text.js";

/** What confirming produced, or why it produced nothing. */
export type CreateReturnReminderResult =
  | { status: "ok"; reminderMessageId: string; scheduledMessageIds: string[] }
  | { status: "not_found" }
  | { status: "return_not_open" }
  | { status: "no_performed_at" }
  | { status: "no_triggers" }
  | { status: "trigger_in_past"; at: Date }
  | { status: "duplicate_trigger"; at: Date };

/**
 * Creates one reminder message on a return, plus one scheduled message per trigger.
 *
 * @param tx - A client under `module_scheduling`, inside one transaction.
 * @param input.returnId - The return the reminder hangs off.
 * @param input.conversationId - Where the reminders will be sent. Supplied by
 *   the caller rather than resolved from the customer, because a customer may
 *   hold more than one conversation and picking one here would be a guess.
 * @param input.triggers - Send moments; at least one is required.
 * @param input.bodyTemplate - The attendant's text. Defaults to
 *   `DEFAULT_REMINDER_TEMPLATE` when they made no edit.
 * @param input.templateId - Response template the body came from, when it did.
 * @param input.createdByUserId - Who confirmed.
 * @param input.now - Confirm instant a trigger must be strictly after. Injected
 *   so a test can place a trigger either side of it without waiting.
 * @returns The ids written, or the reason nothing was: an unknown or
 *   non-`OPEN` return, a source service with no `performedAt` (nothing to
 *   measure elapsed time from), or one of the plan's own rejections. Nothing is
 *   written unless every trigger is accepted.
 */
export async function createReminder(
  tx: DbClient,
  input: {
    returnId: string;
    conversationId: string;
    triggers: ReminderTrigger[];
    bodyTemplate?: string;
    templateId?: string | null;
    createdByUserId: string;
    now?: Date;
  },
): Promise<CreateReturnReminderResult> {
  const row = await tx.vehicleReturn.findUnique({
    where: { id: input.returnId },
    include: {
      intervalRule: true,
      sourceService: { select: { id: true, performedAt: true, kind: true, description: true } },
      vehicle: { select: { id: true, customerId: true, make: true, model: true, plate: true } },
    },
  });
  if (!row) {
    return { status: "not_found" };
  }
  // An archived return shows in neither Follow-up section, so a reminder added
  // to it would be created somewhere the operator cannot see it afterwards.
  if (row.status !== "OPEN") {
    return { status: "return_not_open" };
  }
  if (!row.sourceService.performedAt) {
    return { status: "no_performed_at" };
  }

  const bodyTemplate = input.bodyTemplate ?? DEFAULT_REMINDER_TEMPLATE;
  const plan = planReminderMessage({
    returnDate: calendarDay(row.returnDate),
    performedAt: row.sourceService.performedAt,
    serviceLabel: serviceLabel(row.sourceService),
    vehicleLabel: vehicleLabel(row.vehicle),
    interval: returnInterval(row.intervalRule),
    bodyTemplate,
    triggers: input.triggers,
    now: input.now ?? new Date(),
  });
  if (plan.status !== "ok") {
    return plan;
  }

  const message = await tx.returnReminderMessage.create({
    data: {
      vehicleReturnId: row.id,
      templateId: input.templateId ?? null,
      bodyTemplate,
      createdByUserId: input.createdByUserId,
    },
  });

  const scheduledMessageIds: string[] = [];
  for (const planned of plan.rows) {
    const created = await tx.scheduledMessage.create({
      data: {
        id: randomUUID(),
        customerId: row.vehicle.customerId,
        conversationId: input.conversationId,
        serviceId: row.sourceServiceId,
        returnReminderMessageId: message.id,
        leadDays: planned.leadDays,
        templateId: input.templateId ?? null,
        frozenText: planned.frozenText,
        scheduledAt: planned.scheduledAt,
        timeZone: SCHEDULE_TIME_ZONE,
        status: "SCHEDULED",
        idempotencyKey: randomUUID(),
        intervalRuleId: row.intervalRuleId,
        intervalRuleVersion: row.intervalRuleVersion,
        createdByUserId: input.createdByUserId,
      },
      select: { id: true },
    });
    scheduledMessageIds.push(created.id);
  }

  return { status: "ok", reminderMessageId: message.id, scheduledMessageIds };
}

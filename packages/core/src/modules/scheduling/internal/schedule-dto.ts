/**
 * Turning `scheduled_message` rows into the wire shapes.
 *
 * Moved from `apps/api/src/scheduled/store.ts` (`toScheduleDto`,
 * `toScheduleDetailDto`) and `scheduled/prisma.ts` (`asStatus`,
 * `asSuggestionSource`), unchanged. `apps/api/src/return-reminders/prisma.ts`
 * kept its own copy of `asStatus`; it now uses this one.
 */
import type { ScheduledMessage, ScheduledMessageDetail } from "../contracts/http.js";

/** A status the DTO accepts; anything else is a row we do not model, read as `SCHEDULED`. */
export function asStatus(value: string): ScheduledMessage["status"] {
  if (
    value === "SCHEDULED" ||
    value === "PROCESSING" ||
    value === "SENT" ||
    value === "CANCELLED" ||
    value === "FAILED"
  ) {
    return value;
  }
  return "SCHEDULED";
}

/** A suggestion source the DTO accepts, or null. */
export function asSuggestionSource(value: string | null): ScheduledMessage["suggestionSource"] {
  if (value === "rule" || value === "six_months") {
    return value;
  }
  return null;
}

/** The columns {@link toScheduleDto} reads, as Prisma returns them. */
export type ScheduleRow = {
  id: string;
  customerId: string | null;
  conversationId: string | null;
  serviceId: string | null;
  returnReminderMessageId: string | null;
  templateId: string | null;
  frozenText: string;
  scheduledAt: Date;
  timeZone: string;
  status: string;
  idempotencyKey: string;
  suggestedAt: Date | null;
  suggestionSource: string | null;
  createdByUserId: string;
  createdAt: Date;
};

/**
 * Maps a `scheduled_message` row to the shared {@link ScheduledMessage} DTO.
 *
 * @param row - The row as Prisma returns it.
 * @returns API-facing schedule with ISO timestamps and the frozen text as `text`.
 */
export function toScheduleDto(row: ScheduleRow): ScheduledMessage {
  return {
    id: row.id,
    customerId: row.customerId,
    conversationId: row.conversationId,
    serviceId: row.serviceId,
    returnReminderMessageId: row.returnReminderMessageId,
    templateId: row.templateId,
    text: row.frozenText,
    scheduledAt: row.scheduledAt.toISOString(),
    timeZone: row.timeZone,
    status: asStatus(row.status),
    idempotencyKey: row.idempotencyKey,
    suggestedAt: row.suggestedAt ? row.suggestedAt.toISOString() : null,
    suggestionSource: asSuggestionSource(row.suggestionSource),
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Maps a row plus its resolved relations to {@link ScheduledMessageDetail}.
 *
 * `lastError` is passed through as stored: the worker writes it only on a
 * failure, so a `SCHEDULED` row carries null and a `FAILED` row carries the
 * reason the send did not happen.
 *
 * @param row - The same columns {@link toScheduleDto} takes, plus `lastError`.
 * @param relations.templateName - Template name, or null when the message names no template.
 * @param relations.createdByName - Creator's name, or null when the user row is gone.
 * @param relations.originatingService - The service the message was prefilled from, or null.
 * @returns Detail DTO with ISO timestamps.
 */
export function toScheduleDetailDto(
  row: ScheduleRow & { lastError: string | null },
  relations: {
    templateName: string | null;
    createdByName: string | null;
    originatingService: {
      id: string;
      omieId: string | null;
      description: string | null;
      performedAt: Date | null;
    } | null;
  },
): ScheduledMessageDetail {
  const service = relations.originatingService;
  return {
    ...toScheduleDto(row),
    lastError: row.lastError,
    templateName: relations.templateName,
    createdByName: relations.createdByName,
    originatingService:
      service === null
        ? null
        : {
            id: service.id,
            omieId: service.omieId,
            description: service.description,
            performedAt: service.performedAt ? service.performedAt.toISOString() : null,
          },
  };
}

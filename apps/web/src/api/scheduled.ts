/**
 * Scheduled-message HTTP.
 */
import {
  scheduledMessageDetailSchema,
  scheduledMessageListSchema,
  scheduledMessageSchema,
  suggestScheduleDateResultSchema,
  type CreateScheduledMessageBody,
  type ScheduledMessage,
  type ScheduledMessageDetail,
  type SuggestScheduleDateResult,
} from "@select-lub/shared-types";
import { apiBase, apiRead, headers, parse } from "./http.js";

/**
 * Lists deferred sends queued for a conversation.
 * @param conversationId - CRM conversation id used in the path segment.
 * @returns Parsed `ScheduledMessage[]` from `GET /conversations/:conversationId/scheduled-messages`.
 */
export async function fetchScheduledMessages(conversationId: string): Promise<ScheduledMessage[]> {
  const body = await parse(
    await apiRead(`${apiBase}/conversations/${conversationId}/scheduled-messages`),
  );
  return scheduledMessageListSchema.parse(body);
}

/**
 * Reads one scheduled message in full, for the rail drill-in.
 *
 * The path carries no conversation segment on purpose: the API scopes the read
 * through the message's own conversation, so a message belonging to another
 * unit answers 404 rather than 403 and the caller needs only the id it already
 * holds on the list row.
 *
 * @param scheduleId - Scheduled message id used in the path segment.
 * @returns Parsed `ScheduledMessageDetail` from `GET /scheduled-messages/:id` — the list row plus `lastError`, `templateName`, `createdByName` and `originatingService`.
 */
export async function fetchScheduledMessageDetail(
  scheduleId: string,
): Promise<ScheduledMessageDetail> {
  const body = await parse(
    await apiRead(`${apiBase}/scheduled-messages/${scheduleId}`),
  );
  return scheduledMessageDetailSchema.parse(body);
}

/**
 * Queues a future outbound message; does not send it on WhatsApp now.
 * @param conversationId - CRM conversation id used in the path segment.
 * @param input - Text, future `scheduledAt` ISO instant, and optional service/template ids.
 * @returns Parsed `ScheduledMessage` from `POST /conversations/:conversationId/scheduled-messages`.
 */
export async function createScheduledMessage(
  conversationId: string,
  input: CreateScheduledMessageBody,
): Promise<ScheduledMessage> {
  const body = await parse(
    await fetch(`${apiBase}/conversations/${conversationId}/scheduled-messages`, {
      method: "POST",
      headers: { ...headers(), "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  return scheduledMessageSchema.parse(body);
}

/**
 * A refused cancel, carrying the route's `state`.
 *
 * The route answers 409 for two different reasons, told apart only by the
 * body: `DISCONNECTED` while the channel is down, and `CONNECTED` when the
 * message has been sent or the worker has already picked it up (owner rulings,
 * 2026-09-25). The shared `parse` drops the body, so the 409 is read here, as
 * `./returnReminders.ts` does for its refusals.
 */
export type ScheduleCancelRefusal = Error & { status: 409; state: string | undefined };

/**
 * Whether `error` is the route's 409 for a message already sent or on its way.
 *
 * @param error - What the cancel mutation rejected with.
 * @returns True for 409 `{ state: "CONNECTED" }`.
 */
export function isCancelAlreadySending(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as Partial<ScheduleCancelRefusal>).status === 409 &&
    (error as Partial<ScheduleCancelRefusal>).state === "CONNECTED"
  );
}

/**
 * Whether `error` is the route's 409 for a channel that is down.
 *
 * @param error - What the cancel mutation rejected with.
 * @returns True for 409 `{ state: "DISCONNECTED" }`.
 */
export function isCancelDisconnected(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as Partial<ScheduleCancelRefusal>).status === 409 &&
    (error as Partial<ScheduleCancelRefusal>).state === "DISCONNECTED"
  );
}

/**
 * Cancels a row for the conversation that the worker has not picked up yet.
 * @param conversationId - CRM conversation id used in the path segment.
 * @param scheduleId - Scheduled message id used in the path segment.
 * @returns Parsed `ScheduledMessage` from `POST …/scheduled-messages/:scheduleId/cancel`.
 * @throws {@link ScheduleCancelRefusal} on 409; `Error("http <status>")` otherwise.
 */
export async function cancelScheduledMessage(
  conversationId: string,
  scheduleId: string,
): Promise<ScheduledMessage> {
  const response = await fetch(
    `${apiBase}/conversations/${conversationId}/scheduled-messages/${scheduleId}/cancel`,
    { method: "POST", headers: headers() },
  );
  if (response.status === 409) {
    const refused = (await response.json().catch(() => ({}))) as { state?: string };
    throw Object.assign(new Error("http 409"), { status: 409 as const, state: refused.state });
  }
  return scheduledMessageSchema.parse(await parse(response));
}

/**
 * Returns the suggested Programar mensagem instant for a service (six months when no rule matches).
 * @param serviceId - Service id used in the path segment.
 * @returns Parsed suggest-date payload from `GET /services/:serviceId/suggest-schedule-date`.
 */
export async function suggestScheduleDate(serviceId: string): Promise<SuggestScheduleDateResult> {
  const body = await parse(
    await apiRead(`${apiBase}/services/${serviceId}/suggest-schedule-date`),
  );
  return suggestScheduleDateResultSchema.parse(body);
}

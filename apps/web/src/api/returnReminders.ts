/**
 * Reminder messages on a vehicle return, and archiving a return.
 *
 * Every write answers with the WHOLE message — every scheduled row, sent ones
 * included, ordered by send instant — so the overlay redraws from the response
 * with no merge logic of its own.
 */
import {
  returnReminderMessageSchema,
  type CreateReturnReminderBody,
  type ReturnReminderMessage,
  type UpdateReturnReminderBody,
} from "@select-lub/shared-types";
import { apiBase, headers } from "./http.js";

/**
 * A refused reminder write, carrying WHY.
 *
 * The shared `parse` helper throws `Error("http 409")` and drops the response
 * body, which is exactly the half that matters here: these routes answer a
 * refusal with `{ error: "trigger_in_past", at }` so the screen can say which
 * moment is wrong instead of "something went wrong". This module reads the body
 * itself rather than widening `parse` for every other caller.
 */
export type ReminderRefusal = Error & {
  status: number;
  body: { error?: string; state?: string; at?: string };
};

async function send(path: string, method: "POST" | "PATCH", body?: unknown): Promise<unknown> {
  // The content-type is set only when there is something to type. Declaring
  // `application/json` on a bodyless POST makes Fastify refuse the request with
  // `FST_ERR_CTP_EMPTY_JSON_BODY` (400) before the route runs — which silently
  // broke archive and unarchive, the only two callers here that send no body.
  // `cancelScheduledMessage` in `./scheduled.ts` has always done it this way.
  const hasBody = body !== undefined;
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: hasBody ? { ...headers(), "content-type": "application/json" } : headers(),
    body: hasBody ? JSON.stringify(body) : undefined,
  });
  if (response.ok) {
    return response.status === 204 ? undefined : response.json().catch(() => undefined);
  }
  const parsed = await response.json().catch(() => ({}));
  throw Object.assign(new Error(`http ${response.status}`), {
    status: response.status,
    body: parsed as ReminderRefusal["body"],
  });
}

function write(path: string, body?: unknown) {
  return send(path, "POST", body);
}

/**
 * Creates a reminder message on a return.
 *
 * @param returnId - The vehicle return the reminders hang from.
 * @param input - Conversation to send in, the send moments, and optionally the
 *   text; omit `bodyTemplate` to take the composed Portuguese default.
 * @returns The created message with one scheduled row per moment.
 * @throws When the write is refused — notably `trigger_in_past` for a moment
 *   already gone, which an offset from an OVERDUE return date always is.
 */
export async function createReturnReminder(
  returnId: string,
  input: CreateReturnReminderBody,
): Promise<ReturnReminderMessage> {
  return returnReminderMessageSchema.parse(
    await write(`/vehicle-returns/${returnId}/reminders`, input),
  );
}

/**
 * Edits a reminder message.
 *
 * `triggers` is the complete desired set of un-sent moments, not a delta: a
 * moment left out comes back cancelled, and one already sent is never touched.
 *
 * @param reminderMessageId - Message to edit.
 * @param input - What changed; send only that.
 * @returns The message as it now stands, cancelled rows included.
 */
export async function updateReturnReminder(
  reminderMessageId: string,
  input: UpdateReturnReminderBody,
): Promise<ReturnReminderMessage> {
  return returnReminderMessageSchema.parse(
    await send(`/return-reminders/${reminderMessageId}`, "PATCH", input),
  );
}

/**
 * Cancels every un-sent row of a reminder message.
 *
 * Deliberately NOT blocked by a disconnected channel: stopping a message sends
 * nothing, and a dead channel must not trap someone with reminders they cannot
 * stop.
 *
 * @param reminderMessageId - Message to stop.
 * @returns The message with its un-sent rows cancelled and sent rows intact.
 */
export async function cancelReturnReminder(
  reminderMessageId: string,
): Promise<ReturnReminderMessage> {
  return returnReminderMessageSchema.parse(
    await write(`/return-reminders/${reminderMessageId}/cancel`),
  );
}

/**
 * Takes a return off the Follow-up queue.
 *
 * Archiving does nothing to its reminders — they keep their own schedule, and
 * stopping one is a separate act on that message.
 *
 * @param returnId - The return to archive.
 */
export async function archiveVehicleReturn(returnId: string): Promise<void> {
  await write(`/vehicle-returns/${returnId}/archive`);
}

/**
 * Puts an archived return back on the queue.
 *
 * @param returnId - The return to restore.
 */
export async function unarchiveVehicleReturn(returnId: string): Promise<void> {
  await write(`/vehicle-returns/${returnId}/unarchive`);
}

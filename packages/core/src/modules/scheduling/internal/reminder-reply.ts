/**
 * How the three reminder-message routes answer, shared so they cannot drift.
 *
 * Moved from `apps/api/src/return-reminders/routes.ts`, where create, update
 * and cancel each repeated the same mapping. Error codes travel on the wire and
 * the Portuguese lives in the web layer. `trigger_in_past` and
 * `duplicate_trigger` carry the offending instant so the screen can point at one
 * row rather than saying "one of them".
 */
import type { FastifyReply } from "fastify";
import { z } from "zod";
import {
  returnReminderErrorSchema,
  type ReminderTrigger,
  type ReminderTriggerBody,
  type ReturnReminderMessage,
} from "../contracts/http.js";

/** The 409 body of a reminder route: a refusal code, or the channel state. */
export const reminderConflictSchema = z.union([returnReminderErrorSchema, z.object({ state: z.string() })]);

/**
 * Why a reminder write did not happen.
 *
 * `not_found` covers both an unknown return or message and one outside the
 * caller's unit, deliberately: telling an outsider which of the two it was
 * would confirm the row exists.
 */
export type ReminderWriteResult =
  | { status: "ok"; message: ReturnReminderMessage }
  | { status: "not_found" }
  | { status: "channel_down" }
  | { status: "return_not_open" }
  | { status: "no_performed_at" }
  | { status: "no_triggers" }
  | { status: "message_cancelled" }
  | { status: "trigger_in_past"; at: Date }
  | { status: "duplicate_trigger"; at: Date };

/** Absolute moments arrive as ISO text and become instants here. */
export function toTrigger(body: ReminderTriggerBody): ReminderTrigger {
  return body.kind === "absolute" ? { kind: "absolute", at: new Date(body.at) } : body;
}

/**
 * Sends a reminder write's outcome.
 *
 * @param reply - The reply.
 * @param result - The outcome.
 * @param okCode - 201 for a create, 200 for an edit or a cancel.
 * @returns The sent reply.
 */
export function sendReminderResult(reply: FastifyReply, result: ReminderWriteResult, okCode: 200 | 201) {
  if (result.status === "ok") {
    return reply.code(okCode).send(result.message);
  }
  if (result.status === "not_found") {
    return reply.code(404).send({});
  }
  if (result.status === "channel_down") {
    return reply.code(409).send({ state: "DISCONNECTED" });
  }
  if (result.status === "trigger_in_past" || result.status === "duplicate_trigger") {
    return reply.code(409).send({ error: result.status, at: result.at.toISOString() });
  }
  return reply.code(409).send({ error: result.status });
}

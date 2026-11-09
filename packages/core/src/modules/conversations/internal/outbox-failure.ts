/**
 * Which outbox rows "did not go out", and which kind (`hold-unknown-outcome-sends`,
 * design D4). The thread read labels them and the resend guards on them, so both
 * use this one definition.
 *
 * A `blocked` row counts only when the attendant sent it: a scheduled message's
 * copy is also `blocked` while the channel is down, and the due tick still sends
 * that one on reconnect. A copy is recognised by a `scheduled_message` holding
 * its idempotency key; `scheduled_message` is scheduling's table, read here under
 * `module_conversations` (`readableBy "*"`), as follow-up already does.
 */
import type { DbClient } from "../../../kernel/db.js";
import { resendKeyOf } from "../../channel/contracts/resend-outbound.js";
import { OUTBOX_SEND_OUTCOME_UNKNOWN } from "../../channel/contracts/send-outcome.js";
import type { OutboxFailure } from "../contracts/http.js";

/** The outbox columns the classification reads. */
export type OutboxFailureInput = { status: string; lastError: string | null; idempotencyKey: string | null };

/**
 * The idempotency keys, among `keys`, that belong to a scheduled message.
 *
 * @param tx - A client inside the caller's transaction.
 * @param keys - Outbox rows' keys; null ones are skipped.
 */
export async function scheduledCopyKeys(tx: DbClient, keys: readonly (string | null)[]): Promise<Set<string>> {
  const wanted = keys.filter((key): key is string => key !== null);
  if (wanted.length === 0) {
    return new Set();
  }
  const rows = await tx.scheduledMessage.findMany({
    where: { idempotencyKey: { in: wanted } },
    select: { idempotencyKey: true },
  });
  return new Set(rows.map((row) => row.idempotencyKey));
}

/**
 * The kind of "did not go out" a row is, or undefined when it is not one.
 *
 * @param row - The outbox row.
 * @param scheduledKeys - From {@link scheduledCopyKeys}, covering this row's key.
 */
export function outboxFailureOf(row: OutboxFailureInput, scheduledKeys: ReadonlySet<string>): OutboxFailure | undefined {
  if (row.status === "failed") {
    return row.lastError === OUTBOX_SEND_OUTCOME_UNKNOWN ? "outcome_unknown" : "not_sent";
  }
  if (row.status === "blocked" && !(row.idempotencyKey !== null && scheduledKeys.has(row.idempotencyKey))) {
    return "not_sent";
  }
  return undefined;
}

/**
 * The outbox ids, among `ids`, that have already been resent: a row keyed
 * `resend:<id>` exists for them, in whatever status (`hold-unknown-followups`).
 *
 * @param tx - A client inside the caller's transaction.
 * @param ids - Outbox row ids, typically the `failed` ones of a thread.
 */
export async function resentOutboxIds(tx: DbClient, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) {
    return new Set();
  }
  const copies = await tx.outboxMessage.findMany({
    where: { idempotencyKey: { in: ids.map(resendKeyOf) } },
    select: { idempotencyKey: true },
  });
  const byKey = new Map(ids.map((id) => [resendKeyOf(id), id]));
  return new Set(copies.map((copy) => byKey.get(copy.idempotencyKey ?? "")).filter((id): id is string => id !== undefined));
}

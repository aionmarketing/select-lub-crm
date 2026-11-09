/**
 * The `webhook_event` lifecycle, for the module that canonicalizes it.
 *
 * `receive-webhook` stores each event `received`. What happens next — processed,
 * skipped, failed and retried — is decided by `conversations`' `ingest-message`,
 * which until 4A did it by writing channel's table directly under the login role
 * (exception W3-C6). These are those same reads and writes, moved here unchanged
 * so they run under channel's role, whoever calls them.
 *
 * Every function runs its own `db.tx("channel", …)`; called inside another
 * module's transaction it joins it through the kernel's savepoint.
 *
 * There is no compare-and-set on `markWebhookEvent`, as there was none before:
 * a heartbeat retry and a live canonicalization of the same event can both run,
 * and the one that finishes last writes the status. Neither can duplicate a
 * message, because the message insert is idempotent on
 * `(conversation_id, external_message_id)`.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import type { Db, DbClient, RunInTransaction } from "../../../kernel/db.js";
import { envelopeExternalId, envelopeInstance } from "./evolution-format.js";

/** Maximum canonicalization attempts before an event is marked permanently failed. */
export const WEBHOOK_RETRY_MAX_ATTEMPTS = 5;

/** Age after which a still-`received` event becomes eligible for heartbeat retry. */
export const STALE_RECEIVED_MS = 60_000;

/** Lifecycle status of a stored Evolution webhook event. */
export type WebhookEventStatus = "received" | "processed" | "skipped" | "failed" | "failed_permanent";

/** One stored webhook event. */
export type WebhookEventRow = {
  id: string;
  payload: unknown;
  status: WebhookEventStatus;
  attemptCount: number;
  whatsappConnectionId: string | null;
  externalMessageId: string | null;
  createdAt: Date;
};

/**
 * The receipt transaction's limits: wait up to 10 s for a pooled connection, as
 * every transaction does, but run for up to 60 s rather than the kernel's 5 s.
 *
 * The body is stored whole, and Evolution's `messages.set` history dump can be up
 * to the worker's 50 MiB body limit. The old route stored it with a plain
 * autocommit `create`, which had no run limit at all; inside the default 5 s
 * interactive transaction a large dump could time out, answer 500, and be
 * redelivered by Evolution. Only this one transaction gets the longer limit; it
 * holds a lookup and one insert, never a provider call.
 */
export const WEBHOOK_RECEIPT_TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 60_000 } as const;

/**
 * Opens the receipt's transaction with {@link WEBHOOK_RECEIPT_TRANSACTION_OPTIONS}
 * when the handle's client can open one. On an already-open transaction (the
 * test harness) it returns `undefined`, and `db.tx` joins that transaction as usual.
 */
function receiptRunner(db: Db): RunInTransaction | undefined {
  const client = db.client as Partial<Pick<PrismaClient, "$transaction">>;
  if (typeof client.$transaction !== "function") {
    return undefined;
  }
  const open = client.$transaction.bind(client) as (
    fn: (tx: DbClient) => Promise<unknown>,
    options: typeof WEBHOOK_RECEIPT_TRANSACTION_OPTIONS,
  ) => Promise<unknown>;
  return <T>(fn: (tx: DbClient) => Promise<T>) =>
    open(fn, WEBHOOK_RECEIPT_TRANSACTION_OPTIONS) as Promise<T>;
}

/**
 * Stores one raw webhook body `received`, linked to its connection when the
 * envelope names a known instance. The receipt's only write; `receive-webhook`
 * calls it, and a test that needs a stored event calls it the same way.
 *
 * @param db - The database handle; runs on `db.tx("channel", …)` with
 *   {@link WEBHOOK_RECEIPT_TRANSACTION_OPTIONS}.
 * @param payload - The unparsed body.
 * @returns The new row's id.
 */
export async function recordWebhookEvent(db: Db, payload: unknown): Promise<{ id: string }> {
  return db.tx(
    "channel",
    async (tx) => {
      const instance = envelopeInstance(payload);
      const connection = instance
        ? await tx.whatsAppConnection.findUnique({ where: { instanceName: instance }, select: { id: true } })
        : null;
      return tx.webhookEvent.create({
        data: {
          payload: payload as Prisma.InputJsonValue,
          status: "received",
          whatsappConnectionId: connection?.id ?? null,
          externalMessageId: envelopeExternalId(payload),
        },
        select: { id: true },
      });
    },
    receiptRunner(db),
  );
}

function toRow(row: {
  id: string;
  payload: unknown;
  status: string;
  attemptCount: number;
  whatsappConnectionId: string | null;
  externalMessageId: string | null;
  createdAt: Date;
}): WebhookEventRow {
  return {
    id: row.id,
    payload: row.payload,
    status: row.status as WebhookEventStatus,
    attemptCount: row.attemptCount,
    whatsappConnectionId: row.whatsappConnectionId,
    externalMessageId: row.externalMessageId,
    createdAt: row.createdAt,
  };
}

/**
 * Loads one webhook event.
 *
 * @param db - The database handle.
 * @param id - The event id.
 * @returns The row, or null when it does not exist.
 */
export async function getWebhookEvent(db: Db, id: string): Promise<WebhookEventRow | null> {
  const row = await db.tx("channel", (tx) => tx.webhookEvent.findUnique({ where: { id } }));
  return row ? toRow(row) : null;
}

/**
 * Sets an event's canonicalization outcome.
 *
 * @param db - The database handle.
 * @param id - The event id.
 * @param status - The outcome.
 */
export async function markWebhookEvent(db: Db, id: string, status: WebhookEventStatus): Promise<void> {
  await db.tx("channel", (tx) => tx.webhookEvent.update({ where: { id }, data: { status } }));
}

/**
 * Counts one more canonicalization attempt.
 *
 * @param db - The database handle.
 * @param id - The event id.
 * @returns The attempt count after the increment.
 */
export async function incrementWebhookEventAttempt(db: Db, id: string): Promise<number> {
  const row = await db.tx("channel", (tx) =>
    tx.webhookEvent.update({
      where: { id },
      data: { attemptCount: { increment: 1 } },
      select: { attemptCount: true },
    }),
  );
  return row.attemptCount;
}

/**
 * Lists the events the heartbeat should retry: `failed`, or still `received`
 * after {@link STALE_RECEIVED_MS}, and below {@link WEBHOOK_RETRY_MAX_ATTEMPTS}.
 *
 * @param db - The database handle.
 * @param now - Reference time for staleness.
 * @returns The retryable events.
 */
export async function listRetryableWebhookEvents(db: Db, now: Date): Promise<WebhookEventRow[]> {
  const staleBefore = new Date(now.getTime() - STALE_RECEIVED_MS);
  const rows = await db.tx("channel", (tx) =>
    tx.webhookEvent.findMany({
      where: {
        attemptCount: { lt: WEBHOOK_RETRY_MAX_ATTEMPTS },
        OR: [{ status: "failed" }, { status: "received", createdAt: { lte: staleBefore } }],
      },
    }),
  );
  return rows.map(toRow);
}

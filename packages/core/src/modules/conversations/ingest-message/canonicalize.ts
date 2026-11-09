/**
 * Canonicalizing a stored webhook event into messages, delivery statuses and
 * connection state, and retrying the ones that failed.
 *
 * Moved from `apps/worker/src/ingest/canonicalize.ts` (4A). Two things changed:
 * - The store is `createIngestStore(db)`: this module's writes run under
 *   `module_conversations`, channel's (`webhook_event`, `whatsapp_connection`)
 *   through channel's contracts under `module_channel` (exceptions W3-C4..C6 end).
 * - The `onMessageInserted` hook is the event `conversations/message-received`,
 *   published at the same point: after a NEW message's insert and the event's
 *   `processed` mark, never on a redelivery.
 */
import { publish } from "../../../kernel/events.js";
import { WEBHOOK_RETRY_MAX_ATTEMPTS } from "../../channel/contracts/index.js";
import { messageReceived, type MessageReceived } from "../contracts/message-received.js";
import type { IngestStore } from "../internal/ingest-store.js";
import { formatOriginLog, originOf } from "../internal/origin.js";
import { parseCanonicalMessage, parseConnectionEvent } from "../internal/parse.js";

/**
 * Stores a raw webhook payload, linked to its connection by the instance name.
 * Channel's receipt write (`recordWebhookEvent`), which the webhook route makes;
 * tests and the retry cases store an event through here.
 *
 * @param store - Ingest persistence port.
 * @param payload - Unparsed Evolution webhook JSON body.
 * @returns The new webhook event id.
 */
export async function persistRawEvent(store: IngestStore, payload: unknown) {
  return store.recordWebhookEvent(payload);
}

/**
 * Canonicalizes one webhook event into messages, status updates, or connection state changes.
 *
 * Skips events already in a terminal status (`processed`, `skipped`, `failed_permanent`).
 * On failure, marks the event `failed` or `failed_permanent` depending on attempt count.
 *
 * Publishes `conversations/message-received` for a newly inserted message, after
 * the event is marked processed and outside the try that marks it: a subscriber
 * that throws is logged and never changes the event's status.
 *
 * @param store - Ingest persistence port.
 * @param eventId - Webhook event row id to canonicalize.
 * @param log - Log callback for origin lines and canonicalization errors.
 * @returns Resolves when processing finishes or the event is skipped; no return value on success paths.
 */
export async function canonicalizeEvent(
  store: IngestStore,
  eventId: string,
  log: (message: string) => void = () => undefined,
) {
  const event = await store.getEvent(eventId);
  if (!event || event.status === "processed" || event.status === "skipped" || event.status === "failed_permanent") {
    return;
  }
  const attemptCount = await store.incrementAttemptCount(eventId);
  // Set once the message is inserted and the event marked processed; published
  // AFTER the try, so no subscriber can reach the event's status.
  let received: MessageReceived | null = null;
  try {
    const connectionUpdate = parseConnectionEvent(event.payload);
    if (connectionUpdate.status === "update") {
      if (event.whatsappConnectionId) {
        // Observed when the CRM RECEIVED the event, not now: a retried event
        // keeps its receipt time, so it cannot overwrite a state observed after
        // it. Not Evolution's `date_time` either — see channel's
        // contracts/connections.ts.
        await store.updateConnectionState(
          event.whatsappConnectionId,
          connectionUpdate.state,
          event.createdAt,
        );
        await store.markEvent(eventId, "processed");
      } else {
        await store.markEvent(eventId, "skipped");
      }
      return;
    }
    const parsed = parseCanonicalMessage(event.payload, event.whatsappConnectionId);
    if (parsed.status === "skip") {
      await store.markEvent(eventId, "skipped");
      return;
    }
    if (parsed.status === "status-update") {
      if (event.whatsappConnectionId && parsed.providerStatus) {
        await store.applyProviderStatus({
          whatsappConnectionId: event.whatsappConnectionId,
          externalMessageId: parsed.externalMessageId,
          providerStatus: parsed.providerStatus,
          at: parsed.at ?? new Date(),
        });
      }
      await store.markEvent(eventId, "processed");
      return;
    }
    if (parsed.status === "content-unavailable") {
      if (event.whatsappConnectionId) {
        await store.markContentUnavailable({
          whatsappConnectionId: event.whatsappConnectionId,
          externalMessageId: parsed.externalMessageId,
        });
      }
      await store.markEvent(eventId, "processed");
      return;
    }
    const { inserted, conversationId } = await store.runConversationMessageTransaction(parsed.message);
    log(formatOriginLog(originOf(parsed.message)));
    await store.markEvent(eventId, "processed");
    if (inserted) {
      received = {
        conversationId,
        externalMessageId: parsed.message.externalMessageId,
        direction: parsed.message.direction,
        messageType: parsed.message.messageType,
        providerTimestamp: parsed.message.providerTimestamp,
      };
    }
  } catch (error: unknown) {
    log(`canonicalize failed ${error instanceof Error ? error.message : "unknown"}`);
    await store.markEvent(
      eventId,
      attemptCount >= WEBHOOK_RETRY_MAX_ATTEMPTS ? "failed_permanent" : "failed",
    );
    return;
  }
  if (received) {
    // The kernel's publish rethrows a subscriber's error. Inside the try it
    // would flip a processed event to failed, and the retry would then find the
    // message already inserted and never publish again: the event would be lost
    // for every subscriber (prefill's enqueue, from 4C). Here a failure is
    // logged and the event stays processed.
    try {
      await publish(messageReceived, received);
    } catch (error: unknown) {
      log(`message-received subscriber failed ${error instanceof Error ? error.message : "unknown"}`);
    }
  }
}

/**
 * Re-processes failed and stale received webhook events on the heartbeat tick.
 *
 * @param store - Ingest persistence port.
 * @param now - Reference time for stale `received` event selection; defaults to the current instant.
 * @param log - Log callback passed through to each {@link canonicalizeEvent} call.
 * @returns Resolves after every retryable event has been canonicalized once.
 */
export async function retryPendingEvents(
  store: IngestStore,
  now = new Date(),
  log: (message: string) => void = () => undefined,
) {
  const pending = await store.listRetryableEvents(now);
  for (const event of pending) {
    await canonicalizeEvent(store, event.id, log);
  }
}

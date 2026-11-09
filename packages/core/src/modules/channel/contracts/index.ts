/**
 * The channel module's public surface: the two write contracts every other
 * `outbox_message` writer goes through, and the three events channel publishes.
 * Reached from outside the package as `@select-lub/core/modules/channel/contracts`.
 */
export {
  enqueueOutbound,
  OUTBOX_BLOCKED_DISCONNECTED,
  type EnqueuedOutbound,
  type EnqueueOutboundInput,
  type OutboundMessageType,
} from "./enqueue-outbound.js";
export { cancelOutbound } from "./cancel-outbound.js";
export { OUTBOX_BLOCKED_RESCHEDULED, rewriteUnsentOutbound } from "./rewrite-outbound.js";
export { OUTBOX_SEND_OUTCOME_UNKNOWN } from "./send-outcome.js";
export { resendKeyOf, resendUnsentOutbound, type ResendOutcome } from "./resend-outbound.js";
export { outboundSent, outboundSentSchema, type OutboundSent } from "./outbound-sent.js";
export { webhookReceived, webhookReceivedSchema, type WebhookReceived } from "./webhook-received.js";
export {
  historyRecordFetched,
  historyRecordFetchedSchema,
  type HistoryRecordFetched,
} from "./history-record-fetched.js";
export {
  getWebhookEvent,
  incrementWebhookEventAttempt,
  listRetryableWebhookEvents,
  markWebhookEvent,
  recordWebhookEvent,
  STALE_RECEIVED_MS,
  WEBHOOK_RECEIPT_TRANSACTION_OPTIONS,
  WEBHOOK_RETRY_MAX_ATTEMPTS,
  type WebhookEventRow,
  type WebhookEventStatus,
} from "./webhook-events.js";
export {
  findConnectionByInstanceName,
  listConnections,
  updateConnectionState,
  type ConnectionState,
} from "./connections.js";
export {
  envelopeExternalId,
  envelopeInstance,
  isGroupOrBroadcastJid,
  mapEvolutionSessionState,
  parseTimestamp,
} from "./evolution-format.js";

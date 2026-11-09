/**
 * Ingestion's persistence: the conversation upsert and message insert, delivery
 * statuses, and — through channel's contracts — the `webhook_event` lifecycle
 * and connection state.
 *
 * Moved from `apps/worker/src/ingest/{store,prisma}.ts` (4A) with the SQL
 * unchanged. What changed is where each statement runs:
 * - `conversation` and `message` writes run in `db.tx("conversations", …)`, this
 *   module's own role. Before 4A the worker ran them under the login role, and
 *   channel's events reached them as exceptions W3-C4, W3-C5 and W3-C6; those
 *   exceptions end here.
 * - `webhook_event` and `whatsapp_connection` are channel's tables. Every read
 *   and write of them goes through `@select-lub/core/modules/channel/contracts`
 *   and runs under `module_channel`.
 *
 * The port keeps the old method names so canonicalization and its tests moved
 * unchanged; one method changed shape: `insertWebhookEvent` became
 * `recordWebhookEvent(payload)`, channel's receipt write, which resolves the
 * connection and the provider id from the envelope itself.
 */
import { randomUUID } from "node:crypto";
import type { Db } from "../../../kernel/db.js";
import { MESSAGE_ORIGIN_LIVE, MESSAGE_ORIGIN_SEED } from "../../../shared/message-origin.js";
import {
  findConnectionByInstanceName,
  getWebhookEvent,
  incrementWebhookEventAttempt,
  listConnections,
  listRetryableWebhookEvents,
  markWebhookEvent,
  recordWebhookEvent,
  updateConnectionState,
  type ConnectionState,
  type WebhookEventRow,
  type WebhookEventStatus,
} from "../../channel/contracts/index.js";
import type { CanonicalMessage, ProviderStatus } from "./canonical-message.js";
import { originOf } from "./origin.js";

/** Persistence for webhook ingestion. */
export type IngestStore = {
  /** Stores a raw webhook body `received` (channel's receipt write). */
  recordWebhookEvent(payload: unknown): Promise<{ id: string }>;
  /** Resolves a connection id from an Evolution instance name. */
  findConnectionByInstanceName(instanceName: string): Promise<{ id: string } | null>;
  /**
   * Upserts the conversation thread and inserts the message when the provider id is new.
   *
   * @param message - Canonical message fields.
   * @param options.fromHistory - When true, stamps `lastPrefillWindowClosedAt` so backfill does not open a live window.
   * @returns Whether a new message row was inserted, and the conversation id.
   */
  runConversationMessageTransaction(
    message: CanonicalMessage,
    options?: { fromHistory?: boolean },
  ): Promise<{ inserted: boolean; conversationId: string }>;
  /** Applies a monotonic provider delivery status to an existing message. */
  applyProviderStatus(input: {
    whatsappConnectionId: string;
    externalMessageId: string;
    providerStatus: ProviderStatus;
    at: Date;
  }): Promise<void>;
  /** Marks a message as deleted or otherwise unavailable in the provider. */
  markContentUnavailable(input: { whatsappConnectionId: string; externalMessageId: string }): Promise<void>;
  /** Writes a connection's state (channel's contract). */
  updateConnectionState(connectionId: string, state: ConnectionState, observedAt: Date): Promise<boolean>;
  /** Sets an event's canonicalization outcome (channel's contract). */
  markEvent(id: string, status: WebhookEventStatus): Promise<void>;
  /** Counts one more canonicalization attempt (channel's contract). */
  incrementAttemptCount(id: string): Promise<number>;
  /** Loads one webhook event (channel's contract). */
  getEvent(id: string): Promise<WebhookEventRow | null>;
  /** Failed and stale received events eligible for heartbeat retry (channel's contract). */
  listRetryableEvents(now: Date): Promise<WebhookEventRow[]>;
  /** Every connection (channel's contract). */
  listConnections(): Promise<{ id: string; instanceName: string }[]>;
  /** Canonical messages written by the demo seed; history backfill must not run when > 0. */
  countSeedOriginMessages(): Promise<number>;
};

/**
 * Builds ingestion's store over a database handle.
 *
 * @param db - The handle; `conversation`/`message` work runs on `db.tx("conversations", …)`,
 *   channel's tables through channel's contracts.
 * @returns The store.
 */
export function createIngestStore(db: Db): IngestStore {
  return {
    recordWebhookEvent: (payload) => recordWebhookEvent(db, payload),
    findConnectionByInstanceName: (instanceName) => findConnectionByInstanceName(db, instanceName),
    async runConversationMessageTransaction(message, options) {
      const inbound = message.direction === "inbound" ? message.providerTimestamp : null;
      const outbound = message.direction === "outbound" ? message.providerTimestamp : null;
      const now = new Date();
      const conversationId = randomUUID();
      const messageId = randomUUID();
      const origin = originOf(message);
      return db.tx("conversations", async (tx) => {
        await tx.$executeRaw`
          INSERT INTO conversation (
            id, whatsapp_connection_id, remote_jid, chat_key,
            source_type, source_evidence_type, source_evidence_reference, source_evidence_at,
            ctwa_clid, campaign_id, ad_set_id, ad_id, classification_rule_version,
            started_at, last_message_at, first_inbound_at, last_inbound_at,
            first_outbound_at, last_outbound_at, created_at, updated_at
          ) VALUES (
            ${conversationId}, ${message.whatsappConnectionId}, ${message.remoteJid},
            ${message.chatKey},
            ${origin.sourceType}, ${origin.evidenceType}, ${origin.evidenceReference},
            ${origin.evidenceAt}, ${origin.ctwaClid}, ${origin.campaignId},
            ${origin.adSetId}, ${origin.adId}, ${origin.ruleVersion},
            ${message.providerTimestamp},
            ${message.providerTimestamp}, ${inbound}, ${inbound}, ${outbound}, ${outbound},
            ${now}, ${now}
          )
          ON CONFLICT (whatsapp_connection_id, chat_key) DO UPDATE SET
            remote_jid = EXCLUDED.remote_jid,
            started_at = LEAST(conversation.started_at, EXCLUDED.started_at),
            last_message_at = GREATEST(conversation.last_message_at, EXCLUDED.last_message_at),
            first_inbound_at = LEAST(conversation.first_inbound_at, EXCLUDED.first_inbound_at),
            last_inbound_at = GREATEST(conversation.last_inbound_at, EXCLUDED.last_inbound_at),
            first_outbound_at = LEAST(conversation.first_outbound_at, EXCLUDED.first_outbound_at),
            last_outbound_at = GREATEST(conversation.last_outbound_at, EXCLUDED.last_outbound_at),
            source_type = CASE
              WHEN conversation.source_type IN ('UNKNOWN', 'ORGANIC') AND EXCLUDED.source_type = 'AD'
              THEN EXCLUDED.source_type ELSE conversation.source_type END,
            source_evidence_type = CASE
              WHEN conversation.source_type IN ('UNKNOWN', 'ORGANIC') AND EXCLUDED.source_type = 'AD'
              THEN EXCLUDED.source_evidence_type ELSE conversation.source_evidence_type END,
            source_evidence_reference = CASE
              WHEN conversation.source_type IN ('UNKNOWN', 'ORGANIC') AND EXCLUDED.source_type = 'AD'
              THEN EXCLUDED.source_evidence_reference ELSE conversation.source_evidence_reference END,
            source_evidence_at = CASE
              WHEN conversation.source_type IN ('UNKNOWN', 'ORGANIC') AND EXCLUDED.source_type = 'AD'
              THEN EXCLUDED.source_evidence_at ELSE conversation.source_evidence_at END,
            ctwa_clid = CASE
              WHEN conversation.source_type IN ('UNKNOWN', 'ORGANIC') AND EXCLUDED.source_type = 'AD'
              THEN EXCLUDED.ctwa_clid ELSE conversation.ctwa_clid END,
            campaign_id = CASE
              WHEN conversation.source_type IN ('UNKNOWN', 'ORGANIC') AND EXCLUDED.source_type = 'AD'
              THEN EXCLUDED.campaign_id ELSE conversation.campaign_id END,
            ad_set_id = CASE
              WHEN conversation.source_type IN ('UNKNOWN', 'ORGANIC') AND EXCLUDED.source_type = 'AD'
              THEN EXCLUDED.ad_set_id ELSE conversation.ad_set_id END,
            ad_id = CASE
              WHEN conversation.source_type IN ('UNKNOWN', 'ORGANIC') AND EXCLUDED.source_type = 'AD'
              THEN EXCLUDED.ad_id ELSE conversation.ad_id END,
            classification_rule_version = CASE
              WHEN conversation.source_type IN ('UNKNOWN', 'ORGANIC') AND EXCLUDED.source_type = 'AD'
              THEN EXCLUDED.classification_rule_version ELSE conversation.classification_rule_version END,
            updated_at = EXCLUDED.updated_at
        `;
        const inserted = await tx.$executeRaw`
          INSERT INTO message (
            id, conversation_id, external_message_id,
            direction, message_type, text_body, provider_timestamp, origin, created_at, updated_at
          )
          SELECT ${messageId}, conversation.id, ${message.externalMessageId},
            ${message.direction}, ${message.messageType},
            ${message.textBody}, ${message.providerTimestamp}, ${MESSAGE_ORIGIN_LIVE}, ${now}, ${now}
          FROM conversation
          WHERE conversation.whatsapp_connection_id = ${message.whatsappConnectionId}
            AND conversation.chat_key = ${message.chatKey}
          ON CONFLICT (conversation_id, external_message_id) DO NOTHING
        `;
        const conversation = await tx.conversation.findUnique({
          where: {
            whatsappConnectionId_chatKey: {
              whatsappConnectionId: message.whatsappConnectionId,
              chatKey: message.chatKey,
            },
          },
          select: { id: true },
        });
        if (!conversation) {
          throw new Error("conversation missing after upsert");
        }
        if (options?.fromHistory) {
          await tx.$executeRaw`
            UPDATE conversation
            SET last_prefill_window_closed_at = GREATEST(
              COALESCE(last_prefill_window_closed_at, TIMESTAMPTZ '-infinity'),
              ${message.providerTimestamp}
            )
            WHERE id = ${conversation.id}
          `;
        }
        return { inserted: Number(inserted) > 0, conversationId: conversation.id };
      });
    },
    async applyProviderStatus(input) {
      await db.tx("conversations", (tx) => tx.$executeRaw`
        UPDATE message AS m
        SET
          provider_status = ${input.providerStatus},
          sent_at = CASE WHEN ${input.providerStatus} = 'sent' THEN ${input.at} ELSE m.sent_at END,
          delivered_at = CASE WHEN ${input.providerStatus} = 'delivered' THEN ${input.at} ELSE m.delivered_at END,
          read_at = CASE WHEN ${input.providerStatus} = 'read' THEN ${input.at} ELSE m.read_at END,
          failed_at = CASE WHEN ${input.providerStatus} = 'failed' THEN ${input.at} ELSE m.failed_at END,
          updated_at = ${input.at}
        FROM conversation AS c
        WHERE m.conversation_id = c.id
          AND c.whatsapp_connection_id = ${input.whatsappConnectionId}
          AND m.external_message_id = ${input.externalMessageId}
          AND (
            (
              ${input.providerStatus} = 'failed'
              AND (m.provider_status IS NULL OR m.provider_status = 'sent')
            )
            OR (
              ${input.providerStatus} <> 'failed'
              AND (
                m.provider_status IS NULL
                OR (
                  CASE m.provider_status
                    WHEN 'sent' THEN 1
                    WHEN 'delivered' THEN 2
                    WHEN 'read' THEN 3
                    WHEN 'failed' THEN 0
                    ELSE 0
                  END
                ) < (
                  CASE ${input.providerStatus}
                    WHEN 'sent' THEN 1
                    WHEN 'delivered' THEN 2
                    WHEN 'read' THEN 3
                    ELSE 0
                  END
                )
              )
            )
          )
      `);
    },
    async markContentUnavailable(input) {
      await db.tx("conversations", (tx) => tx.$executeRaw`
        UPDATE message AS m
        SET content_unavailable = true, updated_at = NOW()
        FROM conversation AS c
        WHERE m.conversation_id = c.id
          AND c.whatsapp_connection_id = ${input.whatsappConnectionId}
          AND m.external_message_id = ${input.externalMessageId}
      `);
    },
    updateConnectionState: (connectionId, state, observedAt) =>
      updateConnectionState(db, { connectionId, state, observedAt }),
    markEvent: (id, status) => markWebhookEvent(db, id, status),
    incrementAttemptCount: (id) => incrementWebhookEventAttempt(db, id),
    getEvent: (id) => getWebhookEvent(db, id),
    listRetryableEvents: (now) => listRetryableWebhookEvents(db, now),
    listConnections: () => listConnections(db),
    countSeedOriginMessages: () =>
      db.tx("conversations", (tx) => tx.message.count({ where: { origin: MESSAGE_ORIGIN_SEED } })),
  };
}

/**
 * The shapes ingestion passes between parsing and storage: a canonical message
 * ready for the conversation upsert, and the provider delivery statuses.
 *
 * Moved from `apps/worker/src/ingest/store.ts` (4A). The webhook-event and
 * connection-state types that file also held are channel's now
 * (`@select-lub/core/modules/channel/contracts`).
 */
import type { OriginClassification } from "./origin.js";

/** Delivery acknowledgement mapped from Evolution status updates. */
export type ProviderStatus = "sent" | "delivered" | "read" | "failed";

/** Normalized message row ready for conversation upsert and insert. */
export type CanonicalMessage = {
  whatsappConnectionId: string;
  remoteJid: string;
  chatKey: string;
  externalMessageId: string;
  direction: "inbound" | "outbound";
  messageType: "text" | "image" | "audio" | "document" | "video" | "unknown";
  textBody: string | null;
  providerTimestamp: Date;
  origin?: OriginClassification;
};

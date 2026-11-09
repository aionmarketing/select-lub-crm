/**
 * The ports `channel` needs from Evolution, and the constants its outbox runs on.
 *
 * WHY THESE ARE CHANNEL'S AND NOT THE KERNEL'S (wave 3, ruling Q3-A). The kernel
 * had a placeholder `clients/whatsapp.ts`, a `WhatsAppPort` of `send({ to, text })`
 * and a boolean `connected()`, removed unused after wave 5. That could not carry
 * what the drain actually needs: a send
 * is per instance; it is text, audio, or image/video/document with a MIME type,
 * file name and caption; and its result must say what a failure proves about
 * delivery (`EvolutionSendFailureKind`) and carry the provider's timestamp for the
 * canonical message. The history backfill needs chat and page
 * listing, and the reconcile needs a state, not a boolean. So channel owns these
 * types, the module index exports them for the composition root — as `quotes`
 * exports `OilResearchPorts`.
 *
 * Moved from `apps/worker/src/outbox/types.ts`, less `OutboxDrain`: the outbox's
 * persistence is now the drain and reclaim slices' own queries under
 * `db.tx("channel", …)`, not a port.
 */

/**
 * The CRM's view of a WhatsApp session. `DEGRADED` is written by nothing on the
 * Evolution path today; it is part of the column's vocabulary.
 */
export type ConnectionState = "CONNECTING" | "CONNECTED" | "DEGRADED" | "DISCONNECTED";

/**
 * Maximum send attempts before an outbox row is marked permanently failed.
 *
 * Applies to every message type. It used to apply only to rows carrying media,
 * which left a text row returning to `queued` however often it failed.
 */
export const OUTBOX_RETRY_MAX_ATTEMPTS = 5;

/**
 * How long a failed outbox row waits before it can be claimed again.
 *
 * This is what allows the drain loop to continue past a retryable failure rather
 * than ending the tick. The claim takes the oldest `queued` row, so without a
 * backoff a failing row would be re-selected immediately and would spend all
 * {@link OUTBOX_RETRY_MAX_ATTEMPTS} attempts inside a single tick — the poll runs
 * every second with a 50-row cap.
 *
 * Thirty seconds gives a row about two and a half minutes across its five
 * attempts, long enough to ride out a brief provider hiccup and short enough that
 * a genuinely undeliverable message becomes visibly `failed` while the attendant
 * is still looking at the conversation.
 */
export const OUTBOX_RETRY_BACKOFF_MS = 30_000;

/**
 * What a failed send proves about delivery (`hold-unknown-outcome-sends`).
 *
 * - `retryable`: the request never reached the provider (DNS, refused, unreachable,
 *   connect timeout). The row is requeued under the attempt bound.
 * - `refused`: the provider answered that it did not send (401/403, a
 *   not-on-WhatsApp 400), or the drain refused the row without calling out.
 * - `disconnected`: a 404 whose body says the instance does not exist. The row is
 *   blocked and its connection stored `DISCONNECTED`. Any other 404 is `unknown`.
 * - `unknown`: anything that does not prove the message was not sent. The row is
 *   failed and never resent automatically.
 */
export type EvolutionSendFailureKind = "retryable" | "refused" | "disconnected" | "unknown";

/**
 * Outcome of a single Evolution send. A failure's `error` is a short token for
 * `last_error` and the log; it never carries the message body.
 */
export type EvolutionSendResult =
  | { ok: true; externalMessageId: string; providerTimestamp: Date | null }
  | { ok: false; kind: EvolutionSendFailureKind; error: string };

/** Outcome of fetching base64 media for an inbound provider message. */
export type EvolutionMediaFetchResult =
  | { ok: true; base64: string; mimetype: string | null; fileName: string | null }
  | { ok: false; disconnected: boolean; error: string };

/** Evolution REST client for outbound sends and media retrieval. */
export type EvolutionSend = {
  /**
   * Sends a plain-text WhatsApp message through the instance.
   *
   * @param input - Instance name, normalized recipient number, and message body.
   * @returns Success with provider id and optional timestamp, or failure with disconnect hint.
   */
  sendText(input: { instanceName: string; number: string; text: string }): Promise<EvolutionSendResult>;
  /**
   * Sends a WhatsApp audio message from base64-encoded bytes.
   *
   * @param input - Instance name, normalized recipient number, and base64 audio payload.
   * @returns Success with provider id and optional timestamp, or failure with disconnect hint.
   */
  sendWhatsAppAudio(input: {
    instanceName: string;
    number: string;
    audio: string;
  }): Promise<EvolutionSendResult>;
  /**
   * Sends an image, video, or document with optional caption and mime metadata.
   *
   * @param input - Instance name, recipient, media type, base64 payload, and optional mime/file/caption fields.
   * @returns Success with provider id and optional timestamp, or failure with disconnect hint.
   */
  sendMedia(input: {
    instanceName: string;
    number: string;
    mediatype: "image" | "video" | "document";
    media: string;
    mimetype?: string;
    fileName?: string;
    caption?: string;
  }): Promise<EvolutionSendResult>;
  /**
   * Fetches base64 media for a provider message id, optionally converting video to mp4.
   *
   * @param input - Instance name, provider message id, and whether to request mp4 conversion.
   * @returns Base64 media with optional mime and file name, or failure with disconnect hint.
   */
  getBase64FromMediaMessage(input: {
    instanceName: string;
    externalMessageId: string;
    convertToMp4: boolean;
  }): Promise<EvolutionMediaFetchResult>;
};

/** Evolution REST client for paginated chat history backfill. */
export type EvolutionHistory = {
  /**
   * Lists remote JIDs for chats on the instance.
   *
   * @param instanceName - Evolution instance identifier.
   * @returns Chat remote JIDs; empty array when the instance has no chats.
   * @throws When the Evolution REST call returns a non-OK status.
   */
  findChats(instanceName: string): Promise<{ remoteJid: string }[]>;
  /**
   * Returns one page of message records for a chat and whether more pages exist.
   *
   * @param instanceName - Evolution instance identifier.
   * @param remoteJid - WhatsApp remote JID for the chat thread.
   * @param page - One-based page index for `findMessages`.
   * @returns Message records for the page and a `hasMore` flag derived from pagination metadata.
   * @throws When the Evolution REST call returns a non-OK status.
   */
  findMessagesPage(
    instanceName: string,
    remoteJid: string,
    page: number,
  ): Promise<{ records: unknown[]; hasMore: boolean }>;
};

/** Outcome of querying live Baileys session state from Evolution. */
export type EvolutionConnectionStateResult =
  | { ok: true; evolutionState: ConnectionState }
  | { ok: false };

/** Evolution REST client for connection-state reconciliation. */
export type EvolutionConnectionState = {
  /**
   * Maps the instance session state to CRM connection state.
   *
   * @param instanceName - Evolution instance identifier.
   * @returns Mapped CRM state on success, `DISCONNECTED` on an HTTP 404 that says the instance
   *   does not exist, or `{ ok: false }` on any other HTTP error (any other 404 included), unmapped state, or
   *   network failure.
   */
  getConnectionState(instanceName: string): Promise<EvolutionConnectionStateResult>;
};

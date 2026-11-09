/**
 * Conversations' HTTP contract: the inbox list and its filters, a thread's messages,
 * the send bodies and the outbox status they report.
 *
 * Moved from `packages/shared-types/src/index.ts` (5.1d) with declarations unchanged.
 */
import { z } from "zod";
import { CONVERSATION_PIPELINE_STAGES, type ConversationPipelineStage, type ConversationSourceType, conversationPipelineStageSchema, conversationSourceTypeSchema } from "../../reports/contracts/http.js";
import { channelStatusSchema } from "../../channel/contracts/http.js";

/** Outbox row lifecycle states from enqueue through provider confirmation or terminal failure. */
export const outboxStatusSchema = z.enum([
  "queued",
  "claimed",
  "sent",
  "confirmed",
  "blocked",
  "failed",
  "cancelled",
]);

/** Tag summary embedded in conversation list rows. */
export const tagSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string().nullable(),
});

/** One row in the conversation inbox list. */
export const conversationSummarySchema = z.object({
  id: z.string(),
  contactLabel: z.string(),
  phone: z.string(),
  lastSnippet: z.string(),
  lastMessageAt: z.string(),
  tags: z.array(tagSummarySchema),
  sourceType: conversationSourceTypeSchema,
  unanswered: z.boolean(),
  /**
   * The furthest funnel point this conversation has reached, derived from
   * REP-15's own rule. Read-only: it is never stored on the conversation and
   * no write surface accepts it, because a stored stage can drift from the
   * funnel that defines it.
   */
  pipelineStage: conversationPipelineStageSchema,
});

/**
 * Which kind of "did not go out" an outbound message is, so the thread can say it
 * in Portuguese without reading the outbox's reason text
 * (`hold-unknown-outcome-sends`):
 *
 * - `outcome_unknown`: `failed` with `send_outcome_unknown` — it may have reached
 *   the customer ("Envio incerto — pode ter chegado. Confira antes de reenviar.");
 * - `not_sent`: any other `failed` row, and a `blocked` row the attendant sent
 *   (not a scheduled message's copy) ("Não enviada").
 */
export const outboxFailureSchema = z.enum(["outcome_unknown", "not_sent"]);

/** One message in a conversation thread, including optional outbox and provider delivery state. */
export const conversationMessageSchema = z.object({
  id: z.string(),
  direction: z.enum(["inbound", "outbound"]),
  messageType: z.enum(["text", "image", "audio", "document", "video", "unknown"]),
  textBody: z.string().nullable(),
  providerTimestamp: z.string(),
  outboxStatus: outboxStatusSchema.optional(),
  /** Present only on an outbox row that did not go out; see {@link outboxFailureSchema}. */
  outboxFailure: outboxFailureSchema.optional(),
  /**
   * Present, `true`, on an outbox row the attendant has already resent (a
   * `resend:<id>` row exists): a `failed` one, or a `blocked` one the resend
   * cancelled. The thread shows "Reenviada" instead of Reenviar or the raw
   * cancelled status (`hold-unknown-followups`).
   */
  outboxResent: z.literal(true).optional(),
  providerStatus: z.enum(["sent", "delivered", "read", "failed"]).optional(),
  contentUnavailable: z.boolean().optional(),
  shouldReply: z.boolean().optional(),
});

/**
 * The idempotency-key prefix the resend reserves: `resend:<outbox id>`. Send-now
 * refuses a key with it, so no one can park arbitrary text under the key a resend
 * will look up and return (`hold-unknown-outcome-sends`, D6).
 */
export const RESEND_KEY_PREFIX = "resend:";

/**
 * A send-now idempotency key: non-empty, and never in the resend's reserved
 * namespace.
 */
export const sendIdempotencyKeySchema = z
  .string()
  .min(1)
  .refine((key) => !key.startsWith(RESEND_KEY_PREFIX), { message: "reserved idempotency key prefix" });

/** Request body for sending a text message in a conversation; optional key deduplicates retries. */
export const sendTextBodySchema = z.object({
  text: z.string().trim().min(1),
  idempotencyKey: sendIdempotencyKeySchema.optional(),
});

/** The resend's refusal: the row is not one the attendant may send again. */
export const resendNotAllowedSchema = z.object({ error: z.literal("resend_not_allowed") });

/**
 * A resend's `409`: either the channel is down (the same body send-now answers)
 * or the row may not be resent. The web branches on which.
 */
export const resendConflictSchema = z.union([channelStatusSchema, resendNotAllowedSchema]);

/** Maximum upload size in bytes (16 MiB) rejected by the CRM before an outbox row is created. */
export const MEDIA_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Builds the inbox preview line for a conversation list row from message type and body.
 *
 * @param messageType - CRM message kind; non-text types get a Portuguese placeholder when `textBody` is empty.
 * @param textBody - Message text or media caption; whitespace-only is treated as absent.
 * @returns Trimmed caption when present; otherwise `[Imagem]`, `[Áudio]`, `[Vídeo]`, or `[Documento]` for the matching media type, or an empty string for `unknown` or text without a caption.
 */
export function conversationListSnippet(
  messageType: "text" | "image" | "audio" | "document" | "video" | "unknown",
  textBody: string | null,
) {
  const caption = textBody?.trim() ?? "";
  if (caption !== "") {
    return caption;
  }
  if (messageType === "image") {
    return "[Imagem]";
  }
  if (messageType === "audio") {
    return "[Áudio]";
  }
  if (messageType === "video") {
    return "[Vídeo]";
  }
  if (messageType === "document") {
    return "[Documento]";
  }
  return "";
}

/** Request body for sending a media message; file bytes are uploaded separately via multipart. */
export const sendMediaBodySchema = z.object({
  messageType: z.enum(["image", "audio", "document", "video"]),
  caption: z.string().optional(),
  idempotencyKey: sendIdempotencyKeySchema.optional(),
});

/** Error body when media bytes cannot be fetched from storage or the provider. */
export const mediaFetchErrorSchema = z.object({
  code: z.literal("media_unavailable"),
});

/** Request body for starting a new conversation from a phone number. */
export const createConversationBodySchema = z.object({
  phone: z.string().trim().min(1),
});

/** Error body when outbound send or conversation create is blocked because the channel is offline. */
export const createConversationErrorSchema = z.object({
  code: z.literal("channel_not_connected"),
});

/** Response body for `GET /conversations`. */
export const conversationSummaryListSchema = z.array(conversationSummarySchema);

/** Response body for `GET /conversations/:id/messages`. */
export const conversationMessageListSchema = z.array(conversationMessageSchema);

/** Calendar date `YYYY-MM-DD` in America/Sao_Paulo, the form the period control produces. */
const inboxDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * Query string for the conversation inbox: tag, search text, unanswered-only,
 * origin, pipeline stage, and an inclusive period over first-inbound time.
 *
 * `origin` and `stage` are deliberately plain strings rather than enums. The
 * spec requires an unknown value to yield an EMPTY list, not an error — a
 * Relatórios link carrying a stage that was later renamed must show an
 * explained empty inbox rather than break the screen — and a zod enum would
 * reject it at the boundary with a 400. {@link conversationListStage} and
 * {@link conversationListOrigin} narrow them after parsing.
 *
 * `from` and `to` are inclusive calendar days. They are converted to the same
 * half-open instant window REP-15 uses, so a report link and the inbox select
 * the same set rather than disagreeing on the last day.
 */
export const conversationListQuerySchema = z.object({
  tagId: z.union([z.string().min(1), z.array(z.string().min(1))]).optional(),
  q: z.string().min(1).optional(),
  unanswered: z.enum(["true", "false"]).optional(),
  origin: z.string().min(1).optional(),
  stage: z.string().min(1).optional(),
  from: inboxDate.optional(),
  to: inboxDate.optional(),
});

/**
 * Narrows the raw `stage` query value to a pipeline stage.
 *
 * @param stage - Raw query value, or undefined when the filter is absent.
 * @returns The stage when it names one; `undefined` when the filter is absent; `"unknown"` when a value was given that names no stage — which the caller answers with an empty list, never the unfiltered one.
 */
export function conversationListStage(
  stage: string | undefined,
): ConversationPipelineStage | "unknown" | undefined {
  if (stage === undefined) {
    return undefined;
  }
  return (CONVERSATION_PIPELINE_STAGES as readonly string[]).includes(stage)
    ? (stage as ConversationPipelineStage)
    : "unknown";
}

/**
 * Narrows the raw `origin` query value to a conversation source type.
 *
 * @param origin - Raw query value, or undefined when the filter is absent.
 * @returns The source type when it names one; `undefined` when absent; `"unknown"` when a value was given that names no classification.
 */
export function conversationListOrigin(
  origin: string | undefined,
): ConversationSourceType | "unknown" | undefined {
  if (origin === undefined) {
    return undefined;
  }
  return origin === "AD" || origin === "ORGANIC" || origin === "UNKNOWN" ? origin : "unknown";
}

/**
 * Converts an inclusive São Paulo calendar day to the half-open instant window
 * REP-15 filters on.
 *
 * São Paulo has been at a fixed −03:00 since Brazil ended daylight saving in
 * 2019, which is what makes a literal offset correct here rather than a lookup.
 *
 * @param from - Inclusive first day as `YYYY-MM-DD`, or undefined for no lower bound.
 * @param to - Inclusive last day as `YYYY-MM-DD`, or undefined for no upper bound.
 * @returns `start` at 00:00 of `from` and `end` at 00:00 of the day AFTER `to`, so the last day is included in full while the comparison stays `[start, end)`.
 */
export function conversationListPeriod(
  from: string | undefined,
  to: string | undefined,
): { start: Date | undefined; end: Date | undefined } {
  const start = from === undefined ? undefined : new Date(`${from}T00:00:00.000-03:00`);
  let end: Date | undefined;
  if (to !== undefined) {
    const dayAfter = new Date(`${to}T00:00:00.000-03:00`);
    dayAfter.setUTCDate(dayAfter.getUTCDate() + 1);
    end = dayAfter;
  }
  return { start, end };
}

/**
 * Whether a conversation's first inbound time falls inside the requested period.
 *
 * @param firstInboundAt - When the contact first wrote, or null when the thread has no inbound message.
 * @param start - Inclusive lower bound instant, or undefined for no bound.
 * @param end - Exclusive upper bound instant, or undefined for no bound.
 * @returns True when inside. A conversation with no first-inbound time is outside any BOUNDED period — it cannot be placed on the calendar — but inside an unbounded one, so it still reaches an unfiltered inbox.
 */
export function withinInboxPeriod(
  firstInboundAt: Date | null,
  start: Date | undefined,
  end: Date | undefined,
): boolean {
  if (start === undefined && end === undefined) {
    return true;
  }
  if (firstInboundAt === null) {
    return false;
  }
  if (start !== undefined && firstInboundAt.getTime() < start.getTime()) {
    return false;
  }
  return end === undefined || firstInboundAt.getTime() < end.getTime();
}

/**
 * Normalizes `tagId` from the conversation list query into a flat filter array.
 *
 * @param query - Parsed `GET /conversations` query; only `tagId` is read.
 * @returns Empty array when `tagId` is omitted; otherwise a one-element array for a string or the same strings when already an array.
 */
export function conversationListTagIds(query: {
  tagId?: string | string[];
}): string[] {
  if (query.tagId === undefined) {
    return [];
  }
  return Array.isArray(query.tagId) ? query.tagId : [query.tagId];
}

/**
 * Interprets the `unanswered` query flag for the conversation inbox filter.
 *
 * @param query - Parsed `GET /conversations` query; only `unanswered` is read.
 * @returns `true` only when `unanswered` is exactly `"true"`; `"false"` and omitted both mean show all threads.
 */
export function conversationListUnanswered(query: { unanswered?: "true" | "false" }): boolean {
  return query.unanswered === "true";
}

/** Outbox row lifecycle state from enqueue through provider confirmation or terminal failure. */
export type OutboxStatus = z.infer<typeof outboxStatusSchema>;

/** Tag summary embedded in conversation list rows. */
export type TagSummary = z.infer<typeof tagSummarySchema>;

/** One row in the conversation inbox list. */
export type ConversationSummary = z.infer<typeof conversationSummarySchema>;

/** One message in a conversation thread, including optional outbox and provider delivery state. */
export type ConversationMessage = z.infer<typeof conversationMessageSchema>;

/** Query string for filtering the conversation inbox by tag, search text, or unanswered-only. */
export type ConversationListQuery = z.infer<typeof conversationListQuerySchema>;

/** Request body for sending a text message in a conversation. */
export type SendTextBody = z.infer<typeof sendTextBodySchema>;
/** See {@link outboxFailureSchema}. */
export type OutboxFailure = z.infer<typeof outboxFailureSchema>;
/** See {@link resendConflictSchema}. */
export type ResendConflict = z.infer<typeof resendConflictSchema>;

/** Request body for sending a media message; file bytes are uploaded separately via multipart. */
export type SendMediaBody = z.infer<typeof sendMediaBodySchema>;

/** Error body when media bytes cannot be fetched from storage or the provider. */
export type MediaFetchError = z.infer<typeof mediaFetchErrorSchema>;

/** Request body for starting a new conversation from a phone number. */
export type CreateConversationBody = z.infer<typeof createConversationBodySchema>;

/** Error body when outbound send or conversation create is blocked because the channel is offline. */
export type CreateConversationError = z.infer<typeof createConversationErrorSchema>;

/**
 * The Conversas DTOs and the shapes the conversation slices pass around: send
 * and media results, list filters, and the builders that turn rows into the
 * shared-types summaries and messages.
 *
 * Moved from `apps/api/src/conversations/store.ts` (4A) without its store port:
 * each slice runs its own queries now. The cadastro link type is the contract's
 * `CadastroLink` (`contracts/get-cadastro-link.ts`).
 */
import { conversationPipelineStage } from "../../reports/contracts/http.js";
import type { ConversationMessage, ConversationSummary, OutboxStatus } from "../contracts/http.js";
import type { ConversationPipelineStage, ConversationSourceType } from "../../reports/contracts/http.js";

/** Result of enqueueing text or media for worker delivery. */
export type EnqueueResult =
  | { status: "ok"; message: ConversationMessage }
  | { status: "not_found" }
  | { status: "channel_down" };

/** Media payload accepted by the media send. */
export type EnqueueMediaInput = {
  messageType: "image" | "audio" | "document" | "video";
  caption?: string;
  bytes: Uint8Array;
  mimeType: string;
  fileName: string;
  idempotencyKey?: string;
};

/** Extends {@link EnqueueResult} with a size-limit rejection. */
export type EnqueueMediaResult = EnqueueResult | { status: "too_large" };

/** Bytes fetched from Evolution for an inbound or sent media message. */
export type FetchMediaResult =
  | {
      status: "ok";
      bytes: Uint8Array;
      mimeType: string;
      fileName: string | null;
      messageType: "image" | "audio" | "document" | "video";
    }
  | { status: "not_found" }
  | { status: "unavailable" };

/**
 * Filters supported by the inbox list.
 *
 * `origin`, `stage` and the period arrive already narrowed: the route rejects
 * an unknown `origin` or `stage` before calling the store, so a value reaching
 * here always names something real.
 */
export type ConversationListQuery = {
  q?: string;
  unanswered?: boolean;
  origin?: ConversationSourceType;
  stage?: ConversationPipelineStage;
  /** Inclusive lower bound instant over first-inbound time. */
  periodStart?: Date;
  /** Exclusive upper bound instant; the inclusive last day is converted to the day after. */
  periodEnd?: Date;
};

/** Outcome of opening or reusing a thread by phone number. */
export type CreateConversationResult =
  | { status: "created" | "existing"; conversation: ConversationSummary }
  | { status: "channel_down" };

/**
 * Narrows a string to supported outbound/inbound media message types.
 *
 * @param value - Raw `messageType` string from persistence or ingest.
 * @returns Type predicate for `image`, `audio`, `document`, or `video`.
 */
export function isMediaMessageType(
  value: string,
): value is "image" | "audio" | "document" | "video" {
  return value === "image" || value === "audio" || value === "document" || value === "video";
}

/**
 * ISO-8601 string for API DTOs from a `Date`.
 *
 * @param value - JavaScript `Date` from Prisma or memory persistence.
 * @returns UTC ISO-8601 string used in shared-types DTOs.
 */
export function toIso(value: Date) {
  return value.toISOString();
}

/**
 * Contact label for the inbox: stored customer name when non-empty, otherwise the conversation phone.
 *
 * @param name - Linked customer `name`; null/blank falls through to the phone.
 * @param phone - Conversation chat key / normalized phone.
 */
export function contactLabelFrom(name: string | null | undefined, phone: string) {
  const trimmed = name?.trim();
  return trimmed ? trimmed : phone;
}

/**
 * Builds a list-row summary DTO from persistence fields.
 *
 * @param input - Conversation id, phone, last snippet, timestamp, attribution source, and optional customer name.
 * @returns {@link ConversationSummary} with an empty `tags` array (filled by the list and open routes).
 */
export function summaryFrom(input: {
  id: string;
  phone: string;
  lastSnippet: string;
  lastMessageAt: Date;
  sourceType: ConversationSourceType;
  unanswered?: boolean;
  customerName?: string | null;
  /**
   * The three events REP-15's funnel counts. Absent means "none of them",
   * which is the correct reading for a thread with inbound messages only.
   */
  stageFacts?: { hasTeamReply: boolean; hasQuoteSent: boolean; hasServiceAttributed: boolean };
}): ConversationSummary {
  return {
    id: input.id,
    contactLabel: contactLabelFrom(input.customerName, input.phone),
    phone: input.phone,
    lastSnippet: input.lastSnippet,
    lastMessageAt: toIso(input.lastMessageAt),
    tags: [],
    sourceType: input.sourceType,
    unanswered: input.unanswered ?? false,
    // Derived by REP-15's own function, never stored and never accepted on a
    // write: a stored stage can drift from the funnel that defines it.
    pipelineStage: conversationPipelineStage(
      input.stageFacts ?? {
        hasTeamReply: false,
        hasQuoteSent: false,
        hasServiceAttributed: false,
      },
    ),
  };
}

/**
 * Digits-only match key shared by search and Nova conversa (same rule as ingest's JID → `chatKey`).
 *
 * @param phone - Phone as entered or stored; non-digits are stripped.
 * @returns Digits-only string used for equality and substring search.
 */
export function normalizedPhoneDigits(phone: string) {
  return phone.replace(/\D/g, "");
}

/**
 * Builds a message DTO from persistence fields and optional outbox/provider metadata.
 *
 * @param input - Message id, direction, type, body, provider timestamp, and optional outbox/provider flags.
 * @returns {@link ConversationMessage} with ISO timestamp and optional delivery metadata.
 */
export function messageFrom(input: {
  id: string;
  direction: "inbound" | "outbound";
  messageType: ConversationMessage["messageType"];
  textBody: string | null;
  providerTimestamp: Date;
  outboxStatus?: OutboxStatus;
  outboxFailure?: ConversationMessage["outboxFailure"];
  outboxResent?: boolean;
  providerStatus?: ConversationMessage["providerStatus"];
  contentUnavailable?: boolean;
  shouldReply?: boolean | null;
}): ConversationMessage {
  return {
    id: input.id,
    direction: input.direction,
    messageType: input.messageType,
    textBody: input.textBody,
    providerTimestamp: toIso(input.providerTimestamp),
    ...(input.outboxStatus ? { outboxStatus: input.outboxStatus } : {}),
    ...(input.outboxFailure ? { outboxFailure: input.outboxFailure } : {}),
    ...(input.outboxResent ? { outboxResent: true as const } : {}),
    ...(input.providerStatus ? { providerStatus: input.providerStatus } : {}),
    ...(input.contentUnavailable ? { contentUnavailable: true } : {}),
    ...(input.shouldReply === true || input.shouldReply === false
      ? { shouldReply: input.shouldReply }
      : {}),
  };
}

/**
 * Inbox HTTP: list, create, thread, channel status.
 */
import {
  channelStatusSchema,
  conversationMessageListSchema,
  conversationSummaryListSchema,
  conversationSummarySchema,
  type ChannelStatus,
  type ConversationMessage,
  type ConversationSummary,
} from "@select-lub/shared-types";
import { apiBase, apiRead, headers, parse } from "./http.js";

/**
 * Lists conversations for the current unit.
 *
 * `origin`, `stage`, `from` and `to` are sent as-is: `GET /conversations`
 * answers an unknown origin or stage with an EMPTY list rather than a 400 or
 * the unfiltered one, because a report link may carry a value that was later
 * renamed and the inbox must explain that rather than pretend nothing was
 * asked. Whether a filter was SENT — as opposed to what it matched — is the
 * caller's to track: the response is a bare array, so nothing in it can tell
 * "no filter" from "filter matched nothing".
 *
 * @param filters - Optional tag ids (AND semantics), search text,
 *   unanswered-only, origin, pipeline stage, and an inclusive `YYYY-MM-DD`
 *   period; omit all to list every conversation.
 * @returns Parsed `ConversationSummary[]` from `GET /conversations`.
 */
export async function fetchConversations(
  filters: {
    tagIds?: string[];
    q?: string;
    unanswered?: boolean;
    origin?: string;
    stage?: string;
    from?: string;
    to?: string;
  } = {},
): Promise<ConversationSummary[]> {
  const params = new URLSearchParams();
  for (const tagId of filters.tagIds ?? []) {
    params.append("tagId", tagId);
  }
  if (filters.q) {
    params.set("q", filters.q);
  }
  if (filters.unanswered) {
    params.set("unanswered", "true");
  }
  if (filters.origin) {
    params.set("origin", filters.origin);
  }
  if (filters.stage) {
    params.set("stage", filters.stage);
  }
  if (filters.from) {
    params.set("from", filters.from);
  }
  if (filters.to) {
    params.set("to", filters.to);
  }
  const query = params.toString();
  const body = await parse(
    await apiRead(`${apiBase}/conversations${query ? `?${query}` : ""}`),
  );
  return conversationSummaryListSchema.parse(body);
}

/**
 * Opens a new conversation thread for a WhatsApp contact.
 * @param phone - Customer phone digits or formatted string sent in the POST body.
 * @returns Parsed `ConversationSummary` from `POST /conversations`.
 */
export async function createConversation(phone: string): Promise<ConversationSummary> {
  const body = await parse(
    await fetch(`${apiBase}/conversations`, {
      method: "POST",
      headers: { ...headers(), "content-type": "application/json" },
      body: JSON.stringify({ phone }),
    }),
  );
  return conversationSummarySchema.parse(body);
}

/**
 * Loads the message history for one conversation.
 * @param conversationId - CRM conversation id used in the path segment.
 * @returns Parsed `ConversationMessage[]` from `GET /conversations/:conversationId/messages`.
 */
export async function fetchMessages(conversationId: string): Promise<ConversationMessage[]> {
  const body = await parse(
    await apiRead(`${apiBase}/conversations/${conversationId}/messages`),
  );
  return conversationMessageListSchema.parse(body);
}

/**
 * Reads Evolution/Baileys channel connection health for the inbox banner.
 * @returns Parsed `ChannelStatus` from `GET /channel/status`.
 */
export async function fetchChannelStatus(): Promise<ChannelStatus> {
  const body = await parse(await apiRead(`${apiBase}/channel/status`));
  return channelStatusSchema.parse(body);
}

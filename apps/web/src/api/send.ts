/**
 * Outbound text and media HTTP.
 */
import {
  conversationMessageSchema,
  resendConflictSchema,
  type ConversationMessage,
  type ResendConflict,
} from "@select-lub/shared-types";
import { apiBase, apiRead, filenameFromContentDisposition, headers, parse } from "./http.js";

/** A refused resend, carrying the route's 409 body (`hold-unknown-outcome-sends`). */
export type ResendRefusal = Error & { status: 409; conflict: ResendConflict };

/**
 * The 409 body of a refused resend, or null when `error` is something else.
 *
 * @param error - What the resend mutation rejected with.
 * @returns `{ state: "DISCONNECTED" }` when the channel is down, or
 *   `{ error: "resend_not_allowed" }` when the message can no longer be resent.
 */
export function resendRefusalOf(error: unknown): ResendConflict | null {
  return error instanceof Error && (error as Partial<ResendRefusal>).status === 409
    ? ((error as ResendRefusal).conflict ?? null)
    : null;
}

/**
 * Sends again an outbound text that did not go out: the server copies the text
 * from the outbox row; the request carries none.
 * @param conversationId - CRM conversation id used in the path segment.
 * @param messageId - The outbox row the thread shows as "Envio incerto" or "Não enviada".
 * @returns The queued copy, from `POST /conversations/:conversationId/messages/:messageId/resend`.
 * @throws {@link ResendRefusal} on a 409 whose body parses; `Error("http <status>")` otherwise.
 */
export async function resendMessage(conversationId: string, messageId: string): Promise<ConversationMessage> {
  const response = await fetch(`${apiBase}/conversations/${conversationId}/messages/${messageId}/resend`, {
    method: "POST",
    headers: headers(),
  });
  if (response.status === 409) {
    const conflict = resendConflictSchema.safeParse(await response.json().catch(() => null));
    if (conflict.success) {
      throw Object.assign(new Error("http 409"), { status: 409 as const, conflict: conflict.data });
    }
    throw new Error("http 409");
  }
  return conversationMessageSchema.parse(await parse(response));
}

/**
 * Queues an outbound text message in the conversation outbox.
 * @param conversationId - CRM conversation id used in the path segment.
 * @param text - Message body; whitespace-only strings are rejected by the caller before send.
 * @param idempotencyKey - Optional client key retried on network failure so the outbox does not duplicate sends.
 * @returns Parsed `ConversationMessage` from `POST /conversations/:conversationId/messages`.
 */
export async function sendText(
  conversationId: string,
  text: string,
  idempotencyKey?: string,
): Promise<ConversationMessage> {
  const body = await parse(
    await fetch(`${apiBase}/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: { ...headers(), "content-type": "application/json" },
      body: JSON.stringify({ text, ...(idempotencyKey ? { idempotencyKey } : {}) }),
    }),
  );
  return conversationMessageSchema.parse(body);
}

/**
 * Downloads media bytes for an inbound or outbound message.
 * @param conversationId - CRM conversation id used in the path segment.
 * @param messageId - Message id whose attachment is fetched.
 * @returns Blob plus optional filename from `Content-Disposition` on `GET /conversations/:conversationId/messages/:messageId/media`.
 */
export async function fetchMessageMedia(conversationId: string, messageId: string) {
  const response = await apiRead(
    `${apiBase}/conversations/${conversationId}/messages/${messageId}/media`,
  );
  if (!response.ok) {
    throw new Error(`http ${response.status}`);
  }
  const blob = await response.blob();
  return {
    blob,
    fileName: filenameFromContentDisposition(response.headers.get("content-disposition")),
  };
}

/**
 * Queues an outbound image, audio, document, or video message.
 * @param conversationId - CRM conversation id used in the path segment.
 * @param input - Uploaded file, detected message type, and optional caption omitted when empty.
 * @param idempotencyKey - Optional client key retried on network failure so the outbox does not duplicate sends.
 * @returns Parsed `ConversationMessage` from `POST /conversations/:conversationId/messages/media`.
 */
export async function sendMedia(
  conversationId: string,
  input: {
    file: File;
    messageType: "image" | "audio" | "document" | "video";
    caption?: string;
  },
  idempotencyKey?: string,
): Promise<ConversationMessage> {
  const form = new FormData();
  form.append("messageType", input.messageType);
  if (input.caption) {
    form.append("caption", input.caption);
  }
  if (idempotencyKey) {
    form.append("idempotencyKey", idempotencyKey);
  }
  form.append("file", input.file);
  const body = await parse(
    await fetch(`${apiBase}/conversations/${conversationId}/messages/media`, {
      method: "POST",
      headers: headers(),
      body: form,
    }),
  );
  return conversationMessageSchema.parse(body);
}

/**
 * `conversations/message-received` — a new canonical message was inserted from
 * an Evolution webhook.
 *
 * Published by `ingest-message` once per NEWLY inserted message on the webhook
 * path, after the insert has committed — exactly where the old worker's
 * `onMessageInserted` hook fired, which it replaces (4A). A redelivered webhook
 * whose message already exists publishes nothing.
 *
 * NOT PUBLISHED FOR:
 * - the history backfill's inserts. A backfilled message is old history, and it
 *   must not open a live prefill window (the backfill stamps the window closed
 *   instead);
 * - the canonical outbound insert that follows a send the drain confirmed
 *   (`channel/outbound-sent`).
 * The old hook never fired on either path, so this keeps today's behaviour.
 *
 * Its planned subscriber is prefill's `enqueue-prefill` (4C). Until then nothing
 * subscribes; the old hook was wired in the worker but never set in production.
 */
import { z } from "zod";
import { defineEvent } from "../../../kernel/events.js";

/** The message that was inserted. */
export const messageReceivedSchema = z.object({
  conversationId: z.string().min(1),
  /** The provider's id for the message, unique within the conversation. */
  externalMessageId: z.string().min(1),
  direction: z.enum(["inbound", "outbound"]),
  messageType: z.enum(["text", "image", "audio", "document", "video", "unknown"]),
  providerTimestamp: z.date(),
});

/** The payload of {@link messageReceived}. */
export type MessageReceived = z.infer<typeof messageReceivedSchema>;

/** Published by `ingest-message` for every newly inserted webhook message. */
export const messageReceived = defineEvent<MessageReceived>("conversations/message-received", messageReceivedSchema);

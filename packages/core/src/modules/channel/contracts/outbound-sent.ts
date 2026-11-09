/**
 * `channel/outbound-sent` — the drain sent a message and Evolution returned a
 * provider timestamp for it, so the thread can show it.
 *
 * WHY AN EVENT (W3-C4, resolved in 4A). Recording the sent message in the thread
 * is a write to `message` and `conversation`, which `conversations` owns;
 * `module_channel` is refused both. The subscriber is `conversations`'
 * `insertSentMessages` (`ingest-message`), wired by the worker's composition
 * root, which inserts under `db.tx("conversations")`.
 *
 * THE ORDER IS PART OF THE CONTRACT. The drain awaits `publish` BEFORE it marks
 * the outbox row confirmed, exactly as it awaited the insert before. `publish`
 * awaits every subscriber and rethrows, so a failed insert still leaves the row
 * unconfirmed. That preserves a pre-existing duplicate-send window, stated in the
 * drain's header and deliberately not changed in this move (owner decision).
 *
 * Not published when Evolution's send response carries no usable timestamp: the
 * later SEND_MESSAGE / MESSAGES_UPSERT webhook for the same provider id inserts
 * the canonical message with Evolution's own timestamp instead.
 */
import { z } from "zod";
import { defineEvent } from "../../../kernel/events.js";

/** Everything the thread needs to record one outbound message. */
export const outboundSentSchema = z.object({
  whatsappConnectionId: z.string().min(1),
  remoteJid: z.string().min(1),
  /** The conversation's chat key, the recipient's normalized number. */
  chatKey: z.string().min(1),
  externalMessageId: z.string().min(1),
  direction: z.literal("outbound"),
  messageType: z.enum(["text", "image", "audio", "document", "video"]),
  textBody: z.string().nullable(),
  /** Evolution's own send timestamp. Never the wall clock. */
  providerTimestamp: z.date(),
});

/** The payload of {@link outboundSent}. */
export type OutboundSent = z.infer<typeof outboundSentSchema>;

/** Published by `drain-outbox` after a send that returned a provider timestamp. */
export const outboundSent = defineEvent<OutboundSent>("channel/outbound-sent", outboundSentSchema);

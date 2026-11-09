/**
 * `channel/webhook-received` — an authenticated Evolution webhook was stored as
 * a `webhook_event` row and answered 200.
 *
 * `receive-webhook` owns the receipt: authentication, the raw write, the reply.
 * What the event MEANS — a message, a status, a connection change — is decided
 * by whoever subscribes. Today that is ingestion's `canonicalizeEvent`, wired by
 * the worker's composition root, which also drives the rest of the
 * `webhook_event` lifecycle (processed / failed / retried) until wave 4A splits
 * that pipeline.
 *
 * PUBLISHED AFTER THE REPLY. The 200 goes out first so Evolution does not retry
 * a slow canonicalization, and `publish` is awaited after it, so processing
 * still completes within the request's lifetime — the behaviour the old route
 * had (see the webhook route test that waits on `markEvent`).
 */
import { z } from "zod";
import { defineEvent } from "../../../kernel/events.js";

/** Identifies the stored raw event. */
export const webhookReceivedSchema = z.object({
  /** The `webhook_event` row id. */
  eventId: z.string().min(1),
});

/** The payload of {@link webhookReceived}. */
export type WebhookReceived = z.infer<typeof webhookReceivedSchema>;

/** Published by `receive-webhook` once the raw event is stored and answered. */
export const webhookReceived = defineEvent<WebhookReceived>(
  "channel/webhook-received",
  webhookReceivedSchema,
);

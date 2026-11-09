/**
 * `receive-webhook` — `POST /webhooks/evolution`, the receipt of an Evolution
 * webhook: authenticate it, store the raw body as a `webhook_event`, answer 200,
 * and publish `channel/webhook-received`.
 *
 * Moved from `apps/worker/src/webhook.ts` (ruling Q6). The receipt is all this
 * slice does. What the event means — a message, a status, a connection change —
 * is decided by the subscriber, which until wave 4A is ingestion's
 * `canonicalizeEvent`, wired by the worker's composition root; so is the rest of
 * the `webhook_event` lifecycle (processed / failed / retried).
 *
 * THE 200 GOES OUT FIRST. Evolution retries anything that is not a 200, so the
 * reply is sent as soon as the raw row is stored, and the event is published
 * after it. `publish` is still awaited, so processing completes within the
 * request's lifetime, as before; a test that must wait for the subscriber waits
 * on the subscriber's own completion, never on the reply.
 *
 * The receipt's write is channel's `recordWebhookEvent` contract, which the rest of
 * the `webhook_event` lifecycle (`contracts/webhook-events.ts`) lives beside; its
 * one transaction runs with a 60 s limit, for bodies up to 50 MiB.
 *
 * The app it is mounted on is the worker's, not the api's: the worker builds it
 * with the 50 MiB body limit history dumps need, `GET /health`, and the database
 * handle bound. An app with no handle bound answers 503 `database_unset`, as the
 * old route did when the worker ran without `DATABASE_URL`.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { publish } from "../../../kernel/events.js";
import type { SliceRoute } from "../../../kernel/http.js";
import { webhookReceived } from "../contracts/webhook-received.js";
import { recordWebhookEvent } from "../contracts/webhook-events.js";
import { summarizeWebhook } from "./envelope.js";

export { summarizeWebhook } from "./envelope.js";

/** The route's path, unchanged. */
export const WEBHOOK_PATH = "/webhooks/evolution";

/** What the route needs. */
export type ReceiveWebhookDeps = {
  /** Bearer token expected in `Authorization`; unset answers 503. */
  secret: string | undefined;
  /** Receives one summary line per authenticated webhook; never the body. */
  log?: (message: string) => void;
};

/**
 * The route, for the worker's app.
 *
 * @param deps - The webhook secret and the log sink.
 * @returns The route to register.
 */
export function route(deps: ReceiveWebhookDeps): SliceRoute<Record<string, never>> {
  const log = deps.log ?? console.log;
  return {
    method: "POST",
    path: WEBHOOK_PATH,
    schema: {},
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      if (!deps.secret) {
        return reply.code(503).send({ error: "webhook_secret_unset" });
      }
      if (!request.server.hasDecorator("db")) {
        return reply.code(503).send({ error: "database_unset" });
      }
      if (request.headers.authorization !== `Bearer ${deps.secret}`) {
        return reply.code(401).send({ error: "unauthorized" });
      }

      const summary = summarizeWebhook(request.body);
      log(
        `webhook event=${summary.event} instance=${summary.instance} externalMessageId=${summary.externalMessageId}`,
      );

      const event = await recordWebhookEvent(request.server.db, request.body);
      await reply.code(200).send({ ok: true });
      await publish(webhookReceived, { eventId: event.id });
    },
  };
}

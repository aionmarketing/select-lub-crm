/**
 * The worker's Fastify instance, before any module mounts on it.
 *
 * Moved from `apps/worker/src/app.ts` in wave 5.2, unchanged: the 50 MiB body
 * limit, the zod type provider, the bound database handle and `GET /health`.
 * The composition root mounts channel's `receive-webhook` on it.
 *
 * No CORS and no multipart: nothing but Evolution posts here, so
 * {@link buildApp}, which registers both for the SPA, is not used.
 */
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import type { Db } from "./db.js";
import { registerWorkerHealth } from "./health.js";
import { fastifyLoggerOptions } from "./logger.js";
import { bindDb } from "./request.js";

/** History dumps (`messages.set`) exceed Fastify's 1 MiB default. */
export const WEBHOOK_BODY_LIMIT = 50 * 1024 * 1024;

/**
 * Builds the webhook app with `/health` on it.
 *
 * @param options.db - Channel's database handle; `null` or absent leaves it
 *   unbound, and the webhook route answers 503 `database_unset`.
 * @returns A configured, not-yet-listening instance.
 */
export async function buildWebhookApp(options: { db?: Db | null }) {
  const app = Fastify({
    logger: process.env.VITEST ? false : fastifyLoggerOptions,
    bodyLimit: WEBHOOK_BODY_LIMIT,
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  if (options.db) {
    bindDb(app, options.db);
  }
  registerWorkerHealth(app);
  return app;
}

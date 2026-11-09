/**
 * `POST /conversations/:id/prefill/retry` — queue a fresh extraction after a
 * failure.
 *
 * Moved from `apps/api/src/prefill/routes.ts` and `prisma.ts` (`retry`). Refused
 * (409) while the extraction switch is off. A job already queued or running is
 * left alone; otherwise one queued job is inserted, for the drain to pick up on
 * its next tick. Writes only `cadastro_prefill_job`.
 *
 * RETRYING A FAILED WINDOW (owner rulings, 2026-09-25). A failure closes its
 * window, so a plain job finds nothing newer than the watermark and is skipped:
 * the error used to vanish without the LLM being called again. When the latest
 * job failed, the new job carries that window's `latestInboundAt`
 * (`window_latest_inbound_at`), and the drain extracts now on the current
 * messages — not skipped because the attendant replied or a new inbound came
 * (review of #168). A double press whose insert loses the in-flight index is
 * answered as "already running", not a 500. A failure
 * from before the column existed has none; the conversation's watermark is the
 * same instant, because that failure is what last closed a window.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { Prisma } from "@select-lub/core/db";
import type { z } from "zod";
import type { DbClient } from "../../../kernel/db.js";
import type { SliceRoute } from "../../../kernel/http.js";
import { unitIdOf } from "../../../kernel/request.js";
import { getCadastroLink } from "../../conversations/contracts/get-cadastro-link.js";
import { prefillSuggestionSchema, type PrefillSuggestion } from "../contracts/http.js";
import { conversationParams, emptyBody } from "../internal/params.js";
import { findInFlightJob } from "../internal/reads.js";
import { getView } from "../internal/suggestion.js";

/** Request and response schemas. */
export const schema = {
  params: conversationParams,
  response: { 200: prefillSuggestionSchema, 404: emptyBody, 409: emptyBody },
};

/**
 * Queues a job unless one is in flight, then answers the view; `null` when the
 * switch is off.
 *
 * @param tx - A client under `module_prefill`, inside one transaction.
 * @param conversationId - The conversation (already scoped to the loja).
 */
export async function retryPrefill(tx: DbClient, conversationId: string): Promise<PrefillSuggestion | null> {
  const current = await getView(tx, conversationId);
  if (!current.extractEnabled) {
    return null;
  }
  if (!(await findInFlightJob(tx, conversationId))) {
    await tx.cadastroPrefillJob.create({
      data: { conversationId, status: "queued", windowLatestInboundAt: await failedWindow(tx, conversationId) },
    });
  }
  return getView(tx, conversationId);
}

/**
 * The failed window to retry when the latest job failed; null otherwise.
 *
 * @param tx - A client under `module_prefill`.
 * @param conversationId - The conversation.
 * @returns The failed job's `windowLatestInboundAt`, or for a failure recorded
 *   before that column, the conversation's watermark — the same instant.
 */
async function failedWindow(tx: DbClient, conversationId: string): Promise<Date | null> {
  const latest = await tx.cadastroPrefillJob.findFirst({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
    select: { status: true, windowLatestInboundAt: true },
  });
  if (latest?.status !== "failed") {
    return null;
  }
  if (latest.windowLatestInboundAt) {
    return latest.windowLatestInboundAt;
  }
  const conversation = await tx.conversation.findUnique({
    where: { id: conversationId },
    select: { lastPrefillWindowClosedAt: true },
  });
  return conversation?.lastPrefillWindowClosedAt ?? null;
}

/**
 * The handler: 200 with the view, 404, or 409 with the switch off.
 *
 * @param request - Parsed params; the hook has set the caller's unit.
 * @param reply - Used for the 404 and 409.
 */
export async function handler(
  request: FastifyRequest<{ Params: z.infer<typeof conversationParams> }>,
  reply: FastifyReply,
) {
  const unitId = unitIdOf(request);
  if (!unitId) {
    return reply.code(404).send({});
  }
  const db = request.server.db;
  const link = await getCadastroLink(db, { conversationId: request.params.id, unitId });
  if (!link) {
    return reply.code(404).send({});
  }
  const view = await db
    .tx("prefill", (tx) => retryPrefill(tx, link.id))
    .catch(async (error: unknown) => {
      // A double press (review of #168): both requests saw no job in flight,
      // and the in-flight partial unique index refused the second insert. The
      // other press's job is running, so answer as for "already running": the
      // current view. Caught OUTSIDE db.tx, which has already rolled back.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return db.tx("prefill", (tx) => getView(tx, link.id));
      }
      throw error;
    });
  if (!view) {
    return reply.code(409).send({});
  }
  return view;
}

/** The slice's route; the path is unchanged from `apps/api`. */
export const route: SliceRoute<typeof schema> = {
  method: "POST",
  path: "/conversations/:id/prefill/retry",
  schema,
  handler,
};

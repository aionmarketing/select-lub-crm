/**
 * The pending suggestion as the routes read and trim it. Moved from
 * `apps/api/src/prefill/prisma.ts` (`getView`, `getFields`, `stripField`),
 * queries unchanged; each takes the client of its caller's
 * `db.tx("prefill", …)`.
 */
import type { PrefillFieldKey, PrefillFields, PrefillSuggestion } from "../contracts/http.js";
import type { DbClient } from "../../../kernel/db.js";
import { mapPrefillView, stripPrefillField } from "./view.js";

/**
 * The rail's view: extracting while a job is in flight, else the pending
 * fields, else failed after a failed job, else empty — with the switch.
 *
 * @param tx - A client under `module_prefill`.
 * @param conversationId - The conversation (already scoped to the caller's loja).
 */
export async function getView(tx: DbClient, conversationId: string): Promise<PrefillSuggestion> {
  const inFlight = await tx.cadastroPrefillJob.findFirst({
    where: { conversationId, status: { in: ["queued", "running"] } },
    select: { id: true },
  });
  const suggestion = await tx.cadastroPrefillSuggestion.findUnique({
    where: { conversationId },
    select: { fields: true },
  });
  const last = await tx.cadastroPrefillJob.findFirst({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
    select: { status: true },
  });
  const conversation = await tx.conversation.findUnique({
    where: { id: conversationId },
    select: { prefillExtractEnabled: true },
  });
  return mapPrefillView({
    inFlight: Boolean(inFlight),
    fields: (suggestion?.fields ?? {}) as PrefillFields,
    lastJobStatus: last?.status ?? null,
    extractEnabled: conversation?.prefillExtractEnabled ?? false,
  });
}

/**
 * The pending suggestion's fields, a copy; `{}` when there is none.
 *
 * @param tx - A client under `module_prefill`.
 * @param conversationId - The conversation.
 */
export async function getFields(tx: DbClient, conversationId: string): Promise<PrefillFields> {
  const row = await tx.cadastroPrefillSuggestion.findUnique({
    where: { conversationId },
    select: { fields: true },
  });
  return { ...((row?.fields ?? {}) as PrefillFields) };
}

/**
 * Removes one accepted or rejected field from the pending suggestion; a no-op
 * when there is no suggestion.
 *
 * @param tx - A client under `module_prefill`.
 * @param conversationId - The conversation.
 * @param field - The field to drop.
 */
export async function stripField(tx: DbClient, conversationId: string, field: PrefillFieldKey): Promise<void> {
  const row = await tx.cadastroPrefillSuggestion.findUnique({
    where: { conversationId },
    select: { fields: true },
  });
  if (!row) {
    return;
  }
  await tx.cadastroPrefillSuggestion.update({
    where: { conversationId },
    data: { fields: stripPrefillField(row.fields as PrefillFields, field) },
  });
}

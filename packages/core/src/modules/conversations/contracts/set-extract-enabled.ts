/**
 * The conversation's prefill extraction switch (**Sugerir dados do cliente**),
 * and closing a prefill window — the two writes prefill (4C) makes to
 * `conversation` and `message`, which are this module's tables.
 *
 * Moved from `apps/api/src/prefill/prisma.ts` (`setExtractEnabled`) and
 * `apps/worker/src/prefill/prisma.ts` (the conversation and message parts of
 * `completeWindow` / `failWindow`). Prefill keeps its own tables
 * (`cadastro_prefill_job`, `cadastro_prefill_suggestion`) and its view read.
 */
import type { Db } from "../../../kernel/db.js";

/**
 * Turns the conversation's extraction switch on or off.
 *
 * Turning it ON also stamps `last_prefill_window_closed_at = now`, as before, so
 * the silence that passed while it was off is never extracted. Turning it OFF
 * leaves the watermark alone.
 *
 * @param db - The database handle; runs on `db.tx("conversations", …)`.
 * @param input.conversationId - The conversation.
 * @param input.unitId - The caller's loja; another unit's thread is `not_found`.
 * @param input.enabled - The switch's new value.
 * @param input.now - The stamp when turning on; defaults to the current instant.
 * @returns `updated` with the value now stored, or `not_found`.
 */
export async function setExtractEnabled(
  db: Db,
  input: { conversationId: string; unitId: string; enabled: boolean; now?: Date },
): Promise<{ status: "updated"; extractEnabled: boolean } | { status: "not_found" }> {
  const now = input.now ?? new Date();
  const result = await db.tx("conversations", (tx) =>
    tx.conversation.updateMany({
      where: { id: input.conversationId, whatsappConnection: { unitId: input.unitId } },
      data: {
        prefillExtractEnabled: input.enabled,
        ...(input.enabled ? { lastPrefillWindowClosedAt: now } : {}),
      },
    }),
  );
  return result.count > 0 ? { status: "updated", extractEnabled: input.enabled } : { status: "not_found" };
}

/**
 * Closes a prefill window: moves the conversation's watermark forward to the
 * window's end, and — when the extraction produced one — records the
 * `should_reply` label on the window's inbound messages.
 *
 * THE WATERMARK ONLY MOVES FORWARD. The switch-on stamp in
 * {@link setExtractEnabled} and a window close can race: an extraction that
 * started before the switch was turned off and on again finishes with an older
 * watermark. A plain write would move the watermark back and re-open silence
 * that was already covered, so the update is a compare-and-set that applies only
 * when the new watermark is later than the stored one (or none is stored).
 *
 * Prefill calls this with `createDb(tx)` inside its own transaction, beside its
 * suggestion and job writes, so the window closes atomically with them.
 *
 * @param db - The database handle; runs on `db.tx("conversations", …)`.
 * @param input.conversationId - The conversation.
 * @param input.watermark - The window's end.
 * @param input.shouldReply - The inbound message ids the extraction labelled, and the label.
 */
export async function closePrefillWindow(
  db: Db,
  input: {
    conversationId: string;
    watermark: Date;
    shouldReply?: { inboundIds: string[]; value: boolean };
  },
): Promise<void> {
  await db.tx("conversations", async (tx) => {
    if (input.shouldReply) {
      await tx.message.updateMany({
        where: { id: { in: input.shouldReply.inboundIds }, conversationId: input.conversationId },
        data: { shouldReply: input.shouldReply.value },
      });
    }
    await tx.conversation.updateMany({
      where: {
        id: input.conversationId,
        OR: [{ lastPrefillWindowClosedAt: null }, { lastPrefillWindowClosedAt: { lt: input.watermark } }],
      },
      data: { lastPrefillWindowClosedAt: input.watermark },
    });
  });
}

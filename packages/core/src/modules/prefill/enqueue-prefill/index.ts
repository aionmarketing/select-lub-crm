/**
 * `enqueue-prefill` — the worker job step that queues one extraction per
 * conversation whose 60-second silence window has closed.
 *
 * Moved from `apps/worker/src/prefill/enqueue.ts` (`enqueueClosedWindows`),
 * logic unchanged. The FIRST half of ONE job, `prefill/enqueue-and-drain`, every
 * `WORKER_PREFILL_POLL_MS`, before `drain-prefill`.
 *
 * A POLL, NOT A SUBSCRIPTION (4C, orchestrator ruling). The window closes on
 * SILENCE — 60 s with no new inbound and no outbound — and `conversations`'
 * `message-received` fires when a message arrives, the one moment a window can
 * never be closed. Subscribing would extract early or still need this timer.
 *
 * THE WATERMARK GUARDS A STALE SCAN in two layers, as before: the scan derives a
 * window only when it is newer than `last_prefill_window_closed_at`, and the
 * drain re-derives it at claim time and skips a job whose window has since
 * closed. A scan that read the watermark just before the drain moved it can
 * therefore queue at most one job the drain will skip.
 *
 * Writes only `cadastro_prefill_job`. The in-flight check and the insert share
 * one `db.tx` per conversation (they were two statements). The database backs
 * the check: a PARTIAL unique index, `UNIQUE (conversation_id) WHERE status IN
 * ('queued','running')`, refuses a second in-flight job — invisible in
 * `schema.prisma`, which cannot express it. So two concurrent scans could not
 * both insert; the loser's insert would fail and its tick be logged. Nothing
 * runs two scans at once anyway: the registry runs one tick of the job at a
 * time, on the one worker.
 */
import type { Db, DbClient } from "../../../kernel/db.js";
import { findInFlightJob, listWindowScan } from "../internal/reads.js";
import { closedWindowForConversation } from "../internal/window.js";

// For this slice's tests: the window constant their clocks are set from, and the
// cadastro read one precondition checks.
export { PREFILL_WINDOW_MS } from "../internal/window.js";
export { resolveCadastro } from "../internal/reads.js";

/**
 * Queues a job unless one is in flight.
 *
 * @param tx - A client under `module_prefill`, inside one transaction.
 * @param conversationId - The conversation whose window closed.
 * @returns Whether a job was queued.
 */
export async function queueUnlessInFlight(tx: DbClient, conversationId: string): Promise<boolean> {
  if (await findInFlightJob(tx, conversationId)) {
    return false;
  }
  await tx.cadastroPrefillJob.create({ data: { conversationId, status: "queued" } });
  return true;
}

/**
 * Inserts one queued job per conversation that currently has a silence-closed
 * window and its extraction switch on.
 *
 * Conversations whose switch is off are skipped before the window is derived. A
 * new inbound restarts the window rather than marking an in-flight job dirty.
 * History and outbox rows never appear as live inbound text here.
 *
 * @param db - The database handle.
 * @param now - Clock the silence is measured against `providerTimestamp` with.
 */
export async function enqueueClosedWindows(db: Db, now: Date): Promise<void> {
  const rows = await db.tx("prefill", (tx) => listWindowScan(tx));
  for (const row of rows) {
    if (!row.prefillExtractEnabled) {
      continue;
    }
    const closed = closedWindowForConversation(
      row.conversationId,
      row.messages,
      row.lastPrefillWindowClosedAt,
      now,
    );
    if (!closed) {
      continue;
    }
    await db.tx("prefill", (tx) => queueUnlessInFlight(tx, row.conversationId));
  }
}

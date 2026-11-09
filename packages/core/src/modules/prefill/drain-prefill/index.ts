/**
 * `drain-prefill` — the worker job step that takes one queued extraction,
 * re-derives its window, asks the LLM, and records the suggestion and the
 * window's close.
 *
 * Moved from `apps/worker/src/prefill/drain.ts` (`drainPrefill`) and the
 * worker's store (`claimQueued`, `markJob`, `completeWindow`, `failWindow`),
 * logic unchanged. The SECOND half of ONE job, `prefill/enqueue-and-drain`,
 * after `enqueue-prefill`. One job per tick.
 *
 * TRANSACTIONS. The claim, the reads and each skip are short `db.tx("prefill")`
 * calls. The LLM call (`generate`) is a provider and runs with NO transaction
 * open. The outcome is then ONE `db.tx("prefill", …)`: the suggestion and the
 * job's status, and — through `conversations`' `closePrefillWindow` on a handle
 * over the same transaction, joined through the kernel's savepoint — the
 * `should_reply` labels and the watermark. They commit or fail together, as
 * `completeWindow` / `failWindow` did.
 *
 * `closePrefillWindow` moves the watermark forward only (compare-and-set); the
 * old code overwrote it. The job claim is compare-and-set on `queued` (it was a
 * read then an update by id).
 */
import type { PrefillFields } from "../contracts/http.js";
import { createDb, type Db, type DbClient } from "../../../kernel/db.js";
import { closePrefillWindow } from "../../conversations/contracts/set-extract-enabled.js";
import type { PrefillCadastroSnapshot, PrefillJob, PrefillJobStatus } from "../internal/cadastro-snapshot.js";
import { PREFILL_RECENT_TEXT_LIMIT, runExtract, type GeneratePrefillFields } from "../internal/extract.js";
import {
  getSuggestionFields,
  getWindowState,
  listRecentTextMessages,
  resolveCadastro,
  toJob,
} from "../internal/reads.js";
import { closedWindowForConversation, windowInboundIds } from "../internal/window.js";

// For this slice's tests, which drive the extraction and its projection with a
// fake `generate`, and assert on the prompt and the resolved snapshot.
export {
  defaultGeneratePrefillFields,
  PREFILL_RECENT_TEXT_LIMIT,
  PREFILL_SYSTEM_PROMPT,
} from "../internal/extract.js";
export { resolveCadastro } from "../internal/reads.js";
export { PREFILL_WINDOW_MS } from "../internal/window.js";
export type { PrefillCadastroSnapshot } from "../internal/cadastro-snapshot.js";

/**
 * Maps any extraction failure to the stable API error token.
 *
 * @param error - Original failure from the LLM or network layer (discarded).
 * @returns Always `"openai_error"`.
 */
export function sanitizePrefillError(error: unknown): string {
  void error;
  return "openai_error";
}

/**
 * Claims the oldest queued job.
 *
 * @param tx - A client under `module_prefill`.
 * @returns The job, now `running`; null when the queue is empty or another claim won.
 */
export async function claimQueued(tx: DbClient): Promise<PrefillJob | null> {
  const row = await tx.cadastroPrefillJob.findFirst({
    where: { status: "queued" },
    orderBy: { createdAt: "asc" },
  });
  if (!row) {
    return null;
  }
  const claimed = await tx.cadastroPrefillJob.updateMany({
    where: { id: row.id, status: "queued" },
    data: { status: "running" },
  });
  if (claimed.count === 0) {
    return null;
  }
  return toJob({ ...row, status: "running" });
}

/**
 * Sets a job's status, and its error when one is given.
 *
 * @param tx - A client under `module_prefill`.
 * @param jobId - The job.
 * @param status - The next status.
 * @param lastError - The error token; omitted leaves the stored one as it was.
 */
export async function markJob(
  tx: DbClient,
  jobId: string,
  status: PrefillJobStatus,
  lastError?: string | null,
): Promise<void> {
  await tx.cadastroPrefillJob.update({
    where: { id: jobId },
    data: { status, ...(lastError !== undefined ? { lastError } : {}) },
  });
}

/**
 * Records a successful extraction: the suggestion, the job, and the window's
 * close with its `should_reply` labels — one transaction.
 *
 * @param tx - A client under `module_prefill`, inside that transaction.
 * @param input - The conversation, job, fields, window inbound ids, label and watermark.
 */
export async function completeWindow(
  tx: DbClient,
  input: {
    conversationId: string;
    jobId: string;
    fields: PrefillFields;
    inboundIds: string[];
    shouldReply: boolean;
    watermark: Date;
  },
): Promise<void> {
  await tx.cadastroPrefillSuggestion.upsert({
    where: { conversationId: input.conversationId },
    create: { conversationId: input.conversationId, jobId: input.jobId, fields: input.fields, extractedAt: new Date() },
    update: { jobId: input.jobId, fields: input.fields, extractedAt: new Date() },
  });
  await markJob(tx, input.jobId, "succeeded");
  await stampWindow(tx, input.jobId, input.watermark);
  await closePrefillWindow(createDb(tx), {
    conversationId: input.conversationId,
    watermark: input.watermark,
    shouldReply: { inboundIds: input.inboundIds, value: input.shouldReply },
  });
}

/**
 * Records a failed extraction and still closes the window, so the same window
 * is not retried every tick — one transaction.
 *
 * @param tx - A client under `module_prefill`, inside that transaction.
 * @param input - The conversation, job, watermark and error token.
 */
export async function failWindow(
  tx: DbClient,
  input: { conversationId: string; jobId: string; watermark: Date; lastError: string },
): Promise<void> {
  await markJob(tx, input.jobId, "failed", input.lastError);
  await stampWindow(tx, input.jobId, input.watermark);
  await closePrefillWindow(createDb(tx), { conversationId: input.conversationId, watermark: input.watermark });
}

/**
 * Records on a finished job which window it ran on, so a retry of a failed one
 * can retry it (owner rulings, 2026-09-25).
 *
 * @param tx - A client under `module_prefill`.
 * @param jobId - The job.
 * @param windowLatestInboundAt - The window's `latestInboundAt`.
 */
async function stampWindow(tx: DbClient, jobId: string, windowLatestInboundAt: Date): Promise<void> {
  await tx.cadastroPrefillJob.update({ where: { id: jobId }, data: { windowLatestInboundAt } });
}

/**
 * Whether a retry job has been overtaken (owner rulings, 2026-09-25).
 *
 * A retry is "extract now", not "replay the window": the window only decides
 * WHEN an extraction triggers on its own, and the prompt is already the recent
 * messages with no window filter. So a retry is never skipped because the
 * attendant replied, or because a new inbound opened a window. It is moot only
 * when a NEWER window has since been extracted successfully: the stored
 * watermark is past the failed window, and a job on a later window succeeded.
 * The view then shows that result.
 *
 * @param stored - The conversation's `last_prefill_window_closed_at`.
 * @param retryOf - The failed window's `latestInboundAt`, carried by the job.
 * @param newerWindowSucceeded - Whether a job on a window after `retryOf` succeeded.
 * @returns True to skip the retry.
 */
export function retryIsMoot(stored: Date | null, retryOf: Date, newerWindowSucceeded: boolean): boolean {
  return stored !== null && stored.getTime() > retryOf.getTime() && newerWindowSucceeded;
}

/**
 * Reads the extraction context, then extracts.
 *
 * The pending suggestion and the recent text are read in one short
 * `db.tx("prefill", …)`, which has CLOSED before `runExtract` calls the LLM —
 * a provider, never awaited inside a transaction. The same shape as the old
 * `runExtract(store, conversationId, snapshot, generate)`, whose store read the
 * context itself.
 *
 * @param db - The database handle.
 * @param conversationId - The conversation.
 * @param snapshot - The cadastro snapshot, including plate-sourced keys.
 * @param generate - The LLM backend; omitted uses the OpenAI one. Tests pass a fake.
 * @returns The prompt, the post-filtered fields and the shouldReply label.
 * @throws What `runExtract` throws (`openai_unconfigured`, `shouldReply_invalid`, the LLM's own).
 */
export async function extractFor(
  db: Db,
  conversationId: string,
  snapshot: PrefillCadastroSnapshot,
  generate?: GeneratePrefillFields,
): ReturnType<typeof runExtract> {
  const context = await db.tx("prefill", async (tx) => ({
    pending: await getSuggestionFields(tx, conversationId),
    recent: await listRecentTextMessages(tx, conversationId, PREFILL_RECENT_TEXT_LIMIT),
  }));
  return runExtract(snapshot, context, generate);
}

/**
 * Processes one queued job when a silence-closed window is still present.
 *
 * Re-derives the window at drain time: if a newer inbound restarted it or an
 * outbound closed it early, the job is skipped without closing the window. On
 * an LLM failure the window is still closed, so it is not retried every tick;
 * the attendant's retry queues a job carrying that window instead, which
 * extracts now on the current messages (see {@link retryIsMoot}).
 *
 * @param db - The database handle.
 * @param generate - Injectable LLM backend; defaults to the OpenAI one. Tests pass a fake.
 * @param now - Clock the window is re-derived with.
 */
export async function drainPrefill(db: Db, generate?: GeneratePrefillFields, now: Date = new Date()): Promise<void> {
  const claimed = await db.tx("prefill", (tx) => claimQueued(tx));
  if (!claimed) {
    return;
  }
  const read = await db.tx("prefill", async (tx) => {
    const snapshot = await resolveCadastro(tx, claimed.conversationId);
    if (!snapshot) {
      return null;
    }
    const state = await getWindowState(tx, claimed.conversationId);
    if (!state) {
      return null;
    }
    const retryOf = claimed.windowLatestInboundAt;
    if (retryOf) {
      // A retry bypasses the window derivation entirely — no watermark gate,
      // no outbound check, no silence check — and extracts on the current
      // messages. It closes with the FAILED window's time, through the same
      // forward-only compare-and-set, so the watermark never moves back and
      // never jumps past a window it has not seen.
      const newer = await tx.cadastroPrefillJob.findFirst({
        where: {
          conversationId: claimed.conversationId,
          status: "succeeded",
          windowLatestInboundAt: { gt: retryOf },
        },
        select: { id: true },
      });
      if (retryIsMoot(state.lastPrefillWindowClosedAt, retryOf, newer !== null)) {
        return null;
      }
      const closed = {
        conversationId: claimed.conversationId,
        inboundIds: windowInboundIds(state.messages, retryOf),
        latestInboundAt: retryOf,
      };
      return { snapshot, closed };
    }
    const closed = closedWindowForConversation(
      claimed.conversationId,
      state.messages,
      state.lastPrefillWindowClosedAt,
      now,
    );
    return closed ? { snapshot, closed } : null;
  });
  if (!read) {
    await db.tx("prefill", (tx) => markJob(tx, claimed.id, "skipped"));
    return;
  }
  const { closed } = read;
  // As before, a failure anywhere in extract-then-complete — the context read,
  // the LLM, or the completing write — falls through to failWindow, so the job
  // never stays `running` (nothing reclaims a stuck prefill job).
  try {
    const extracted = await extractFor(db, claimed.conversationId, read.snapshot, generate);
    await db.tx("prefill", (tx) =>
      completeWindow(tx, {
        conversationId: claimed.conversationId,
        jobId: claimed.id,
        fields: extracted.fields,
        inboundIds: closed.inboundIds,
        shouldReply: extracted.shouldReply,
        watermark: closed.latestInboundAt,
      }),
    );
  } catch (error) {
    await db.tx("prefill", (tx) =>
      failWindow(tx, {
        conversationId: claimed.conversationId,
        jobId: claimed.id,
        watermark: closed.latestInboundAt,
        lastError: sanitizePrefillError(error),
      }),
    );
  }
}

/**
 * Pushes queued ERP writes: `erp_outbox` → the ERP port.
 *
 * One tick reclaims rows a crashed or hung tick left in `sending`, claims a
 * batch of due `pending` rows, pushes each through `erp.adapter.put`, and
 * records the outcome. Reclaiming, claiming and recording are each their own
 * `erp` transaction; the push happens between claim and record, outside any
 * transaction (W2-C12). A claimed row is `sending`, so a second worker skips it
 * (`FOR UPDATE SKIP LOCKED`).
 *
 * Outcomes: every field accepted → `sent`. The ERP rejected a field → `failed`
 * at once, because the same value would be rejected again. The call threw →
 * back to `pending` with a doubling delay, and `failed` after
 * {@link ERP_OUTBOX_MAX_ATTEMPTS}. A row left `sending` longer than
 * {@link ERP_OUTBOX_CLAIM_TIMEOUT_MS} is reclaimed, and the reclaim **counts as
 * an attempt**: a put that hangs, or kills the worker, is retried on the same
 * schedule and ends `failed`, never retried forever. Each failure and each
 * reclaim writes an `integration_error` keyed by the row id.
 *
 * Recording is a compare-and-set on `(id, status = 'sending', claimed_at)` —
 * the claim's own timestamp. A push slower than the reclaim window may be
 * reclaimed and pushed again by a later tick; when the slow push finally
 * returns, its result no longer matches the row and changes nothing (`stale`).
 * The same pattern as channel's due-tick.
 *
 * Exported through `createJobs` and not registered: `erp_outbox` has no writer
 * until 4B, and that stream registers the job (3A, W3-C2; `services` writes
 * nothing back, W3-C8).
 */
import type { CrmFieldValue } from "../../../kernel/clients/erp-mock.js";
import type { OmieSharedFieldKey } from "../../../shared/web/omie-field-keys.js";
import type { ErpPort } from "../../../kernel/clients/erp.js";
import type { Db } from "../../../kernel/db.js";
import type { Job } from "../../../kernel/jobs.js";

/** Tick interval when none is given. */
export const DRAIN_ERP_OUTBOX_EVERY_MS = 10_000;
/** Rows claimed per tick. */
export const ERP_OUTBOX_BATCH = 10;
/** Attempts before a row is marked `failed`; a reclaim is an attempt. */
export const ERP_OUTBOX_MAX_ATTEMPTS = 5;
/** How long a row may stay `sending` before a later tick reclaims it. */
export const ERP_OUTBOX_CLAIM_TIMEOUT_MS = 5 * 60_000;
/** The first retry delay; each later one doubles, capped at an hour. */
export const ERP_OUTBOX_RETRY_BASE_MS = 30_000;
/** `last_error` of a row reclaimed because its push never reported back. */
export const ERP_OUTBOX_CLAIM_EXPIRED = "claim expired: the push never reported back";

/** What the job needs, held in the closure `createJobs` builds. */
export type DrainErpOutboxDeps = {
  db: Db;
  erp: ErpPort;
  everyMs?: number;
};

/** How one tick went, counted per row. */
export type DrainErpOutboxResult = {
  /** Rows taken back from `sending`, whether returned to `pending` or failed. */
  reclaimed: number;
  claimed: number;
  sent: number;
  retried: number;
  /** Rows made terminal this tick, by a push or by a reclaim. */
  failed: number;
  /** Pushes whose row had been reclaimed meanwhile; their result was discarded. */
  stale: number;
};

type ClaimedRow = {
  id: string;
  erp_record_id: string;
  integration_code: string | null;
  fields: Partial<Record<OmieSharedFieldKey, CrmFieldValue>>;
  attempt_count: number;
  claimed_at: Date;
};

type Outcome =
  | { kind: "sent" }
  | { kind: "rejected"; reasons: string }
  | { kind: "threw"; message: string };

/**
 * The delay before retry number `attempt` (1-based).
 *
 * @param attempt - How many attempts have been made, this one included.
 * @returns Milliseconds: 30 s, 60 s, 120 s, … capped at one hour.
 */
export function retryDelayMs(attempt: number): number {
  return Math.min(ERP_OUTBOX_RETRY_BASE_MS * 2 ** (attempt - 1), 3_600_000);
}

async function reclaimStuck(db: Db, now: Date): Promise<{ reclaimed: number; failed: number }> {
  const cutoff = new Date(now.getTime() - ERP_OUTBOX_CLAIM_TIMEOUT_MS);
  return db.tx("erp", async (tx) => {
    const stuck = await tx.$queryRaw<Array<{ id: string; attempt_count: number }>>`
      SELECT "id", "attempt_count" FROM "erp_outbox"
       WHERE "status" = 'sending' AND "claimed_at" < ${cutoff}
       ORDER BY "claimed_at", "id"
       FOR UPDATE SKIP LOCKED`;
    let failed = 0;
    for (const row of stuck) {
      const attempt = row.attempt_count + 1;
      const retry = attempt < ERP_OUTBOX_MAX_ATTEMPTS;
      if (!retry) failed += 1;
      await tx.erpOutbox.update({
        where: { id: row.id },
        data: {
          status: retry ? "pending" : "failed",
          attemptCount: attempt,
          lastError: ERP_OUTBOX_CLAIM_EXPIRED,
          claimedAt: null,
          ...(retry ? { nextAttemptAt: new Date(now.getTime() + retryDelayMs(attempt)) } : {}),
        },
      });
      await tx.integrationError.create({
        data: {
          integration: "OMIE",
          operation: "erpOutboxPut",
          correlationId: row.id,
          code: "erp_put_claim_expired",
          message: ERP_OUTBOX_CLAIM_EXPIRED,
          retryable: retry,
          attemptCount: attempt,
        },
      });
    }
    return { reclaimed: stuck.length, failed };
  });
}

async function claimDue(db: Db, now: Date, limit: number): Promise<ClaimedRow[]> {
  // A MATERIALIZED CTE, not `WHERE id IN (SELECT … LIMIT n FOR UPDATE SKIP LOCKED)`.
  // In that form the planner may put the subquery on the inner side of a nested
  // loop and rescan it once per outer row; LockRows skips rows this same
  // statement already updated, so each rescan reaches past them and the UPDATE
  // claims more than `limit` rows. Seen as 3 claimed of limit 2 in a root run,
  // and pinned by the batch-limit test, which forces that plan.
  return db.tx("erp", (tx) =>
    tx.$queryRaw<ClaimedRow[]>`
      WITH "picked" AS MATERIALIZED (
        SELECT "id" FROM "erp_outbox"
         WHERE "status" = 'pending' AND "next_attempt_at" <= ${now}
         ORDER BY "created_at", "id"
         LIMIT ${limit}
         FOR UPDATE SKIP LOCKED
      )
      UPDATE "erp_outbox" AS "o"
         SET "status" = 'sending', "claimed_at" = ${now}, "updated_at" = ${now}
        FROM "picked"
       WHERE "o"."id" = "picked"."id"
      RETURNING "o"."id", "o"."erp_record_id", "o"."integration_code", "o"."fields",
                "o"."attempt_count", "o"."claimed_at"`,
  );
}

async function push(erp: ErpPort, row: ClaimedRow): Promise<Outcome> {
  try {
    const result = await erp.adapter.put(
      row.erp_record_id,
      row.fields,
      row.integration_code ?? undefined,
    );
    if (result.failedKeys.length === 0) return { kind: "sent" };
    const reasons = result.failedKeys.map((key) => `${key}: ${result.reasons?.[key] ?? "rejected"}`);
    return { kind: "rejected", reasons: reasons.join("; ") };
  } catch (error: unknown) {
    return { kind: "threw", message: error instanceof Error ? error.message : "unknown" };
  }
}

async function record(
  db: Db,
  row: ClaimedRow,
  outcome: Outcome,
  now: Date,
): Promise<"sent" | "retried" | "failed" | "stale"> {
  const attempt = row.attempt_count + 1;
  // Compare-and-set: only the claim that is still current may record. A row
  // reclaimed while this push was out has another status or another claimed_at.
  const current = { id: row.id, status: "sending", claimedAt: row.claimed_at };
  return db.tx("erp", async (tx) => {
    if (outcome.kind === "sent") {
      const { count } = await tx.erpOutbox.updateMany({
        where: current,
        data: { status: "sent", sentAt: now, attemptCount: attempt, lastError: null, claimedAt: null },
      });
      return count === 1 ? "sent" : "stale";
    }
    const retry = outcome.kind === "threw" && attempt < ERP_OUTBOX_MAX_ATTEMPTS;
    const message = outcome.kind === "rejected" ? outcome.reasons : outcome.message;
    const { count } = await tx.erpOutbox.updateMany({
      where: current,
      data: {
        status: retry ? "pending" : "failed",
        attemptCount: attempt,
        lastError: message,
        claimedAt: null,
        ...(retry ? { nextAttemptAt: new Date(now.getTime() + retryDelayMs(attempt)) } : {}),
      },
    });
    if (count !== 1) return "stale";
    await tx.integrationError.create({
      data: {
        integration: "OMIE",
        operation: "erpOutboxPut",
        correlationId: row.id,
        code: outcome.kind === "rejected" ? "erp_put_rejected" : "erp_put_failed",
        message,
        retryable: retry,
        attemptCount: attempt,
      },
    });
    return retry ? "retried" : "failed";
  });
}

/**
 * Runs one drain tick.
 *
 * @param db - The database handle.
 * @param erp - The ERP port the writes are pushed through.
 * @param options.now - The clock; defaults to the wall clock.
 * @param options.limit - Rows claimed this tick; defaults to {@link ERP_OUTBOX_BATCH}.
 * @returns Counts for the tick.
 */
export async function drainErpOutbox(
  db: Db,
  erp: ErpPort,
  options: { now?: Date; limit?: number } = {},
): Promise<DrainErpOutboxResult> {
  const now = options.now ?? new Date();
  const result: DrainErpOutboxResult = {
    reclaimed: 0,
    claimed: 0,
    sent: 0,
    retried: 0,
    failed: 0,
    stale: 0,
  };
  const reclaim = await reclaimStuck(db, now);
  result.reclaimed = reclaim.reclaimed;
  result.failed += reclaim.failed;
  const rows = await claimDue(db, now, options.limit ?? ERP_OUTBOX_BATCH);
  result.claimed = rows.length;
  for (const row of rows) {
    const outcome = await push(erp, row);
    result[await record(db, row, outcome, now)] += 1;
  }
  return result;
}

/**
 * The drain as a job. Not registered yet; see the file header.
 *
 * @param deps - The database handle and the ERP port.
 * @returns A job named `erp/drain-outbox`.
 */
export function job(deps: DrainErpOutboxDeps): Job {
  return {
    name: "erp/drain-outbox",
    everyMs: deps.everyMs ?? DRAIN_ERP_OUTBOX_EVERY_MS,
    run: async () => {
      await drainErpOutbox(deps.db, deps.erp);
    },
  };
}

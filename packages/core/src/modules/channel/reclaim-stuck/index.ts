/**
 * `reclaim-stuck` — the worker job that settles abandoned claims.
 *
 * Moved from `apps/worker/src/outbox/prisma.ts` (`reclaimAbandonedClaims`) and
 * the reclaim timer in `apps/worker/src/worker.ts`. A row stays `claimed` only
 * while the drain is sending it, and every send is now bounded (120 s at most),
 * so one older than the claim timeout was left by a drain that stopped mid-send.
 *
 * IT FAILS THE ROW, IT NEVER REQUEUES IT (`hold-unknown-outcome-sends`, owner rule
 * 2026-09-25). The stopped drain may have handed the message to Evolution before
 * it died, so the outcome is unknown: the row becomes `failed` with
 * `send_outcome_unknown`, and a person decides whether to resend. This used to be
 * where the drain's duplicate-send window closed into a second send. If the
 * original send does return an id later, `markConfirmed` records it `confirmed`.
 *
 * THE CLOCK IS THE DATABASE'S. The cutoff is computed in SQL from `NOW()`.
 */
import type { Db } from "../../../kernel/db.js";
import type { Job } from "../../../kernel/jobs.js";
import { OUTBOX_SEND_OUTCOME_UNKNOWN } from "../contracts/send-outcome.js";

/**
 * Claim age after which a row is failed as an unknown outcome, and the job's
 * interval, when none is given. Above the 120 s media send limit with margin, so
 * a row still inside its own send is never reclaimed (ruling Q3).
 */
export const RECLAIM_CLAIM_TIMEOUT_MS = 180_000;

/** What the job needs. */
export type ReclaimStuckDeps = {
  db: Db;
  /** `WORKER_OUTBOX_CLAIM_TIMEOUT_MS`; both the age cutoff and the interval. */
  claimTimeoutMs?: number;
};

/**
 * Fails every `claimed` row older than the timeout as an unknown outcome, clears
 * its claim stamp and discards its media bytes. Never requeues.
 *
 * @param db - The database handle; runs on `db.tx("channel", …)`.
 * @param timeoutMs - Claim age cutoff in milliseconds.
 * @returns How many rows were failed.
 */
export async function reclaimStuck(db: Db, timeoutMs: number): Promise<number> {
  return db.tx("channel", (tx) =>
    tx.$executeRaw`
      UPDATE outbox_message
      SET status = 'failed', last_error = ${OUTBOX_SEND_OUTCOME_UNKNOWN},
          claimed_at = NULL, media_bytes = NULL, updated_at = NOW()
      WHERE status = 'claimed'
        AND claimed_at < NOW() - (${timeoutMs} * INTERVAL '1 millisecond')
    `,
  );
}

/**
 * The job, for the kernel's registry. The interval equals the timeout, as the
 * old reclaim timer's did.
 *
 * @param deps - The database handle and the optional timeout.
 * @returns A job named `channel/reclaim-stuck`.
 */
export function job(deps: ReclaimStuckDeps): Job {
  const timeoutMs = deps.claimTimeoutMs ?? RECLAIM_CLAIM_TIMEOUT_MS;
  return {
    name: "channel/reclaim-stuck",
    everyMs: timeoutMs,
    run: async () => {
      await reclaimStuck(deps.db, timeoutMs);
    },
  };
}

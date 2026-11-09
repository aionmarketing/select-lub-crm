/**
 * Test design (testing-strategy)
 *
 * Setup: `reclaimStuck(db, timeoutMs)` through the slice's entry point, against the
 * worktree database inside a rolling-back test transaction (`withTestTransaction`).
 * No Evolution HTTP.
 *
 * Ran under module role: `channel` (the statement runs on `db.tx("channel")`).
 *
 * Moved from apps/worker/src/outbox/reclaim.test.ts (adopt-modular-vertical-slices
 * 3A), all 7 cases, assertions unchanged. The note below about a store interface
 * predates the move: there is no store now, the slice takes the `Db` handle.
 *
 * Oracle: whatsapp-channel "Simple single-worker outbox sends attendant text",
 *   as modified by hold-unknown-outcome-sends — a claimed row older than the
 *   timeout becomes `failed` with `send_outcome_unknown` and the claim marker
 *   cleared, and is NEVER requeued (the stopped drain may have sent it); a
 *   claimed row younger than the timeout is untouched; other statuses are never
 *   altered. Before that change the stale row returned to `queued`.
 *
 * NO STORE INTERFACE WAS ADDED (design.md Open Questions, closed by this stream).
 * The open question asked whether the outbox should gain a `store.ts` as part of
 * this migration. It should not, because the premise behind D5 — "each
 * `memory.ts` declares `XStore`; the type moves to a sibling `store.ts`" — never
 * applied here. `OutboxDrain` has always lived in `outbox/types.ts` beside
 * `ClaimedOutbox` and the Evolution ports, `prisma.ts` already imports it from
 * there, and `outbox/README.md` documents `types.ts` as "the port". There is no
 * interface to rescue from a fake, so a new file would either duplicate the type
 * or split one coherent port module for no behavioural gain. This file and
 * drain.test.ts therefore drive `createPrismaOutbox(tx)` directly.
 *
 * FAKE-ONLY ASSERTIONS SURFACED (route-tests-on-real-database, D10). Two, and the
 * first invalidated the whole file's clock strategy.
 *
 *   1. The file installed `vi.useFakeTimers()` and pinned the system time, then
 *      set `claimedAt` relative to that frozen instant. That worked only because
 *      the fake compared against JavaScript's `Date.now()`. The adapter's cutoff
 *      is computed IN SQL — `claimed_at < NOW() - (timeoutMs * INTERVAL '1
 *      millisecond')` — so it reads the DATABASE's clock, which `vi.setSystemTime`
 *      cannot move. Under fake timers the boundary cases would have compared a
 *      1970-relative or arbitrarily-skewed stamp against the server's real time
 *      and passed or failed for reasons unrelated to the rule. The fake timers are
 *      removed; every timestamp is now computed from the database's own `NOW()`,
 *      read once per test. Inside a transaction Postgres's `NOW()` is
 *      `transaction_timestamp()` and does not advance, so nothing has to be
 *      frozen for the comparison to be stable — but see the precision limit below
 *      for how close to the cutoff it can actually be probed.
 *
 *      REMOVED with the fake timers: the BVA case "claimed age exactly timeout",
 *      which distinguished `<` from `<=` at the boundary. That distinction is not
 *      observable against this schema. `outbox_message.claimed_at` is
 *      `timestamp(3)` — milliseconds — while SQL `NOW()` carries microseconds, and
 *      the driver hands JavaScript a `Date` truncated to milliseconds. So a row
 *      stamped at what the test believes is exactly the cutoff is really older
 *      than the cutoff by the microsecond remainder, and is reclaimed; writing the
 *      stamp from SQL instead does not help, because storing `NOW() - interval`
 *      into a `timestamp(3)` column ROUNDS, which lands on either side of the
 *      boundary depending on that same remainder — a flaky test, not a stricter
 *      one. The two neighbouring cases ARE deterministic, because the remainder is
 *      bounded by 1ms and both sit a full millisecond clear of the cutoff, so the
 *      file keeps those and states that `<` versus `<=` is untested here. This
 *      failure is what surfaced it: the exact-boundary case failed on first run.
 *
 *   The `<`-vs-`<=` choice remains covered indirectly: a row exactly at the
 *   cutoff is, in every real scenario, one the previous tick already saw, and
 *   both readings requeue it on the following tick.
 *
 *   2. `store.outbox()[0]` was position zero of the fake's whole list. The
 *      adapter's `reclaimAbandonedClaims` has no tenancy predicate at all — it
 *      requeues every stale `claimed` row in the table — so the index was standing
 *      in for "the row this test made". Each read is now by the row's own id, and
 *      the untouched-status cases additionally assert the row this test created is
 *      the only one it is speaking for (design.md D9).
 *
 * Axes
 *   A1 status — claimed / queued / confirmed / cancelled
 *   A2 claimedAt vs cutoff (timeoutMs = 1000) — BVA one millisecond either
 *     side of the cutoff, and null. The cutoff itself is not observable; see
 *     note 1.
 *
 * Outputs: O1 failed + send_outcome_unknown + claimedAt null; O2 unchanged
 *
 * Sampled-cell
 *   claimed age cutoff−1ms  | A1 claimed A2 +1   | O1 | stays claimed
 *   claimed age cutoff+1ms  | A1 claimed A2 −1   | O2 | reclaimed
 *   claimed claimedAt null  | A1 claimed A2 null | O2 | reclaimed
 *   queued leftover stamp   | A1 queued          | O2 | status flipped
 *   confirmed               | A1 confirmed       | O2 | status flipped
 *   cancelled               | A1 cancelled       | O2 | status flipped
 *
 * Decision / branch map (reclaimStuck WHERE, formerly prisma.ts reclaimAbandonedClaims)
 *   status = 'claimed'          T claimed its; F queued/confirmed/cancelled its
 *   claimed_at IS NULL          NULL comparison is never true — null it
 *   claimed_at < NOW() - iv     T older-by-1ms it; F younger-by-1ms it
 *
 * Out of scope: the claim itself and its backoff (drain-outbox); the job's
 *   interval (apps/worker/test/worker.test.ts).
 */
import { prisma, type PrismaClient } from "@select-lub/core/db";
import { expect, it } from "vitest";
import { createDb, type DbClient } from "../../../../kernel/db.js";
import {
  describeWithDatabase,
  runInTransactionOnTx,
  seedConnection,
  seedConversation,
  seedUnit,
  withTestTransaction,
} from "../../../../testing/index.js";
import { reclaimStuck } from "../index.js";

const TIMEOUT_MS = 1_000;

const db = () => prisma as PrismaClient;

/**
 * Reads the database's own clock.
 *
 * Inside a transaction this is `transaction_timestamp()`, so it is the same
 * instant the adapter's `NOW()` will see. See note 1 in the header.
 *
 * @param tx - The test transaction.
 * @returns The transaction's timestamp.
 */
async function databaseNow(tx: DbClient): Promise<Date> {
  const rows = await tx.$queryRaw<{ now: Date }[]>`SELECT NOW() AS now`;
  return rows[0]!.now;
}

/**
 * Seeds a unit, connection and conversation and a `Db` over the transaction.
 *
 * @param tx - The test transaction.
 * @returns The conversation id, the database clock, and the handle.
 */
async function setup(tx: DbClient) {
  const unit = await seedUnit(tx);
  const connection = await seedConnection(tx, { unitId: unit.id });
  const conversation = await seedConversation(tx, { connectionId: connection.id });
  return {
    conversationId: conversation.id,
    now: await databaseNow(tx),
    handle: createDb(tx, runInTransactionOnTx(tx)),
  };
}

/**
 * Inserts one outbox row in a given state.
 *
 * @param tx - The test transaction.
 * @param conversationId - Conversation the row belongs to.
 * @param input - Status, body and optional claim stamp.
 * @returns The new row's id.
 */
async function enqueue(
  tx: DbClient,
  conversationId: string,
  input: { status: string; textBody: string; claimedAt?: Date | null },
): Promise<string> {
  const row = await tx.outboxMessage.create({
    data: {
      conversationId,
      messageType: "text",
      textBody: input.textBody,
      status: input.status,
      claimedAt: input.claimedAt ?? null,
    },
    select: { id: true },
  });
  return row.id;
}

/**
 * Reads one outbox row back by its id.
 *
 * @param tx - The test transaction.
 * @param id - The row id.
 * @returns The row.
 */
function rowOf(tx: DbClient, id: string) {
  return tx.outboxMessage.findUniqueOrThrow({ where: { id } });
}

describeWithDatabase("reclaim-stuck", () => {
  it("fails a claimed row older than the timeout as an unknown outcome, never requeuing it", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversationId, now, handle } = await setup(tx);
      const id = await enqueue(tx, conversationId, {
        status: "claimed",
        textBody: "stale",
        claimedAt: new Date(now.getTime() - (TIMEOUT_MS + 1)),
      });

      await reclaimStuck(handle, TIMEOUT_MS);

      const row = await rowOf(tx, id);
      expect(row.status).toBe("failed");
      expect(row.lastError).toBe("send_outcome_unknown");
      expect(row.claimedAt).toBeNull();
    }));

  it("leaves a claimed row one millisecond younger than the cutoff untouched", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversationId, now, handle } = await setup(tx);
      // The tight side of the BVA. `now` is the transaction timestamp truncated
      // to milliseconds by the driver, so it is at most 1ms BEFORE the adapter's
      // microsecond-precise `NOW()`. A stamp of `now - (TIMEOUT_MS - 1)` is
      // therefore strictly younger than the cutoff whatever that remainder is,
      // which makes this case deterministic. See note 1 in the header.
      const claimedAt = new Date(now.getTime() - (TIMEOUT_MS - 1));
      const id = await enqueue(tx, conversationId, {
        status: "claimed",
        textBody: "young",
        claimedAt,
      });

      await reclaimStuck(handle, TIMEOUT_MS);

      const row = await rowOf(tx, id);
      expect(row.status).toBe("claimed");
      expect(row.claimedAt).toEqual(claimedAt);
    }));

  it("leaves a claimed row with no claimedAt untouched", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversationId, handle } = await setup(tx);
      // SQL three-valued logic, not an explicit null branch: `NULL < anything`
      // is unknown, so the row never matches the WHERE.
      const id = await enqueue(tx, conversationId, {
        status: "claimed",
        textBody: "no-stamp",
        claimedAt: null,
      });

      await reclaimStuck(handle, TIMEOUT_MS);

      const row = await rowOf(tx, id);
      expect(row.status).toBe("claimed");
      expect(row.claimedAt).toBeNull();
    }));

  it("does not alter a queued row that still has an old claimedAt", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversationId, now, handle } = await setup(tx);
      const claimedAt = new Date(now.getTime() - (TIMEOUT_MS + 1));
      const id = await enqueue(tx, conversationId, {
        status: "queued",
        textBody: "queued",
        claimedAt,
      });

      await reclaimStuck(handle, TIMEOUT_MS);

      const row = await rowOf(tx, id);
      expect(row.status).toBe("queued");
      expect(row.claimedAt).toEqual(claimedAt);
    }));

  it("does not alter a confirmed row", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversationId, now, handle } = await setup(tx);
      const id = await enqueue(tx, conversationId, {
        status: "confirmed",
        textBody: "done",
        claimedAt: new Date(now.getTime() - (TIMEOUT_MS + 1)),
      });

      await reclaimStuck(handle, TIMEOUT_MS);

      expect((await rowOf(tx, id)).status).toBe("confirmed");
    }));

  it("does not alter a cancelled row", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversationId, now, handle } = await setup(tx);
      const id = await enqueue(tx, conversationId, {
        status: "cancelled",
        textBody: "cancel",
        claimedAt: new Date(now.getTime() - (TIMEOUT_MS + 1)),
      });

      await reclaimStuck(handle, TIMEOUT_MS);

      expect((await rowOf(tx, id)).status).toBe("cancelled");
    }));

  it("fails only the stale claimed rows when several states sit side by side", () =>
    withTestTransaction(db(), async (tx) => {
      // The adapter has no tenancy predicate, so this also pins that it touches
      // rows by STATUS and AGE rather than sweeping the conversation.
      const { conversationId, now, handle } = await setup(tx);
      const stale = await enqueue(tx, conversationId, {
        status: "claimed",
        textBody: "stale",
        claimedAt: new Date(now.getTime() - (TIMEOUT_MS + 1)),
      });
      const fresh = await enqueue(tx, conversationId, {
        status: "claimed",
        textBody: "fresh",
        claimedAt: new Date(now.getTime() - (TIMEOUT_MS - 1)),
      });
      const cancelled = await enqueue(tx, conversationId, {
        status: "cancelled",
        textBody: "cancel",
        claimedAt: new Date(now.getTime() - (TIMEOUT_MS + 1)),
      });

      await reclaimStuck(handle, TIMEOUT_MS);

      expect((await rowOf(tx, stale)).status).toBe("failed");
      expect((await rowOf(tx, fresh)).status).toBe("claimed");
      expect((await rowOf(tx, cancelled)).status).toBe("cancelled");
    }));
});

/**
 * Test design (testing-strategy)
 *
 * SUT: `claimQueued` — the drain's claim of the oldest queued outbox row — on
 *   the real database, from two connections at once and under a forced plan.
 *
 * Ran under module role: `channel` (the claim runs on `db.tx("channel")`).
 *
 * WHY LIVE, AND WHY A SCRATCH DATABASE. Two claims can only race on two
 * connections, which see each other's rows only once committed, so the first
 * case commits a `queued` row. The claim has no connection scoping: committed to
 * the worktree's shared database, that row could be claimed by any worker
 * pointed at it, and sent as a real WhatsApp. So this file runs on a scratch
 * database of its own, created, migrated with the grants, and dropped per run
 * (`scratch-database.ts`, as `demo-seed.live` does). No worker is ever pointed
 * at it. The forced-plan case runs there too, in a transaction it rolls back.
 *
 * Moved here from `channel/drain-outbox/tests/` for that reason: `test/` is
 * outside the boundary rules, so it can use the scratch helper.
 *
 * Oracle: owner rulings 2026-09-25 (PR 1 of the batch) + whatsapp-channel's
 *   outbox — a queued message is claimed by one drain and sent once.
 *
 * Cases
 *   1. Two claims race for one row. The first holds its claim open while the
 *      second runs. The old claim (`WHERE id = (SELECT … LIMIT 1)`, no lock,
 *      status only inside the subquery) made the second wait, then claim the
 *      same row again once the first committed. With FOR UPDATE SKIP LOCKED and
 *      the outer status check, the second skips it. Mutation-checked: the old
 *      SQL fails this case.
 *   2. The forced plan. Forcing a generic plan with no material, hash or merge
 *      join, hash aggregate or sort puts the LIMIT subquery on the inner side of
 *      a nested-loop semi join, rescanned per outer row. A positive control first shows the plain
 *      `IN (SELECT … LIMIT 1 FOR UPDATE SKIP LOCKED)` claims more than one row
 *      under it (so the forcing bites); then `claimQueued` under the same plan
 *      claims exactly one. Mutation-checked: the IN form fails this case.
 *
 * Fixture rows are dated 2001, so they are the oldest queued rows in the table
 * and the oldest-first claim reaches them first.
 */
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { shouldRunLiveTests } from "@select-lub/core/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type DbClient } from "../src/kernel/db.js";
import { claimQueued, type ClaimedOutbox } from "../src/modules/channel/drain-outbox/index.js";
import {
  runInTransactionOnTx,
  seedConnection,
  seedConversation,
  seedUnit,
  withConnectRetry,
  withTestTransaction,
} from "../src/testing/index.js";
import { createScratchDatabase, type ScratchDatabase } from "./scratch-database.js";

const hasDatabase = shouldRunLiveTests();
const repoRoot = resolve(import.meta.dirname, "../../..");

/** Creating and migrating the scratch, or dropping it. */
const SCRATCH_SETUP_TIMEOUT_MS = 180_000;

class Rollback extends Error {}

/** A unit, connection and conversation on `client`; committed when `client` is. */
async function thread(client: DbClient, chatKey: string) {
  const unit = await seedUnit(client);
  const connection = await seedConnection(client, { unitId: unit.id });
  const conversation = await seedConversation(client, {
    connectionId: connection.id,
    chatKey,
    remoteJid: `${chatKey}@s.whatsapp.net`,
  });
  return { unitId: unit.id, connectionId: connection.id, conversationId: conversation.id };
}

/** One queued text row dated `createdAt`, older than anything real. */
async function queued(client: DbClient, conversationId: string, createdAt: Date): Promise<string> {
  const row = await client.outboxMessage.create({
    data: { conversationId, messageType: "text", textBody: "oi", status: "queued", createdAt },
    select: { id: true },
  });
  return row.id;
}

describe.skipIf(!hasDatabase)("drain-outbox claim — live, on a scratch database", () => {
  let scratch: ScratchDatabase | undefined;
  let prisma!: PrismaClient;

  beforeAll(async () => {
    scratch = await createScratchDatabase(process.env.DATABASE_URL ?? "", "outbox_claim_race", repoRoot);
    prisma = withConnectRetry(new PrismaClient({ datasourceUrl: scratch.url }));
  }, SCRATCH_SETUP_TIMEOUT_MS);

  // Runs whether the cases passed or failed; the whole database goes, so there
  // is no fixture to delete row by row.
  afterAll(async () => {
    try {
      await prisma?.$disconnect();
    } finally {
      await scratch?.drop();
    }
  }, SCRATCH_SETUP_TIMEOUT_MS);

  it("never lets a second drain claim the row the first one holds", async () => {
    const fixture = await thread(prisma, "5511900000001");
    const rowId = await queued(prisma, fixture.conversationId, new Date("2001-01-01T00:00:00.000Z"));

    let firstClaimed!: (claim: ClaimedOutbox | null) => void;
    const firstClaim = new Promise<ClaimedOutbox | null>((done) => (firstClaimed = done));
    let releaseFirst!: () => void;
    const firstHolds = new Promise<void>((done) => (releaseFirst = done));

    // The first drain claims and holds its transaction open, row lock and all.
    const first = prisma.$transaction(
      async (tx) => {
        firstClaimed(await claimQueued(createDb(tx, runInTransactionOnTx(tx))));
        await firstHolds;
      },
      { timeout: 60_000, maxWait: 30_000 },
    );
    let second: ClaimedOutbox | null = null;
    let secondRun: Promise<void> | undefined;
    try {
      expect((await firstClaim)?.id).toBe(rowId); // precondition: the fixture row is the oldest

      // The second drain, on another connection, while the first still holds.
      secondRun = prisma
        .$transaction(
          async (tx) => {
            second = await claimQueued(createDb(tx, runInTransactionOnTx(tx)));
            throw new Rollback();
          },
          { timeout: 60_000, maxWait: 30_000 },
        )
        .catch((error: unknown) => {
          if (!(error instanceof Rollback)) throw error;
        });
      // Long enough for the old claim to be parked on the row lock; the new one
      // does not wait at all.
      await Promise.race([secondRun, new Promise((done) => setTimeout(done, 1_000))]);
    } finally {
      // Always let the first commit, even when an assertion above threw, so no
      // transaction is left holding the row's lock.
      releaseFirst();
      await first;
      await secondRun;
    }

    expect((second as ClaimedOutbox | null)?.id).not.toBe(rowId);
    const row = await prisma.outboxMessage.findUniqueOrThrow({ where: { id: rowId } });
    expect(row.status).toBe("claimed");
  });

  it("claims exactly one row under the plan that makes a plain IN subquery over-claim", () =>
    withTestTransaction(prisma, async (tx) => {
      const { conversationId } = await thread(tx, "5511900000002");
      const ids: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        ids.push(await queued(tx, conversationId, new Date(Date.UTC(2001, 0, 1, 0, 0, i))));
      }
      // Force the rescanning plan; SET LOCAL lasts until the rollback.
      await tx.$executeRaw`SET LOCAL plan_cache_mode = force_generic_plan`;
      await tx.$executeRaw`SET LOCAL enable_material = off`;
      await tx.$executeRaw`SET LOCAL enable_hashjoin = off`;
      await tx.$executeRaw`SET LOCAL enable_mergejoin = off`;
      // Unlike erp's claim, this one's LIMIT 1 subquery is cheap to de-duplicate
      // and put on the OUTER side (HashAggregate, or Sort + Unique), which never
      // rescans it; these two take that path away.
      await tx.$executeRaw`SET LOCAL enable_hashagg = off`;
      await tx.$executeRaw`SET LOCAL enable_sort = off`;

      // Positive control: the plain IN form, under the same plan, takes more
      // than its LIMIT. Undone at once, so the real claim starts from 3 queued.
      await tx.$executeRaw`SAVEPOINT control`;
      const control = await tx.$queryRaw<{ id: string }[]>`
        UPDATE outbox_message SET status = 'claimed', claimed_at = NOW(), updated_at = NOW()
        WHERE id IN (
          SELECT id FROM outbox_message
          WHERE status = 'queued'
          ORDER BY created_at ASC
          LIMIT ${1}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id
      `;
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT control`;
      expect(control.length).toBeGreaterThan(1);

      const claimedBefore = await tx.outboxMessage.count({ where: { status: "claimed" } });
      const claim = await claimQueued(createDb(tx, runInTransactionOnTx(tx)));

      expect(claim?.id).toBe(ids[0]);
      const statuses = await Promise.all(
        ids.map(async (id) => (await tx.outboxMessage.findUniqueOrThrow({ where: { id } })).status),
      );
      expect(statuses).toEqual(["claimed", "queued", "queued"]);
      expect(await tx.outboxMessage.count({ where: { status: "claimed" } })).toBe(claimedBefore + 1);
    }));
});

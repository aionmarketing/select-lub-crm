/**
 * Test design (testing-strategy)
 *
 * Why here and not beside the other migration tests in `kernel/prisma/`: those
 * only read the SQL text, and a `kernel` file may not import the test harness.
 * `packages/core/test/` is outside the boundary rules.
 *
 * Setup: the migration's own SQL, read from disk and EXECUTED on fixture rows
 * inside one rolling-back transaction. It is a data fix, so the text alone
 * proves nothing; what matters is which rows it moves and which it leaves.
 *
 * Oracle: apply-owner-rulings-2026-09-25, PR 2 — an outbox row `blocked` behind
 *   a CANCELLED schedule becomes `cancelled`, with exactly the columns channel's
 *   `cancelOutbound` writes (`status`, and `updated_at`); nothing else moves.
 *
 * Axes
 *   A1 the schedule — CANCELLED / SCHEDULED / none (an attendant's send)
 *   A2 the outbox row — blocked / queued / claimed
 *
 * Outputs
 *   O1 status `cancelled`, `updated_at` = the statement's NOW(), `last_error`
 *      and the rest kept
 *   O2 untouched, `updated_at` included
 *
 * Sampled-cell
 *   CANCELLED + blocked   | A1 A2 | O1 | the stuck bubble left blocked
 *   SCHEDULED + blocked   | A1 A2 | O2 | a pending retry cancelled
 *   CANCELLED + queued    | A1 A2 | O2 | the fix widened past `blocked`
 *   CANCELLED + claimed   | A1 A2 | O2 | a row in flight rewritten
 *   no schedule + blocked | A1 A2 | O2 | an attendant's blocked send cancelled
 *   second run            | —     | O2 | not idempotent
 *
 * Out of scope: applying it through `prisma migrate deploy` (the root run's
 *   `db:migrate` does that on every test database).
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { prisma, type PrismaClient } from "@select-lub/core/db";
import { expect, it } from "vitest";
import type { DbClient } from "../src/kernel/db.js";
import {
  describeWithDatabase,
  seedConnection,
  seedConversation,
  seedUnit,
  seedUser,
  withTestTransaction,
} from "../src/testing/index.js";

const sql = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../prisma/migrations/20260925120000_cancel_blocked_outbox_of_cancelled_schedules/migration.sql",
  ),
  "utf8",
);

const CREATED = new Date("2026-09-01T12:00:00.000Z");

/** One outbox row, and a schedule on the same key unless `schedule` is null. */
async function pair(
  tx: DbClient,
  scope: { conversationId: string; userId: string },
  schedule: string | null,
  outbox: string,
) {
  const key = `mig-${randomUUID()}`;
  if (schedule) {
    await tx.scheduledMessage.create({
      data: {
        conversationId: scope.conversationId,
        frozenText: "Lembrete",
        scheduledAt: CREATED,
        status: schedule,
        idempotencyKey: key,
        createdByUserId: scope.userId,
      },
    });
  }
  const row = await tx.outboxMessage.create({
    data: {
      conversationId: scope.conversationId,
      textBody: "Lembrete",
      status: outbox,
      idempotencyKey: key,
      lastError: outbox === "blocked" ? "connection_disconnected" : null,
    },
    select: { id: true },
  });
  // Pin updated_at in SQL, so "untouched" is a value to compare, not a race
  // with the client clock.
  await tx.$executeRaw`UPDATE outbox_message SET updated_at = ${CREATED} WHERE id = ${row.id}`;
  return row.id;
}

function outboxOf(tx: DbClient, id: string) {
  return tx.outboxMessage.findUniqueOrThrow({
    where: { id },
    select: { status: true, updatedAt: true, lastError: true, textBody: true, attemptCount: true, claimedAt: true },
  });
}

describeWithDatabase("migration: cancel blocked outbox rows of cancelled schedules", () => {
  it("cancels only a blocked row behind a CANCELLED schedule, with cancelOutbound's columns, once", () =>
    withTestTransaction(prisma as PrismaClient, async (tx) => {
      const unit = await seedUnit(tx);
      const user = await seedUser(tx, { units: [unit.id] });
      const connection = await seedConnection(tx, { unitId: unit.id });
      const conversation = await seedConversation(tx, { connectionId: connection.id });
      const scope = { conversationId: conversation.id, userId: user.id };
      const stuck = await pair(tx, scope, "CANCELLED", "blocked");
      const untouched = [
        await pair(tx, scope, "SCHEDULED", "blocked"),
        await pair(tx, scope, "CANCELLED", "queued"),
        await pair(tx, scope, "CANCELLED", "claimed"),
        await pair(tx, scope, null, "blocked"),
      ];
      const before = new Map(await Promise.all(untouched.map(async (id) => [id, await outboxOf(tx, id)] as const)));
      const stuckBefore = await outboxOf(tx, stuck);

      await tx.$executeRawUnsafe(sql);

      const { updatedAt, ...rest } = await outboxOf(tx, stuck);
      expect(rest).toEqual({ ...stuckBefore, updatedAt: undefined, status: "cancelled" });
      expect(updatedAt).not.toEqual(stuckBefore.updatedAt);
      // Stamped with the statement's NOW(), compared in SQL: the column keeps
      // milliseconds and NOW() carries microseconds, so the cast is the same one
      // the assignment made.
      const [{ same }] = await tx.$queryRaw<{ same: boolean }[]>`
        SELECT updated_at = NOW()::timestamp(3) AS same FROM outbox_message WHERE id = ${stuck}
      `;
      expect(same).toBe(true);
      for (const id of untouched) {
        expect(await outboxOf(tx, id)).toEqual(before.get(id));
      }

      // Idempotent: a second run moves none of them again.
      const afterFirst = await outboxOf(tx, stuck);
      await tx.$executeRawUnsafe(sql);
      expect(await outboxOf(tx, stuck)).toEqual(afterFirst);
      for (const id of untouched) {
        expect(await outboxOf(tx, id)).toEqual(before.get(id));
      }
    }));
});

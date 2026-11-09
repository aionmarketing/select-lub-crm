/**
 * Test design (testing-strategy)
 *
 * SUT: what happens around a send that might have arrived, across channel and
 *   scheduling — channel's `reclaimStuck` and the drain's `markConfirmed`, and
 *   scheduling's `recoverStaleProcessing`, `syncOutboxOutcomes` and
 *   `dispatchDue` — on the real database inside one rolling-back transaction per
 *   case.
 *
 * Why here: it spans two modules; `test/` is outside the boundary rules.
 *
 * Oracle: `hold-unknown-outcome-sends`.
 *   - whatsapp-channel: the reclaim fails an expired claim as
 *     `send_outcome_unknown` and never requeues it; a send that returns an id
 *     afterwards is recorded `confirmed`.
 *   - scheduled-messages, "A scheduled message's send outcome reaches its
 *     schedule": the stale recovery leaves a `claimed` copy to the reclaim, and
 *     the schedule ends `FAILED`; a refused or unknown copy ends the schedule
 *     `FAILED` and nothing sends it again; a copy blocked while disconnected is
 *     still sent on reconnect.
 *
 * Cases
 *   0. a hung send through the real client is abandoned at its limit, and the
 *      drain still sends the row behind it (here, not in the drain's slice tests,
 *      because it needs channel's `internal/evolution.ts`)
 *   1. an expired claim is failed, and a late success then confirms it
 *   2. a claimed reminder copy past the stale threshold: the schedule stays
 *      PROCESSING, then FAILED once the reclaim and the sync have run
 *   3. a refused reminder copy ends the schedule FAILED; later ticks leave it
 *   4. positive control for 2: a copy blocked while disconnected IS reset and
 *      queued again on reconnect, so 2's skip is specific to `claimed`
 *
 * Dates are early 2026, as in the due tick's own tests: `dispatchDue` has no
 *   tenancy predicate, and nothing seeded is due that early.
 */
import { randomUUID } from "node:crypto";
import { prisma, type DbClient, type PrismaClient } from "@select-lub/core/db";
import { afterEach, expect, it, vi } from "vitest";
import { createDb } from "../src/kernel/db.js";
import { drainOutbox, markConfirmed } from "../src/modules/channel/drain-outbox/index.js";
import { createEvolutionSend } from "../src/modules/channel/internal/evolution.js";
import { reclaimStuck } from "../src/modules/channel/reclaim-stuck/index.js";
import { dispatchDue, PROCESSING_STALE_MS, recoverStaleProcessing } from "../src/modules/scheduling/run-due-tick/index.js";
import { syncOutboxOutcomes } from "../src/modules/scheduling/sync-scheduled/index.js";
import {
  describeWithDatabase,
  runInTransactionOnTx,
  seedConnection,
  seedConversation,
  seedUnit,
  seedUser,
  withTestTransaction,
} from "../src/testing/index.js";

const db = () => prisma as PrismaClient;
const TIMEOUT_MS = 180_000;
const DUE = new Date("2026-01-01T12:00:00.000Z");

function handle(tx: DbClient) {
  return createDb(tx, runInTransactionOnTx(tx));
}

async function databaseNow(tx: DbClient): Promise<Date> {
  const rows = await tx.$queryRaw<{ now: Date }[]>`SELECT NOW() AS now`;
  return rows[0]!.now;
}

/** A PROCESSING schedule on a connected thread, and its outbox copy in `copy`. */
async function scheduleWithCopy(
  tx: DbClient,
  copy: { status: "claimed" | "queued" | "blocked"; claimedAt?: Date; lastError?: string },
) {
  const unit = await seedUnit(tx);
  const user = await seedUser(tx, { units: [unit.id] });
  const connection = await seedConnection(tx, { unitId: unit.id, connectionState: "CONNECTED" });
  const conversation = await seedConversation(tx, { connectionId: connection.id });
  const key = `hold-${randomUUID()}`;
  const schedule = await tx.scheduledMessage.create({
    data: {
      conversationId: conversation.id,
      frozenText: "Lembrete",
      scheduledAt: DUE,
      status: "PROCESSING",
      idempotencyKey: key,
      createdByUserId: user.id,
    },
  });
  const outbox = await tx.outboxMessage.create({
    data: {
      conversationId: conversation.id,
      textBody: "Lembrete",
      status: copy.status,
      idempotencyKey: key,
      ...(copy.claimedAt ? { claimedAt: copy.claimedAt } : {}),
      ...(copy.lastError ? { lastError: copy.lastError } : {}),
    },
  });
  return { scheduleId: schedule.id, copyId: outbox.id, conversationId: conversation.id };
}

/** A `now` past the stale threshold for a row last written at `updatedAt`. */
function pastStale(updatedAt: Date): Date {
  return new Date(updatedAt.getTime() + PROCESSING_STALE_MS + 1_000);
}

function copyOf(tx: DbClient, id: string) {
  return tx.outboxMessage.findUniqueOrThrow({ where: { id }, select: { status: true, lastError: true, updatedAt: true } });
}

function scheduleOf(tx: DbClient, id: string) {
  return tx.scheduledMessage.findUniqueOrThrow({ where: { id }, select: { status: true, lastError: true } });
}

describeWithDatabase("a send that might have arrived", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("abandons a hung send at its limit and still sends the row behind it", () =>
    withTestTransaction(db(), async (tx) => {
      const unit = await seedUnit(tx);
      const connection = await seedConnection(tx, { unitId: unit.id });
      const conversation = await seedConversation(tx, { connectionId: connection.id });
      const queue = (textBody: string) =>
        tx.outboxMessage.create({ data: { conversationId: conversation.id, textBody, status: "queued" } });
      const hung = await queue("primeira");
      const next = await queue("segunda");
      vi.stubGlobal(
        "fetch",
        vi.fn((_url: string, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body)) as { text: string };
          if (body.text === "primeira") {
            // Never answers; only the signal ends it.
            return new Promise((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
            });
          }
          return Promise.resolve({ ok: true, status: 201, json: async () => ({ key: { id: "evo-2" } }) });
        }),
      );
      const evolution = createEvolutionSend({ baseUrl: "http://evo.test", apiKey: "k", textTimeoutMs: 50 });

      await drainOutbox({ db: handle(tx), evolution });

      expect(await copyOf(tx, hung.id)).toMatchObject({ status: "failed", lastError: "send_outcome_unknown" });
      expect((await copyOf(tx, next.id)).status).toBe("confirmed");
    }));

  it("fails an expired claim, and confirms it when the send later returns an id", () =>
    withTestTransaction(db(), async (tx) => {
      const now = await databaseNow(tx);
      const r = await scheduleWithCopy(tx, { status: "claimed", claimedAt: new Date(now.getTime() - (TIMEOUT_MS + 1)) });

      expect(await reclaimStuck(handle(tx), TIMEOUT_MS)).toBeGreaterThanOrEqual(1);
      expect(await copyOf(tx, r.copyId)).toMatchObject({ status: "failed", lastError: "send_outcome_unknown" });

      await markConfirmed(handle(tx), r.copyId, "evo-late");
      expect((await copyOf(tx, r.copyId)).status).toBe("confirmed");
    }));

  it("leaves a long-claimed reminder copy to the reclaim, and then fails the schedule", () =>
    withTestTransaction(db(), async (tx) => {
      const now = await databaseNow(tx);
      const r = await scheduleWithCopy(tx, { status: "claimed", claimedAt: new Date(now.getTime() - (TIMEOUT_MS + 1)) });
      const { updatedAt } = await copyOf(tx, r.copyId);

      await recoverStaleProcessing(handle(tx), pastStale(updatedAt), PROCESSING_STALE_MS);
      expect((await scheduleOf(tx, r.scheduleId)).status).toBe("PROCESSING");

      await reclaimStuck(handle(tx), TIMEOUT_MS);
      await syncOutboxOutcomes(handle(tx));
      expect(await scheduleOf(tx, r.scheduleId)).toMatchObject({ status: "FAILED", lastError: "send_outcome_unknown" });

      // Nothing sends it again: the recovery and the due tick both leave it.
      await recoverStaleProcessing(handle(tx), pastStale(updatedAt), PROCESSING_STALE_MS);
      await dispatchDue(handle(tx), DUE);
      expect((await scheduleOf(tx, r.scheduleId)).status).toBe("FAILED");
      expect((await copyOf(tx, r.copyId)).status).toBe("failed");
    }));

  it("ends a refused reminder FAILED, and no later tick queues it again", () =>
    withTestTransaction(db(), async (tx) => {
      const r = await scheduleWithCopy(tx, { status: "queued" });
      // The drain's refusal write, as markFailedNow records it.
      await tx.outboxMessage.update({
        where: { id: r.copyId },
        data: { status: "failed", lastError: "send_refused_not_on_whatsapp", attemptCount: 1 },
      });

      await syncOutboxOutcomes(handle(tx));
      expect(await scheduleOf(tx, r.scheduleId)).toMatchObject({ status: "FAILED", lastError: "send_refused_not_on_whatsapp" });

      const { updatedAt } = await copyOf(tx, r.copyId);
      await recoverStaleProcessing(handle(tx), pastStale(updatedAt), PROCESSING_STALE_MS);
      await dispatchDue(handle(tx), DUE);
      expect((await copyOf(tx, r.copyId)).status).toBe("failed");
      expect((await scheduleOf(tx, r.scheduleId)).status).toBe("FAILED");
    }));

  it("still queues a reminder copy that was blocked while disconnected, once reconnected", () =>
    withTestTransaction(db(), async (tx) => {
      const r = await scheduleWithCopy(tx, { status: "blocked", lastError: "connection_disconnected" });
      const { updatedAt } = await copyOf(tx, r.copyId);

      await recoverStaleProcessing(handle(tx), pastStale(updatedAt), PROCESSING_STALE_MS);
      expect((await scheduleOf(tx, r.scheduleId)).status).toBe("SCHEDULED");

      await dispatchDue(handle(tx), DUE);
      expect((await scheduleOf(tx, r.scheduleId)).status).toBe("PROCESSING");
      expect(await copyOf(tx, r.copyId)).toMatchObject({ status: "queued", lastError: null });
    }));
});

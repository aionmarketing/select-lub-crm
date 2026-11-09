/**
 * Test design (testing-strategy) — scheduling's due tick with channel's drain
 *
 * WHY THIS FILE IS IN apps/worker AND NOT IN A SLICE
 *   Both cases run a due tick, then channel's `drainOnce`, then the outcome
 *   sync — two modules' jobs in the order the worker drives them. A slice's
 *   tests may not import another module's jobs, so they run here, where the two
 *   are composed, beside `channel-wiring.test.ts`.
 *
 * Moved from `apps/worker/src/scheduled/due.test.ts`, two cases, assertions
 *   unchanged: "maps a confirmed outbox onto SENT and does not send twice" and
 *   "does not re-block a confirmed row when a later due tick reads the channel
 *   down". Its four due-tick-only cases moved to scheduling's `run-due-tick`
 *   slice. The schedule's store is now scheduling's `createScheduledDue(db)` on
 *   a handle over the test transaction; the drain is channel's, as before.
 *
 * Setup: one due schedule on a conversation, inside one rolling-back
 *   transaction per test. No Evolution HTTP — the `sendText` stub records calls.
 *
 * Oracle: scheduled-messages due dispatch (AC-CONV-07, AC-CH-05/07) — confirmed
 *   maps to SENT; a second drain after the provider id is stored does not send
 *   again; channel's compare-and-set keeps a confirmed row confirmed.
 *
 * outbox-404-marks-disconnected adds three cases: a 404 send over three stale
 *   windows (once a loop with no end: one call per cycle), the heartbeat
 *   reconcile storing a 404 as DISCONNECTED through the real client, and the release of
 *   that held reminder by a reconcile reading `open`. The reconcile is channel's
 *   own function, driven here because the release crosses into scheduling.
 *
 * Sampled-cell
 *   second drain after provider  | two ticks, confirmed        | sendText once, SENT | sendText 2
 *   confirmed, then channel down | confirmed, re-opened, down  | still confirmed     | re-blocked and resent
 *   404 send, three stale cycles | stored CONNECTED, 404       | 1 call, blocked     | 3 calls (the loop)
 *   404 held, reconcile gets 404 | CONNECTED written back;     | route 404: CONNECTED| flipped by a route 404
 *                                | route 404, then guard 404   | guard: DISCONN, 1 cl| skipped, re-sent
 *   404 held, then reconcile open| blocked, reconnect observed | 1 send, SENT        | 0 sends, or 2
 */
import { randomUUID } from "node:crypto";
import { prisma, type DbClient, type PrismaClient } from "@select-lub/core/db";
import {
  describeWithDatabase,
  runInTransactionOnTx,
  seedConnection,
  seedConversation,
  seedUnit,
  seedUser,
  withTestTransaction,
} from "@select-lub/core/testing";
import { expect, it, vi } from "vitest";
import { kernel } from "@select-lub/core";
import * as channelModule from "@select-lub/core/modules/channel";
import { drainOnce, type EvolutionSend } from "@select-lub/core/modules/channel";
import { createScheduledDue, runDueTick, syncScheduled } from "@select-lub/core/modules/scheduling";

const PHONE = "5511999999999";
const SCHEDULED_AT = new Date("2026-01-01T00:00:00.000Z");
const FIRST_TICK = new Date("2026-01-02T00:00:00.000Z");
const SECOND_TICK = new Date("2026-01-02T00:00:01.000Z");
const FROZEN_TEXT = "Retorno em seis meses";

const db = () => prisma as PrismaClient;

/**
 * An `EvolutionSend` whose `sendText` always succeeds and records its input.
 *
 * @param calls - Sink the send inputs are pushed onto.
 * @returns The stub.
 */
function stubSend(calls: unknown[]): EvolutionSend {
  const unused = async () => ({ ok: false as const, kind: "refused" as const, error: "unused" });
  return {
    async sendText(input) {
      calls.push(input);
      return {
        ok: true,
        externalMessageId: "prov-1",
        providerTimestamp: new Date("2026-01-02T00:00:00.000Z"),
      };
    },
    sendWhatsAppAudio: unused,
    sendMedia: unused,
    async getBase64FromMediaMessage() {
      return { ok: false, disconnected: false, error: "unused" };
    },
  };
}

/** A unit, user, CONNECTED connection, conversation and one due schedule, with the two handles. */
async function seedDue(tx: DbClient) {
  const unit = await seedUnit(tx);
  const user = await seedUser(tx, { units: [unit.id] });
  const connection = await seedConnection(tx, { unitId: unit.id, connectionState: "CONNECTED" });
  const conversation = await seedConversation(tx, { connectionId: connection.id, chatKey: PHONE });
  const idempotencyKey = `sched-key-${randomUUID()}`;
  await tx.scheduledMessage.create({
    data: {
      conversationId: conversation.id,
      frozenText: FROZEN_TEXT,
      scheduledAt: SCHEDULED_AT,
      status: "SCHEDULED",
      idempotencyKey,
      createdByUserId: user.id,
    },
  });
  const handle = kernel.createDb(tx, runInTransactionOnTx(tx));
  return {
    conversationId: conversation.id,
    idempotencyKey,
    scheduled: createScheduledDue(handle),
    // The drain reads through this handle. Nothing here subscribes to its
    // outbound-sent event, and no assertion reads the canonical message.
    channel: handle,
  };
}

function outboxOf(tx: DbClient, idempotencyKey: string) {
  return tx.outboxMessage.findUnique({ where: { idempotencyKey } });
}

function scheduleOf(tx: DbClient, idempotencyKey: string) {
  return tx.scheduledMessage.findUniqueOrThrow({ where: { idempotencyKey } });
}

async function connectionOf(tx: DbClient, conversationId: string) {
  const { whatsappConnection } = await tx.conversation.findUniqueOrThrow({
    where: { id: conversationId },
    select: { whatsappConnection: true },
  });
  return whatsappConnection;
}

/**
 * Past the 5-minute `PROCESSING_STALE_MS`. `updated_at` is Prisma's
 * `@updatedAt`, stamped from the JS clock, so ticks are real time plus whole
 * stale windows rather than fixed dates.
 */
const CYCLE_MS = 6 * 60 * 1000;

/**
 * An `EvolutionSend` whose `sendText` answers as a 404 does (the instance does
 * not exist) and records its input.
 *
 * @param calls - Sink the send inputs are pushed onto.
 * @returns The stub.
 */
function evolution404(calls: unknown[]): EvolutionSend {
  const unused = async () => ({ ok: false as const, kind: "refused" as const, error: "unused" });
  return {
    async sendText(input) {
      calls.push(input);
      return { ok: false, kind: "disconnected", error: "evolution 404" };
    },
    sendWhatsAppAudio: unused,
    sendMedia: unused,
    async getBase64FromMediaMessage() {
      return { ok: false, disconnected: false, error: "unused" };
    },
  };
}

/** One worker cycle, in the worker's order: due tick, one drain, the sync. */
async function runCycle(
  scheduled: ReturnType<typeof createScheduledDue>,
  channel: ReturnType<typeof kernel.createDb>,
  evolution: EvolutionSend,
  now: Date,
) {
  await runDueTick(scheduled, now);
  await drainOnce({ db: channel, evolution });
  await syncScheduled(scheduled);
}

describeWithDatabase("scheduled due tick with the outbox drain", () => {
  it("maps a confirmed outbox onto SENT and does not send twice", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversationId, idempotencyKey, scheduled, channel } = await seedDue(tx);
      const calls: unknown[] = [];
      const evolution = stubSend(calls);

      await runDueTick(scheduled, FIRST_TICK);
      await drainOnce({ db: channel, evolution });
      await syncScheduled(scheduled);
      await runDueTick(scheduled, SECOND_TICK);
      await drainOnce({ db: channel, evolution });
      await syncScheduled(scheduled);

      expect(calls).toHaveLength(1);
      expect(await tx.outboxMessage.count({ where: { conversationId } })).toBe(1);
      const row = await outboxOf(tx, idempotencyKey);
      expect(row?.status).toBe("confirmed");
      expect(row?.externalMessageId).toBe("prov-1");
      expect((await scheduleOf(tx, idempotencyKey)).status).toBe("SENT");
    }));

  it("does not re-block a confirmed row when a later due tick reads the channel down", () =>
    withTestTransaction(db(), async (tx) => {
      // The caller's side of the compare-and-set in channel's enqueueOutbound
      // (3A.2, ruling Q1-A). With the due tick and the drain as separate jobs, a
      // due tick can find a row the drain has already confirmed. It used to
      // write `blocked` over it by id, and on reconnect flip it to `queued` and
      // send it again. The row must stay exactly as the drain left it.
      const { conversationId, idempotencyKey, scheduled, channel } = await seedDue(tx);
      const calls: unknown[] = [];

      await runDueTick(scheduled, FIRST_TICK);
      await drainOnce({ db: channel, evolution: stubSend(calls) });
      const confirmed = await outboxOf(tx, idempotencyKey);
      expect(confirmed?.status).toBe("confirmed"); // precondition
      // The schedule is still PROCESSING (no sync yet), so re-open it for a tick
      // that reads the channel down, as a retried tick would.
      await tx.scheduledMessage.updateMany({ where: { idempotencyKey }, data: { status: "SCHEDULED" } });
      const { whatsappConnectionId } = await tx.conversation.findUniqueOrThrow({ where: { id: conversationId } });
      await tx.whatsAppConnection.update({
        where: { id: whatsappConnectionId },
        data: { connectionState: "DISCONNECTED" },
      });

      await runDueTick(scheduled, SECOND_TICK);

      const after = await outboxOf(tx, idempotencyKey);
      expect(after?.status).toBe("confirmed");
      expect(after?.lastError).toBeNull();
      expect(after?.externalMessageId).toBe(confirmed?.externalMessageId);
      expect(calls).toHaveLength(1);
    }));

  it("does not keep re-sending a reminder Evolution answers 404 while the stored state says CONNECTED", () =>
    withTestTransaction(db(), async (tx) => {
      // The production loop seen 2026-10-08 on demo-conv-01 (worker 725ec1e7):
      // `outbox claimed` then `outbox blocked`, every ~5.5 min, without end.
      //
      // The drain's 404 ("instance does not exist") blocked the copy, but the due
      // tick decides from the STORED column, which kept saying CONNECTED. So after
      // each 5-minute stale threshold the schedule returned to SCHEDULED, the next
      // due tick unblocked the copy, and the drain called Evolution again. Before
      // outbox-404-marks-disconnected this test saw 3 calls in 3 cycles.
      //
      // Oracle: whatsapp-channel (outbox-404-marks-disconnected) "A reminder
      // blocked by a 404 is not sent again while nothing reconnects" — the item
      // stays blocked and Evolution is called once in total.
      const { conversationId, idempotencyKey, scheduled, channel } = await seedDue(tx);
      const calls: unknown[] = [];

      const start = Date.now();
      for (let cycle = 0; cycle < 3; cycle++) {
        await runCycle(scheduled, channel, evolution404(calls), new Date(start + cycle * CYCLE_MS));
      }

      const row = await outboxOf(tx, idempotencyKey);
      expect(row?.status).toBe("blocked");
      expect(calls).toHaveLength(1);
      const connection = await connectionOf(tx, conversationId);
      expect(connection.connectionState).toBe("DISCONNECTED");
      expect((await scheduleOf(tx, idempotencyKey)).status).not.toBe("SENT");
    }));

  it("keeps a held reminder held when the heartbeat reconcile learns the instance does not exist", () =>
    withTestTransaction(db(), async (tx) => {
      // Oracle: whatsapp-channel "A missing instance is stored as disconnected".
      // Through the real `createEvolutionConnectionState`, so the HTTP status
      // decides, not a hand-built result. Something writes CONNECTED back over
      // the 404's DISCONNECTED; the demo seed does exactly that on every run.
      // The reconcile must put it right, and no further send may follow. Before
      // outbox-404-marks-disconnected, the client turned a 404 into `{ ok: false }`
      // and the reconcile skipped it. Every other instance answers 500, so no
      // shared row is written inside this transaction.
      //
      // Review of #207: only the instance guard's 404 counts. A first reconcile
      // gets Express's unknown-route 404 and must leave CONNECTED alone (whatsapp-
      // channel "Failed GET leaves stored state"); the second gets the guard's.
      const { conversationId, idempotencyKey, scheduled, channel } = await seedDue(tx);
      const calls: unknown[] = [];
      const start = Date.now();
      await runCycle(scheduled, channel, evolution404(calls), new Date(start));
      const { whatsappConnectionId } = await tx.conversation.findUniqueOrThrow({ where: { id: conversationId } });
      const mine = await tx.whatsAppConnection.update({
        where: { id: whatsappConnectionId },
        data: { connectionState: "CONNECTED", stateObservedAt: null },
      });
      let notFoundMessage = "Cannot GET /instance/connectionState/x";
      const fetchImpl = vi.fn(async (url: string) => {
        const status = url.endsWith(`/${encodeURIComponent(mine.instanceName)}`) ? 404 : 500;
        return {
          ok: false,
          status,
          json: async () => ({ status, error: "Not Found", response: { message: [notFoundMessage] } }),
        };
      });
      const client = channelModule.createEvolutionConnectionState({ baseUrl: "http://evo.test", apiKey: "k", fetchImpl });

      await channelModule.reconcileConnection(channel, client, () => new Date());
      expect((await connectionOf(tx, conversationId)).connectionState).toBe("CONNECTED");

      notFoundMessage = `The "${mine.instanceName}" instance does not exist`;
      const probeStart = new Date();
      await channelModule.reconcileConnection(channel, client, () => probeStart);

      const connection = await connectionOf(tx, conversationId);
      expect(connection.connectionState).toBe("DISCONNECTED");
      expect(connection.lastDisconnectedAt).toEqual(probeStart);
      for (let cycle = 1; cycle < 3; cycle++) {
        await runCycle(scheduled, channel, evolution404(calls), new Date(start + cycle * CYCLE_MS));
      }
      expect(calls).toHaveLength(1);
      expect((await outboxOf(tx, idempotencyKey))?.status).toBe("blocked");
    }));

  it("releases the held reminder exactly once when a reconcile reads the instance open again", () =>
    withTestTransaction(db(), async (tx) => {
      // Oracle: whatsapp-channel "A reconnect releases the held reminder once",
      // and scheduled-messages "A reminder blocked while disconnected is still
      // sent on reconnect": same item, same key, one send, then SENT.
      const { conversationId, idempotencyKey, scheduled, channel } = await seedDue(tx);
      const blockedCalls: unknown[] = [];
      const sentCalls: unknown[] = [];
      const start = Date.now();
      await runCycle(scheduled, channel, evolution404(blockedCalls), new Date(start));
      await runCycle(scheduled, channel, evolution404(blockedCalls), new Date(start + CYCLE_MS));
      const held = await outboxOf(tx, idempotencyKey);
      expect(held?.status).toBe("blocked"); // precondition
      expect(blockedCalls).toHaveLength(1); // precondition

      // The instance is re-paired: the heartbeat's reconcile reads `open`. Only
      // this test's connection answers; every other row in the table is left
      // alone, so no shared row is written inside this transaction.
      const { whatsappConnectionId } = await tx.conversation.findUniqueOrThrow({ where: { id: conversationId } });
      const mine = await tx.whatsAppConnection.findUniqueOrThrow({ where: { id: whatsappConnectionId } });
      await channelModule.reconcileConnection(channel, {
        async getConnectionState(name) {
          return name === mine.instanceName ? { ok: true, evolutionState: "CONNECTED" } : { ok: false };
        },
      });
      expect((await connectionOf(tx, conversationId)).connectionState).toBe("CONNECTED"); // precondition

      for (let cycle = 2; cycle < 5; cycle++) {
        await runCycle(scheduled, channel, stubSend(sentCalls), new Date(start + cycle * CYCLE_MS));
      }

      expect(sentCalls).toHaveLength(1);
      const row = await outboxOf(tx, idempotencyKey);
      expect(row?.id).toBe(held?.id);
      expect(row?.status).toBe("confirmed");
      expect(await tx.outboxMessage.count({ where: { conversationId } })).toBe(1);
      expect((await scheduleOf(tx, idempotencyKey)).status).toBe("SENT");
    }));
});

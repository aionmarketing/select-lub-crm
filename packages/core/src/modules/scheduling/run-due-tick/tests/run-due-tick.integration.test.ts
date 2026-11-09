/**
 * Test design (testing-strategy) — scheduling / run-due-tick
 *
 * Module role: `module_scheduling` for every `scheduled_message` read and write;
 * each due row's outbox row is written by channel's `enqueueOutbound`, whose
 * `db.tx("channel", …)` joins the row's transaction.
 *
 * Moved from `apps/worker/src/scheduled/due.test.ts`, assertions unchanged: its
 * four cases that drive only the due tick (the orphan row, two ticks one outbox,
 * the disconnected block, the frozen text). Its two cases that also drive
 * channel's `drainOnce` moved to `apps/worker/test/scheduling-wiring.test.ts`: a
 * slice's tests may not import another module's jobs.
 *
 * New here: `recoverStaleProcessing`, which the old file never exercised.
 *
 * Setup: the slice's `recoverStaleProcessing` and `dispatchDue` on
 * `createDb(tx, runInTransactionOnTx(tx))`, driven through `runDueTick` exactly
 * as the job drives them, inside one rolling-back transaction per test. No
 * Evolution call: the due tick never sends.
 *
 * Oracle: scheduled-messages due dispatch (AC-CONV-07, AC-CH-05/07) — two ticks
 *   one outbox; a disconnected due blocks and is not SENT; a connected due
 *   queues the frozen text.
 *
 * FAKE-ONLY ASSERTIONS SURFACED (carried over)
 *   1. `dispatchDue` has no tenancy predicate, so every assertion reads the row
 *      this test made — by its `idempotencyKey`, or a count scoped to its
 *      conversation (D9) — never position zero of a list. The conversation-less
 *      rule is pinned on a row THIS test creates, not the demo seed's.
 *   2. The template assertion can fail: the schedule carries a template, and the
 *      queued `textBody` is the frozen text regardless.
 *   3. Every schedule has a real author: `created_by_user_id` is a foreign key.
 *
 * Axes
 *   A1 tick count — one / two
 *   A2 connection (the STORED column) — CONNECTED / DISCONNECTED
 *   A3 a PROCESSING row's outbox — none (recover)
 *
 * Outputs
 *   O1 one outbox row; O2 blocked + SCHEDULED; O5 queued frozen text + PROCESSING;
 *   O6 a PROCESSING row with no outbox row back to SCHEDULED
 *
 * Sampled-cell
 *   conversation-less due        | —            | untouched | an outbox row with no destination
 *   two due ticks one outbox     | A1 two A2 on | O1 | two rows
 *   disconnected due not SENT    | A2 off       | O2 | queued / PROCESSING
 *   connected due frozen text    | A2 on        | O5 | template re-rendered
 *   PROCESSING with no outbox    | A3 none      | O6 | stuck PROCESSING forever
 *
 * Decision map (run-due-tick)
 *   status = SCHEDULED && due && conversation  T due its; F the orphan it
 *   claim compare-and-set                      T first tick; F second tick
 *   connection CONNECTED (stored column)       T connected its; F disconnected it
 *   recover: no outbox row                     T recover it; F not sampled here
 *
 * Out of scope: the send and the outcome sync (scheduling-wiring.test.ts,
 *   sync-scheduled); the API routes that create schedules.
 */
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { prisma, type PrismaClient } from "@select-lub/core/db";
import { createDb, type DbClient } from "../../../../kernel/db.js";
import {
  describeWithDatabase,
  runInTransactionOnTx,
  seedConnection,
  seedConversation,
  seedUnit,
  seedUser,
  withTestTransaction,
} from "@select-lub/core/testing";
import { CONNECTION_DISCONNECTED, dispatchDue, recoverStaleProcessing, runDueTick } from "../index.js";

const PHONE = "5511999999999";
const SCHEDULED_AT = new Date("2026-01-01T00:00:00.000Z");
const FIRST_TICK = new Date("2026-01-02T00:00:00.000Z");
const SECOND_TICK = new Date("2026-01-02T00:00:01.000Z");
const FROZEN_TEXT = "Retorno em seis meses";

const db = () => prisma as PrismaClient;

/** The due-tick port over this transaction, as the module builds it; no sync step. */
function dueOn(tx: DbClient) {
  const handle = createDb(tx, runInTransactionOnTx(tx));
  return {
    recoverStaleProcessing: (now: Date, staleMs: number) => recoverStaleProcessing(handle, now, staleMs),
    dispatchDue: (now: Date) => dispatchDue(handle, now),
    syncOutboxOutcomes: async () => undefined,
  };
}

/** A unit, user, connection, conversation and one due schedule. */
async function seedDue(
  tx: DbClient,
  state: "CONNECTED" | "DISCONNECTED",
  options: { withTemplate?: boolean } = {},
) {
  const unit = await seedUnit(tx);
  const user = await seedUser(tx, { units: [unit.id] });
  const connection = await seedConnection(tx, { unitId: unit.id, connectionState: state });
  const conversation = await seedConversation(tx, { connectionId: connection.id, chatKey: PHONE });
  const idempotencyKey = `sched-key-${randomUUID()}`;
  const templateId = options.withTemplate
    ? (
        await tx.template.create({
          data: { unitId: unit.id, name: `t-${randomUUID().slice(0, 8)}`, text: "NOT the frozen text", allowedVariables: [] },
          select: { id: true },
        })
      ).id
    : null;
  await tx.scheduledMessage.create({
    data: {
      conversationId: conversation.id,
      frozenText: FROZEN_TEXT,
      scheduledAt: SCHEDULED_AT,
      status: "SCHEDULED",
      idempotencyKey,
      createdByUserId: user.id,
      ...(templateId ? { templateId } : {}),
    },
  });
  return { conversationId: conversation.id, unitId: unit.id, userId: user.id, idempotencyKey };
}

function outboxOf(tx: DbClient, idempotencyKey: string) {
  return tx.outboxMessage.findUnique({ where: { idempotencyKey } });
}

function scheduleOf(tx: DbClient, idempotencyKey: string) {
  return tx.scheduledMessage.findUniqueOrThrow({ where: { idempotencyKey } });
}

describeWithDatabase("scheduled due dispatch", () => {
  it("leaves a due schedule with no conversation alone", () =>
    withTestTransaction(db(), async (tx) => {
      // dispatchDue has no tenancy predicate, so the only thing keeping a
      // conversation-less row out is `conversationId: { not: null }`. This test
      // seeds its own such row rather than relying on the demo seed's.
      const { unitId, userId } = await seedDue(tx, "CONNECTED");
      const orphanKey = `sched-orphan-${randomUUID()}`;
      await tx.scheduledMessage.create({
        data: {
          conversationId: null,
          frozenText: FROZEN_TEXT,
          scheduledAt: SCHEDULED_AT,
          status: "SCHEDULED",
          idempotencyKey: orphanKey,
          createdByUserId: userId,
        },
      });
      expect(unitId).toBeTruthy(); // precondition: the unit really exists

      await runDueTick(dueOn(tx), FIRST_TICK);

      expect(await outboxOf(tx, orphanKey)).toBeNull();
      expect((await scheduleOf(tx, orphanKey)).status).toBe("SCHEDULED");
      expect((await scheduleOf(tx, orphanKey)).lastError).toBeNull();
    }));

  it("creates one outbox row across two due ticks", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversationId, idempotencyKey } = await seedDue(tx, "CONNECTED");

      await runDueTick(dueOn(tx), FIRST_TICK);
      await runDueTick(dueOn(tx), SECOND_TICK);

      expect(await tx.outboxMessage.count({ where: { conversationId } })).toBe(1);
      const row = await outboxOf(tx, idempotencyKey);
      expect(row?.textBody).toBe(FROZEN_TEXT);
      expect(row?.messageType).toBe("text");
    }));

  it("blocks a disconnected due and does not mark the schedule SENT", () =>
    withTestTransaction(db(), async (tx) => {
      const { idempotencyKey } = await seedDue(tx, "DISCONNECTED");

      await runDueTick(dueOn(tx), FIRST_TICK);

      const row = await outboxOf(tx, idempotencyKey);
      expect(row?.status).toBe("blocked");
      expect(row?.lastError).toBe(CONNECTION_DISCONNECTED);
      const schedule = await scheduleOf(tx, idempotencyKey);
      expect(schedule.status).toBe("SCHEDULED");
      expect(schedule.lastError).toBe(CONNECTION_DISCONNECTED);
    }));

  it("enqueues the schedule's frozen text, not its template body, when CONNECTED", () =>
    withTestTransaction(db(), async (tx) => {
      const { idempotencyKey } = await seedDue(tx, "CONNECTED", { withTemplate: true });
      const before = await scheduleOf(tx, idempotencyKey);
      expect(before.templateId).not.toBeNull(); // precondition: a template is attached

      await runDueTick(dueOn(tx), FIRST_TICK);

      const row = await outboxOf(tx, idempotencyKey);
      expect(row?.status).toBe("queued");
      expect(row?.messageType).toBe("text");
      // The frozen text is sent as stored; the template is not re-rendered.
      expect(row?.textBody).toBe(FROZEN_TEXT);
      expect(row?.textBody).not.toBe("NOT the frozen text");
      expect((await scheduleOf(tx, idempotencyKey)).status).toBe("PROCESSING");
    }));

  it("puts a PROCESSING row whose outbox row is missing back to SCHEDULED", () =>
    withTestTransaction(db(), async (tx) => {
      // New: a tick that claimed a row and died before queueing it leaves it
      // PROCESSING with no outbox row; recovery is what lets it be tried again.
      const { idempotencyKey } = await seedDue(tx, "CONNECTED");
      await tx.scheduledMessage.update({ where: { idempotencyKey }, data: { status: "PROCESSING" } });
      expect(await outboxOf(tx, idempotencyKey)).toBeNull(); // precondition

      await recoverStaleProcessing(createDb(tx, runInTransactionOnTx(tx)), FIRST_TICK, 60_000);

      expect((await scheduleOf(tx, idempotencyKey)).status).toBe("SCHEDULED");
    }));
});

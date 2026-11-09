/**
 * Test design (testing-strategy) — scheduling / create-return-reminder, the write
 *
 * Module role: `module_scheduling`. Every call runs `createReminder` inside
 * `db.tx("scheduling", …)`, as the route does, so the rows under test were
 * written under that role.
 *
 * Moved from `packages/db/src/return-reminders.live.test.ts`, its four
 * `createReturnReminderMessage` cases, assertions unchanged but one. That file
 * ran on committed rows with id-prefix cleanup; these run in the rolling-back
 * harness. NO CASE DEPENDED ON A SECOND CONNECTION: every row was written and
 * read back through the same client, and what each asserts — the rows written,
 * or that a refusal wrote none — holds the same inside one transaction. The one
 * changed assertion: "nothing has reached the outbox" compared the GLOBAL
 * `outbox_message` count before and after; a live suite committing an outbox row
 * meanwhile would move it, so it now counts this test's conversation (D9).
 *
 * The fixture is inserted directly rather than opened by
 * `reconcileVehicleReturns` (3C's file): a return dated 2026-09-10 on a service
 * performed 2026-03-10, which is what that reconcile produced with no matching
 * rule. The clock is injected (`now: NOW`), as before.
 *
 * Oracle: vehicle-returns (align-shipped-ui-to-revised-canvas delta) —
 *   "Confirming SHALL create one scheduled message per trigger, each with its own
 *   send instant and its own resolved text, all referencing the reminder message
 *   they came from"; "Confirm MUST NOT send anything immediately".
 *
 * Axes
 *   A1 trigger set — three accepted / empty / one already past
 *   A2 interval provenance — a matched rule on the return / the six-month default
 *   A4 return status — OPEN / ARCHIVED; source service dated / undated; unknown
 *
 * Outputs
 *   O1 three scheduled rows, distinct instants, a text resolved per row, all linked
 *   O2 no reminder message and no scheduled row written on a rejection
 *   O3 outbox untouched by a confirm
 *
 * Sampled-cell
 *   three triggers, rule interval | A1 three A2 rule | O1 O3 | one text reused, or an unlinked row
 *   six-month default             | A2 default       | O1    | the rule read when none is recorded
 *   empty / a past trigger        | A1 empty, past   | O2    | partial rows from a failed confirm
 *   not open / undated / unknown  | A4               | O2    | a reminder on a hidden return
 *
 * Decision map (createReminder)
 *   return row missing              T unknown; F the rest
 *   status !== OPEN                 T archived; F accepted
 *   sourceService.performedAt null  T undated; F the rest
 *   plan.status !== "ok"            T empty, past; F accepted
 *   row.intervalRule present        T rule-interval it; F default-interval it
 *
 * Out of scope: the plan's arithmetic (shared-types' reminder-plan.test.ts);
 *   the route's scoping and probe (create-return-reminder.integration.test.ts).
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
import { createReminder } from "../index.js";

const PERFORMED_AT = new Date("2026-03-10T12:00:00.000Z");
/** Well before every trigger below, so nothing is rejected as already past. */
const NOW = new Date("2026-03-11T12:00:00.000Z");
const nine = { hour: 9, minute: 0 };

const db = () => prisma as PrismaClient;

/** A loja, attendant, customer, conversation, and one vehicle with a dated service and an OPEN return. */
async function seedFixture(tx: DbClient) {
  const unit = await seedUnit(tx);
  const user = await seedUser(tx, { units: [unit.id] });
  const connection = await seedConnection(tx, { unitId: unit.id });
  const customer = await tx.customer.create({
    data: { unitId: unit.id, origin: "omie", status: "active" },
    select: { id: true },
  });
  const conversation = await seedConversation(tx, { connectionId: connection.id });
  await tx.conversation.update({ where: { id: conversation.id }, data: { customerId: customer.id } });
  const vehicle = await tx.vehicle.create({
    data: { customerId: customer.id, plate: `RML-${randomUUID().slice(0, 4)}`, make: "Toyota", model: "Corolla", origin: "omie" },
    select: { id: true },
  });
  const service = await tx.service.create({
    data: {
      customerId: customer.id,
      vehicleId: vehicle.id,
      unitId: unit.id,
      performedAt: PERFORMED_AT,
      kind: "troca de óleo",
      origin: "omie",
    },
    select: { id: true },
  });
  const vehicleReturn = await tx.vehicleReturn.create({
    data: {
      vehicleId: vehicle.id,
      sourceServiceId: service.id,
      returnDate: new Date("2026-09-10T00:00:00.000Z"),
      status: "OPEN",
    },
    select: { id: true },
  });
  return {
    userId: user.id,
    conversationId: conversation.id,
    serviceId: service.id,
    returnId: vehicleReturn.id,
  };
}

/** Runs the write the way the route does: one `db.tx` under scheduling's role. */
function create(tx: DbClient, input: Parameters<typeof createReminder>[1]) {
  return createDb(tx, runInTransactionOnTx(tx)).tx("scheduling", (t) => createReminder(t, input));
}

describeWithDatabase("createReminder", () => {
  it("writes one scheduled row per trigger, each linked and each with its own text", () =>
    withTestTransaction(db(), async (tx) => {
      const f = await seedFixture(tx);
      // A rule recorded on the return is what the recommended interval is read
      // back from, rather than re-matching the service against the rule table.
      const rule = await tx.intervalRule.create({
        data: {
          version: 1,
          criterion: "kind",
          criterionId: `kind-${randomUUID()}`,
          intervalAmount: 6,
          intervalUnit: "months",
          priority: 1,
          active: true,
        },
        select: { id: true },
      });
      await tx.vehicleReturn.update({
        where: { id: f.returnId },
        data: { intervalRuleId: rule.id, intervalRuleVersion: 1 },
      });
      const outboxBefore = await tx.outboxMessage.count({ where: { conversationId: f.conversationId } });

      const result = await create(tx, {
        returnId: f.returnId,
        conversationId: f.conversationId,
        triggers: [
          { kind: "before", days: 30, time: nine },
          { kind: "before", days: 7, time: nine },
          { kind: "before", days: 0, time: nine },
        ],
        createdByUserId: f.userId,
        now: NOW,
      });

      expect(result.status).toBe("ok");
      if (result.status !== "ok") {
        return;
      }
      expect(result.scheduledMessageIds).toHaveLength(3);
      const rows = await tx.scheduledMessage.findMany({
        where: { returnReminderMessageId: result.reminderMessageId },
        orderBy: { scheduledAt: "asc" },
      });
      expect(rows).toHaveLength(3);
      expect(rows.map((row) => row.leadDays)).toEqual([30, 7, 0]);
      expect(rows.every((row) => row.status === "SCHEDULED")).toBe(true);
      // Each row stores its OWN text, resolved for its OWN instant. Under whole
      // months rounded down, 11/08 and 03/09 are both five months after 10/03, so
      // two of the three strings coincide — three copies, two distinct values.
      // That is the rounding rule working, not a shared text: the last row differs.
      expect(rows.map((row) => row.frozenText.slice(0, 12))).toEqual([
        "Faz 5 meses ",
        "Faz 5 meses ",
        "Faz 6 meses ",
      ]);
      expect(rows[0]?.frozenText).toContain("é de 6 meses");
      // Confirm does not send: nothing has reached this conversation's outbox.
      expect(await tx.outboxMessage.count({ where: { conversationId: f.conversationId } })).toBe(outboxBefore);
    }));

  it("uses the six-month default when the return records no rule", () =>
    withTestTransaction(db(), async (tx) => {
      const f = await seedFixture(tx);

      const result = await create(tx, {
        returnId: f.returnId,
        conversationId: f.conversationId,
        triggers: [{ kind: "before", days: 0, time: nine }],
        createdByUserId: f.userId,
        now: NOW,
      });

      expect(result.status).toBe("ok");
      if (result.status !== "ok") {
        return;
      }
      const row = await tx.scheduledMessage.findUniqueOrThrow({
        where: { id: result.scheduledMessageIds[0] as string },
      });
      expect(row.frozenText).toContain("é de 6 meses");
      expect(row.frozenText).toContain("Toyota Corolla");
    }));

  it("writes nothing when the trigger list is empty or a trigger has passed", () =>
    withTestTransaction(db(), async (tx) => {
      const f = await seedFixture(tx);

      expect(
        await create(tx, {
          returnId: f.returnId,
          conversationId: f.conversationId,
          triggers: [],
          createdByUserId: f.userId,
          now: NOW,
        }),
      ).toEqual({ status: "no_triggers" });

      const past = await create(tx, {
        returnId: f.returnId,
        conversationId: f.conversationId,
        // Accepted alongside a rejected one: the whole confirm must fail, not the
        // one trigger, or the attendant gets a partial plan they never approved.
        triggers: [
          { kind: "before", days: 0, time: nine },
          { kind: "absolute", at: new Date("2026-03-01T12:00:00.000Z") },
        ],
        createdByUserId: f.userId,
        now: NOW,
      });
      expect(past.status).toBe("trigger_in_past");

      expect(await tx.returnReminderMessage.count({ where: { vehicleReturnId: f.returnId } })).toBe(0);
      expect(await tx.scheduledMessage.count({ where: { conversationId: f.conversationId } })).toBe(0);
    }));

  it("refuses to add a reminder to a return that is not open", () =>
    withTestTransaction(db(), async (tx) => {
      const f = await seedFixture(tx);
      const trigger = [{ kind: "before" as const, days: 0, time: nine }];
      await tx.vehicleReturn.update({ where: { id: f.returnId }, data: { status: "ARCHIVED" } });

      const result = await create(tx, {
        returnId: f.returnId,
        conversationId: f.conversationId,
        triggers: trigger,
        createdByUserId: f.userId,
        now: NOW,
      });

      await tx.vehicleReturn.update({ where: { id: f.returnId }, data: { status: "OPEN" } });
      expect(result).toEqual({ status: "return_not_open" });

      // With no `performedAt` there is nothing to measure elapsed time from, so
      // the text could not be composed at all.
      await tx.service.update({ where: { id: f.serviceId }, data: { performedAt: null } });
      const undated = await create(tx, {
        returnId: f.returnId,
        conversationId: f.conversationId,
        triggers: trigger,
        createdByUserId: f.userId,
        now: NOW,
      });
      await tx.service.update({ where: { id: f.serviceId }, data: { performedAt: PERFORMED_AT } });
      expect(undated).toEqual({ status: "no_performed_at" });

      expect(
        await create(tx, {
          returnId: `missing-${randomUUID()}`,
          conversationId: f.conversationId,
          triggers: trigger,
          createdByUserId: f.userId,
          now: NOW,
        }),
      ).toEqual({ status: "not_found" });
    }));
});

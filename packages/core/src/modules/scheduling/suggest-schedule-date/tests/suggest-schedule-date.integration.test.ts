/**
 * Test design (testing-strategy) — scheduling / suggest-schedule-date
 *
 * Module role: `module_scheduling`. The read of `service` and `interval_rule`
 * (services' tables, `readableBy`) runs in `db.tx("scheduling", …)`; nothing
 * is written.
 *
 * Moved from `apps/api/src/scheduled.route.test.ts`, assertions unchanged: its
 * two suggest cases.
 *
 * SUT: `GET /services/:id/suggest-schedule-date`, through `buildSliceApp` with
 *   this slice's route only, inside one rolling-back transaction.
 *
 * Oracle: scheduled-messages task 2.2 / design D4 — GET suggest-date.
 *
 * FAKE-ONLY ASSERTION SURFACED (carried over)
 *   F3 — the old fake never consulted an interval rule. The six-month case is
 *     pinned to a kind no rule can match, so the default is reached by
 *     construction rather than by the rule table happening to be empty, and a
 *     second case seeds a matching rule and asserts the `rule` source.
 *
 * Axes: A6 rule match — none / exactly one
 * Outputs: O6 six_months; O7 rule; O9 no row written
 *
 * Sampled-cell
 *   suggest, no rule matches    | A6 none | O6 O9 | rule / insert
 *   suggest, one rule matches   | A6 one  | O7    | six_months
 *
 * Decision map (suggest-schedule-date)
 *   service miss                not sampled — the same 404 as another loja
 *   no performedAt              out of scope (400) — every case has a date
 *
 * Out of scope: the hook's 401/403; `suggestDate`'s own rule selection
 *   (shared-types).
 */
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { prisma, type PrismaClient } from "@select-lub/core/db";
import { createDb, type DbClient } from "../../../../kernel/db.js";
import { registerSlice } from "../../../../kernel/http.js";
import {
  buildSliceApp,
  describeWithDatabase,
  runInTransactionOnTx,
  seedUnit,
  seedUser,
  withTestTransaction,
} from "@select-lub/core/testing";
import { route } from "../index.js";

const db = () => prisma as PrismaClient;

/** A service of `kind` in a fresh loja, and an attendant of that loja. */
async function seedService(tx: DbClient, kind: string) {
  const unit = await seedUnit(tx);
  const user = await seedUser(tx, { units: [unit.id] });
  const customer = await tx.customer.create({
    data: { origin: "crm", status: "active", name: "Maria" },
    select: { id: true },
  });
  const vehicle = await tx.vehicle.create({
    data: { customerId: customer.id, origin: "crm", plate: "ABC-1D23" },
    select: { id: true },
  });
  const service = await tx.service.create({
    data: {
      customerId: customer.id,
      vehicleId: vehicle.id,
      unitId: unit.id,
      origin: "crm",
      kind,
      performedAt: new Date("2026-01-15T03:00:00.000Z"),
    },
    select: { id: true },
  });
  return { unitId: unit.id, userId: user.id, serviceId: service.id };
}

async function suggest(tx: DbClient, scope: { unitId: string; userId: string; serviceId: string }) {
  const app = await buildSliceApp({
    db: createDb(tx, runInTransactionOnTx(tx)),
    plugin: (app) => registerSlice(app, "scheduling", "suggest-schedule-date", route),
    caller: { userId: scope.userId, unitId: scope.unitId },
  });
  try {
    return await app.inject({ method: "GET", url: `/services/${scope.serviceId}/suggest-schedule-date` });
  } finally {
    await app.close();
  }
}

describeWithDatabase("GET /services/:id/suggest-schedule-date", () => {
  it("suggests six months when no interval rule matches, without inserting a schedule", () =>
    withTestTransaction(db(), async (tx) => {
      // A kind nothing can match, so the default is reached by construction
      // rather than by the rule table happening to be empty (F3).
      const scope = await seedService(tx, `kind-${randomUUID()}`);

      const suggested = await suggest(tx, scope);

      expect(suggested.statusCode).toBe(200);
      expect(suggested.json().suggestionSource).toBe("six_months");
      // A suggestion is a read: nothing is written for the service.
      expect(await tx.scheduledMessage.count({ where: { serviceId: scope.serviceId } })).toBe(0);
    }));

  it("suggests the rule's interval when exactly one rule matches the kind", () =>
    withTestTransaction(db(), async (tx) => {
      const kind = `kind-${randomUUID()}`;
      const scope = await seedService(tx, kind);
      const rule = await tx.intervalRule.create({
        data: {
          version: 1,
          criterion: "kind",
          criterionId: kind,
          intervalAmount: 3,
          intervalUnit: "months",
          priority: 1,
          active: true,
        },
        select: { id: true },
      });

      const suggested = await suggest(tx, scope);

      expect(suggested.statusCode).toBe(200);
      // The slice reads every rule in the table and the engine picks this one;
      // the old fake had no rules to read at all (F3).
      expect(suggested.json().suggestionSource).toBe("rule");
      expect(rule.id).toBeTruthy();
    }));
});

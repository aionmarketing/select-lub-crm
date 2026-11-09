/**
 * Test design (testing-strategy)
 *
 * Setup: the `report-conversations` slice mounted on the kernel app with
 * `buildSliceApp`, inside one rolling-back transaction per test
 * (`withTestTransaction`) on the worktree database, the caller stated on the
 * request. The whole attribution fixture — customer, vehicle, Omie service,
 * SENT scheduled message, conversation — is created inside the transaction, so
 * this file leaves nothing behind (memory: reports-live-tests-leak-a-unit-per-run).
 *
 * Runs under module role: `module_reports`. The attribution rows it asserts on
 * are written by `internal/recompute-attribution.ts` under that role, so a write
 * to a table `reports` does not own would be refused here, not in review.
 *
 * Moved from `apps/api/src/reports.attribution.route.test.ts`
 * (adopt-modular-vertical-slices 2C): all four cases, assertions unchanged.
 *
 * Counts are deltas against rows this test created: each test makes its own
 * unit, and every attribution query is scoped `service: { unitId }` or through
 * `whatsappConnection: { unitId }`, so no base or demo row can reach them.
 *
 * ASSERTIONS THAT ONLY HELD ON THE FAKE
 *   1. Idempotency was asserted against a JS array, not against the database.
 *      The fake's `summary` did `scheduledAttributions.push(...inserts)` on an
 *      array the test itself owned, and the old file asserted
 *      `expect(scheduledAttributions).toHaveLength(1)`. Two things that matter
 *      in production were therefore untested: the adapter's
 *      `createMany({ skipDuplicates: true })`, and the `@@unique([serviceId,
 *      scheduledMessageId])` it depends on. A repeat request now has to be
 *      idempotent in Postgres, and the assertion counts `service_scheduled_
 *      attribution` rows.
 *   2. "Highest version wins" was the fake's code path, not production's. The
 *      fake handed `currentAttributionRule` every seeded rule and its `reduce`
 *      picked the maximum. The Prisma adapter instead does
 *      `attributionRule.findFirst({ orderBy: { version: "desc" } })` and wraps
 *      the single row it gets in a one-element array, so the reduce is
 *      unreachable and the ordering is SQL's. Sampled here by inserting a
 *      second rule version in the transaction.
 *   3. The anchor's unit was seeded, not derived. The fake took
 *      `AttributionScheduledAnchor.unitId` and `referenceVehicleId` as given
 *      literals (`"unit-a"`, `"veh-1"`). The adapter derives both:
 *      `unitId` from `conversation.whatsappConnection.unitId ?? service.unitId`
 *      and `referenceVehicleId` from `service.vehicleId`. A SENT message whose
 *      service carries no vehicle now really does anchor on the customer only.
 *
 * Oracle: relatorios-attribution-metrics — the result carries `attribution.rule`
 *   (the 30-day v1 the attribution migration inserts), a `scheduledReturn`
 *   count, and a `conversion` pair; a repeat request inserts no new association
 *   rows.
 *
 * Axes
 *   A1 request count — 1 / 2
 *   A2 stored rule versions — the base v1 only / v1 plus a higher v2
 *   A3 anchor match — customer and vehicle / customer only (service with no
 *      vehicle), which is the arm the fake fed by hand
 *
 * Outputs: O1 the attribution section; O2 the association row count in
 *   Postgres, unchanged on repeat; O3 the rule the response reports
 *
 * Sampled-cell
 *   first GET has rule + count 1   | A1 1 A2 base  | O1 | attribution missing
 *   second GET same count and rows | A1 2          | O2 | a duplicate row, or a unique violation
 *   a higher rule version wins     | A2 v2         | O3 | the response still reporting v1
 *   customer-only anchor           | A3 no vehicle | O1 | count 0 when the vehicle is what matched
 *
 * Decision map
 *   `isOmieOrigin` — T for the seeded service (`omieId` set, origin `omie`);
 *     the F arm is aggregate-level and belongs to the internal attribution tests.
 *   `scheduledReturnInserts` customerMatch / vehicleMatch — both T in the first
 *     cases, customerMatch alone in the A3 case.
 *   `seen.has(key)` — F on the first request, T on the second.
 *
 * Out of scope: REP-12's window arithmetic and the quote-approval anchor
 *   (internal/*-inserts.test.ts own the arms); the report's non-attribution
 *   sections (report-conversations.integration.test.ts).
 */
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { reportResultSchema } from "../../contracts/http.js";
import type { DbClient } from "../../../../kernel/index.js";
import {
  describeWithDatabase,
  seedConnection,
  seedUnit,
  seedUser,
  withTestTransaction,
} from "../../../../testing/index.js";
import { CALLER_USER_ID, db, get } from "./report-app.fixture.js";

const QUERY =
  "periodStart=2026-08-01T00:00:00.000Z&periodEnd=2026-09-01T00:00:00.000Z&granularity=day";
const FIRST_INBOUND = new Date("2026-08-10T12:00:00.000Z");
const FIRST_OUTBOUND = new Date("2026-08-10T13:00:00.000Z");
const SENT_AT = new Date("2026-08-12T12:00:00.000Z");
const PERFORMED_AT = new Date("2026-08-20T12:00:00.000Z");

/**
 * Builds the whole REP-11 / REP-12 fixture in one transaction.
 *
 * @param tx - The test transaction.
 * @param withVehicle - When false the service carries no vehicle, so the SENT
 *   anchor can only match on the customer.
 * @returns The unit, service, conversation and scheduled-message ids.
 */
async function seedAttributionFixture(
  tx: DbClient,
  { withVehicle = true }: { withVehicle?: boolean } = {},
) {
  const unit = await seedUnit(tx);
  const connection = await seedConnection(tx, { unitId: unit.id });
  await seedUser(tx, { id: CALLER_USER_ID, units: [unit.id] });

  const customer = await tx.customer.create({
    data: { name: "Cliente REP", unitId: unit.id, origin: "omie", status: "active" },
    select: { id: true },
  });
  const vehicle = await tx.vehicle.create({
    data: { customerId: customer.id, plate: "ABC1D23", origin: "omie" },
    select: { id: true },
  });
  const service = await tx.service.create({
    data: {
      customerId: customer.id,
      // Null makes `referenceVehicleId` null on the anchor, leaving the
      // customer as the only possible match.
      vehicleId: withVehicle ? vehicle.id : null,
      unitId: unit.id,
      // `isOmieOrigin` needs a non-null omieId and an origin that is not "crm".
      omieId: `omie-${randomUUID()}`,
      origin: "omie",
      performedAt: PERFORMED_AT,
      amount: 180,
    },
    select: { id: true },
  });
  const key = `5519${randomUUID().replace(/\D/g, "").slice(0, 8).padEnd(8, "0")}`;
  const conversation = await tx.conversation.create({
    data: {
      whatsappConnectionId: connection.id,
      remoteJid: `${key}@s.whatsapp.net`,
      chatKey: key,
      customerId: customer.id,
      startedAt: FIRST_INBOUND,
      firstInboundAt: FIRST_INBOUND,
      firstOutboundAt: FIRST_OUTBOUND,
      lastMessageAt: FIRST_OUTBOUND,
    },
    select: { id: true },
  });
  const anchor = await tx.scheduledMessage.create({
    data: {
      customerId: customer.id,
      serviceId: service.id,
      frozenText: "retorno",
      scheduledAt: SENT_AT,
      sentAt: SENT_AT,
      status: "SENT",
      idempotencyKey: `attr-${randomUUID()}`,
      createdByUserId: CALLER_USER_ID,
    },
    select: { id: true },
  });

  return {
    unitId: unit.id,
    serviceId: service.id,
    conversationId: conversation.id,
    anchorId: anchor.id,
  };
}

/**
 * Requests the report and parses the body.
 *
 * A fresh app per request, because the slice writes association rows as a side
 * effect of reading and the second request must see the first one's rows from
 * Postgres rather than from anything held in memory.
 *
 * @param tx - The test transaction.
 * @param unitId - The caller's scoped unit.
 * @returns The parsed {@link reportResultSchema} body.
 */
async function getReport(tx: DbClient, unitId: string) {
  const response = await get(tx, unitId, QUERY);
  expect(response.statusCode).toBe(200);
  return reportResultSchema.parse(JSON.parse(response.body));
}

describeWithDatabase("GET /reports/conversations attribution", () => {
  it("returns the attribution section with the base 30-day rule and the REP-11 count", () =>
    withTestTransaction(db(), async (tx) => {
      const { unitId, serviceId, anchorId } = await seedAttributionFixture(tx);
      // Precondition: the rule the attribution migration inserts is the only
      // one stored, so version 1 below is the stored rule and not a default the
      // aggregate fell back to.
      const stored = await tx.attributionRule.findFirst({ orderBy: { version: "desc" } });
      expect(stored).toMatchObject({ version: 1, windowDays: 30 });

      const body = await getReport(tx, unitId);

      expect(body.attribution.rule).toEqual({ windowDays: 30, version: 1 });
      expect(body.attribution.scheduledReturn.count).toBe(1);
      expect(body.attribution.conversion).toEqual({
        converted: 1,
        total: 1,
        bySource: [{ sourceType: "UNKNOWN", converted: 1, total: 1 }],
      });
      // The row really landed in Postgres, with the rule version recorded.
      const rows = await tx.serviceScheduledAttribution.findMany({ where: { serviceId } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ scheduledMessageId: anchorId, ruleVersion: 1 });
    }));

  it("inserts no new association rows on a repeat request", () =>
    withTestTransaction(db(), async (tx) => {
      const { unitId, serviceId, conversationId } = await seedAttributionFixture(tx);

      const first = await getReport(tx, unitId);
      const second = await getReport(tx, unitId);

      expect(first.attribution.scheduledReturn.count).toBe(1);
      expect(second.attribution.scheduledReturn.count).toBe(1);
      expect(second.attribution.conversion).toEqual(first.attribution.conversion);
      // One row per pair after two requests: the adapter's skipDuplicates and
      // the @@unique behind it, neither of which the fake's array exercised.
      expect(await tx.serviceScheduledAttribution.count({ where: { serviceId } })).toBe(1);
      expect(
        await tx.serviceConversationAttribution.count({ where: { serviceId, conversationId } }),
      ).toBe(1);
    }));

  it("reports the highest stored rule version, and records it on the new rows", () =>
    withTestTransaction(db(), async (tx) => {
      const { unitId, serviceId } = await seedAttributionFixture(tx);
      // A later rule with a window wide enough to keep the same pair matching,
      // so the only thing that changes is which rule the adapter reports.
      await tx.attributionRule.create({ data: { version: 2, windowDays: 45 } });

      const body = await getReport(tx, unitId);

      expect(body.attribution.rule).toEqual({ windowDays: 45, version: 2 });
      expect(body.attribution.scheduledReturn.count).toBe(1);
      const rows = await tx.serviceScheduledAttribution.findMany({ where: { serviceId } });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.ruleVersion).toBe(2);
    }));

  it("anchors on the customer when the service carries no vehicle", () =>
    withTestTransaction(db(), async (tx) => {
      const { unitId, serviceId } = await seedAttributionFixture(tx, { withVehicle: false });
      // Precondition: the vehicle side of the match is genuinely absent, so a
      // count of 1 below is the customer arm and not the vehicle arm.
      const service = await tx.service.findUniqueOrThrow({
        where: { id: serviceId },
        select: { vehicleId: true },
      });
      expect(service.vehicleId).toBeNull();

      const body = await getReport(tx, unitId);

      expect(body.attribution.scheduledReturn.count).toBe(1);
    }));
});

/**
 * Test design (testing-strategy)
 *
 * Setup: the `report-conversations` slice mounted on the kernel app with
 * `buildSliceApp`, through the same `reportConversationsRoute(ports)` factory the
 * module's `createHttpPlugin` uses, inside one rolling-back transaction per test
 * (`withTestTransaction`) on the worktree database. The caller is STATED on the
 * request (`caller: { unitId }`), as `apps/api`'s auth hook would have resolved
 * it. Every unit, connection, conversation, message and scheduled row is created
 * inside the transaction, so the file leaves nothing behind (memory:
 * reports-live-tests-leak-a-unit-per-run).
 *
 * Runs under module role: `module_reports` — the slice's `db.tx("reports", …)`
 * sets it for the reads and the attribution writes; the harness's own seeding
 * runs as the login role.
 *
 * Moved from `apps/api/src/reports.route.test.ts` (adopt-modular-vertical-slices
 * 2C). Nine of its ten cases moved here with their assertions unchanged. The
 * tenth — 403 when `X-Unit-Id` names a unit the caller is not in — is the auth
 * hook's case, not the slice's, and a stand-in hook would pass it vacuously, so
 * it moved to `apps/api/test/reports.integration.test.ts` through the real
 * `buildApp`. The slice's OWN 403 (a request that reaches it with no scoped unit)
 * is asserted here, new. So is the unanswered-quote port, which replaced a direct
 * import of follow-up's function.
 *
 * Because each test creates its own unit, nothing outside the transaction can
 * contribute a conversation to it; the counts below are deltas against rows this
 * test created, not shares of a database-wide total (design D9 of
 * route-tests-on-real-database).
 *
 * ASSERTIONS THAT ONLY HELD ON THE FAKE
 *   1. Unit scoping. `createMemoryReportsStore` was seeded with
 *      `seedReportRow({ unitId })` — a flat `unitId` stamped on each
 *      conversation — and `conversationInScope` compared it directly. A
 *      conversation has no unit column: the Prisma adapter reaches the unit
 *      through `whatsappConnection: { unitId }`. So the old
 *      "returns novas only for the caller's unit" case passed on a data model
 *      production does not have, and it could not have distinguished a correct
 *      join from no join at all. Replaced by two cases the fake could not
 *      express: two connections in ONE unit both counting (the fake had no
 *      connection concept to split them across), and a conversation on a
 *      connection in another unit not counting.
 *   2. `scheduled` ignoring the conversation filters. The fake returned its
 *      seeded `scheduled` array verbatim for every query. The Prisma adapter
 *      selects scheduled rows with
 *      `OR: [{ conversation: <the filtered where> }, { service: { unitId } }]`
 *      and DROPS the service arm whenever a tag, campaign or source filter is
 *      on. The old "unknown tagId" case asserted the zero counts and passed
 *      only because nothing was seeded; on the fake it would have reported the
 *      unit's scheduled rows under a filter matching no conversation. Now
 *      asserted with a scheduled row actually present.
 *   3. Unit ids did not have to exist. The fake's `resolveUnitId` echoed the
 *      header back, so `"unit-a"` and `"unit-b"` were fictional. The real rows
 *      are FK-checked; ids come from `seedUnit`.
 *
 * Oracle: relatorios spec — empty cut 200 body; invalid query → 400.
 *
 * Axes
 *   A1 period membership (match / miss)
 *   A2 query validity (ok / start after end / bad enum / bad origin)
 *   A3 scoped unit — present / absent (the slice's own 403)
 *   A4 connection — one / two in the same unit / one in another unit
 *   A5 filter selectivity — no filter / a filter matching nothing
 *
 * Outputs: O1 200 ReportResult with novas; O2 200 empty cut; O3 400; O4 403;
 *   O5 200 with `scheduled` counts; O6 the port's answer in the body
 *
 * Sampled-cell
 *   empty-cut 200 parsable      | A1 miss           | O2 | 400 or novas > 0
 *   matching period novas       | A1 hit            | O1 | 0 novas
 *   two connections, one unit   | A4 two            | O1 | 1 nova (per-connection scoping)
 *   connection in another unit  | A4 foreign        | O1 | 2 novas (join ignored)
 *   start after end             | A2 inv            | O3 | 200
 *   unknown granularity         | A2 inv            | O3 | 200
 *   unknown origin              | A2 inv            | O3 | 200
 *   unknown campaignId          | A5 matches none   | O2 | 400
 *   unknown tagId + a schedule  | A5 matches none   | O2 O5 | the unit's schedules counted anyway
 *   no scoped unit (new)        | A3 absent         | O4 | a report built for no unit, or a 500
 *   port wiring (new)           | -                 | O6 | a count computed some other way, or another unit's quotes
 *
 * Decision map (report-conversations/index.ts)
 *   `if (!unitId)` — T: the no-scoped-unit case; F: every other case. Through
 *     `apps/api` it is contract-hidden (the hook 403s first); on the kernel app
 *     it is reachable, which is why it is sampled here.
 *   Query 400 is Fastify/zod before the handler (A2).
 *
 * Out of scope: the aggregation arms (internal/*.test.ts); attribution
 *   (attribution.integration.test.ts); how the loaded rows are mapped
 *   (row-mapping.integration.test.ts); the hook's 401/403
 *   (apps/api/test/reports.integration.test.ts).
 */
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { reportResultSchema } from "../../contracts/http.js";
import {
  describeWithDatabase,
  seedConnection,
  seedUnit,
  withTestTransaction,
} from "../../../../testing/index.js";
import {
  CALLER_USER_ID,
  EMPTY,
  INBOUND_AT,
  MATCHING,
  db,
  get,
  recordingPorts,
  seedCallerUnit,
  seedNova,
} from "./report-app.fixture.js";

describeWithDatabase("GET /reports/conversations", () => {
  it("returns a parsable empty-cut body when the period has no novas", () =>
    withTestTransaction(db(), async (tx) => {
      const { unitId, connectionId } = await seedCallerUnit(tx);
      await seedNova(tx, connectionId);

      const response = await get(tx, unitId, `${EMPTY}&granularity=day`);

      expect(response.statusCode).toBe(200);
      const body = reportResultSchema.parse(JSON.parse(response.body));
      expect(body.newConversationCount).toBe(0);
      expect(body.buckets).toEqual([]);
    }));

  it("returns novas for a matching period", () =>
    withTestTransaction(db(), async (tx) => {
      const { unitId, connectionId } = await seedCallerUnit(tx);
      await seedNova(tx, connectionId);

      const response = await get(tx, unitId, `${MATCHING}&granularity=week`);

      expect(response.statusCode).toBe(200);
      const body = reportResultSchema.parse(JSON.parse(response.body));
      expect(body.newConversationCount).toBe(1);
      expect(body.coverage).toEqual({ answered: 1, total: 1 });
    }));

  it("counts conversations on every connection in the unit, not only one", () =>
    withTestTransaction(db(), async (tx) => {
      const { unitId, connectionId } = await seedCallerUnit(tx);
      // A second channel in the SAME loja. The fake stamped a flat unitId on
      // each row and had no connection at all, so it could not tell this case
      // apart from the single-connection one above.
      const second = await seedConnection(tx, { unitId });
      await seedNova(tx, connectionId);
      await seedNova(tx, second.id);

      const response = await get(tx, unitId, `${MATCHING}&granularity=week`);

      const body = reportResultSchema.parse(JSON.parse(response.body));
      expect(body.newConversationCount).toBe(2);
      expect(body.coverage).toEqual({ answered: 2, total: 2 });
    }));

  it("does not count a conversation on a connection belonging to another unit", () =>
    withTestTransaction(db(), async (tx) => {
      const { unitId, connectionId } = await seedCallerUnit(tx);
      const otherUnit = await seedUnit(tx);
      const otherConnection = await seedConnection(tx, { unitId: otherUnit.id });
      await seedNova(tx, connectionId);
      const foreign = await seedNova(tx, otherConnection.id);

      const response = await get(tx, unitId, `${MATCHING}&granularity=week`);

      const body = reportResultSchema.parse(JSON.parse(response.body));
      expect(body.newConversationCount).toBe(1);
      // The foreign row exists and falls inside the period, so the 1 above is
      // the join excluding it rather than the row being absent.
      const stored = await tx.conversation.findUniqueOrThrow({
        where: { id: foreign },
        select: { firstInboundAt: true, whatsappConnection: { select: { unitId: true } } },
      });
      expect(stored.firstInboundAt).toEqual(INBOUND_AT);
      expect(stored.whatsappConnection.unitId).toBe(otherUnit.id);
    }));

  it("rejects when periodStart is after periodEnd", () =>
    withTestTransaction(db(), async (tx) => {
      const { unitId } = await seedCallerUnit(tx);

      const response = await get(
        tx,
        unitId,
        "periodStart=2026-09-01T00:00:00.000Z&periodEnd=2026-08-01T00:00:00.000Z&granularity=day",
      );

      expect(response.statusCode).toBe(400);
    }));

  it("rejects an unknown granularity", () =>
    withTestTransaction(db(), async (tx) => {
      const { unitId } = await seedCallerUnit(tx);

      const response = await get(tx, unitId, `${MATCHING}&granularity=quarter`);

      expect(response.statusCode).toBe(400);
    }));

  it("rejects an unknown origin", () =>
    withTestTransaction(db(), async (tx) => {
      const { unitId } = await seedCallerUnit(tx);

      const response = await get(tx, unitId, `${MATCHING}&granularity=day&sourceType=PAID`);

      expect(response.statusCode).toBe(400);
    }));

  it("returns an empty cut for an unknown campaignId instead of 400", () =>
    withTestTransaction(db(), async (tx) => {
      const { unitId, connectionId } = await seedCallerUnit(tx);
      await seedNova(tx, connectionId);

      const response = await get(
        tx,
        unitId,
        `${MATCHING}&granularity=day&campaignId=missing-campaign`,
      );

      expect(response.statusCode).toBe(200);
      const body = reportResultSchema.parse(JSON.parse(response.body));
      expect(body.newConversationCount).toBe(0);
    }));

  it("leaves scheduled counts at zero when a tag filter matches no conversation", () =>
    withTestTransaction(db(), async (tx) => {
      const { unitId, connectionId } = await seedCallerUnit(tx);
      const conversationId = await seedNova(tx, connectionId);
      // A real SCHEDULED row inside the period, on the unit's own conversation.
      // Unfiltered it is counted; under a tag filter that matches nothing the
      // adapter's `OR` collapses to the conversation arm and it must not be.
      // The fake returned its seeded `scheduled` array for every query, so this
      // is the case it could not have failed.
      await tx.scheduledMessage.create({
        data: {
          conversationId,
          frozenText: "retorno",
          scheduledAt: new Date("2026-08-20T12:00:00.000Z"),
          status: "SCHEDULED",
          idempotencyKey: `rpt-${randomUUID()}`,
          createdByUserId: CALLER_USER_ID,
        },
      });

      const unfiltered = reportResultSchema.parse(
        JSON.parse((await get(tx, unitId, `${MATCHING}&granularity=day`)).body),
      );
      expect(unfiltered.scheduled.scheduled).toBe(1);

      const response = await get(tx, unitId, `${MATCHING}&granularity=day&tagId=missing-tag`);

      expect(response.statusCode).toBe(200);
      const body = reportResultSchema.parse(JSON.parse(response.body));
      expect(body.newConversationCount).toBe(0);
      expect(body.scheduled).toEqual({ scheduled: 0, sent: 0, cancelled: 0, failed: 0 });
    }));

  it("refuses with 403 a request that reaches the slice with no scoped unit", () =>
    withTestTransaction(db(), async (tx) => {
      const { connectionId } = await seedCallerUnit(tx);
      await seedNova(tx, connectionId);

      const response = await get(tx, undefined, `${MATCHING}&granularity=day`);

      expect(response.statusCode).toBe(403);
      expect(JSON.stringify(response.json())).not.toContain("newConversationCount");
    }));

  it("asks the unanswered-quote port about this unit's quotes and reports its answer", () =>
    withTestTransaction(db(), async (tx) => {
      const { unitId, connectionId } = await seedCallerUnit(tx);
      const conversationId = await seedNova(tx, connectionId);
      const customer = await tx.customer.create({
        data: { name: "Cliente", unitId, origin: "crm", status: "active" },
        select: { id: true },
      });
      const vehicle = await tx.vehicle.create({
        data: { customerId: customer.id, plate: "ABC1D23", origin: "crm" },
        select: { id: true },
      });
      const quote = await tx.oilQuote.create({
        data: {
          customerId: customer.id,
          vehicleId: vehicle.id,
          conversationId,
          generatedMessageText: "orçamento",
          createdByUserId: CALLER_USER_ID,
        },
        select: { id: true },
      });
      // A distinctive answer, far from zero, so a body that computed the count
      // any other way cannot match it by accident.
      const { ports, calls } = recordingPorts(7);

      const response = await get(tx, unitId, `${MATCHING}&granularity=day`, ports);

      expect(response.statusCode).toBe(200);
      const body = reportResultSchema.parse(JSON.parse(response.body));
      expect(body.insights.secondary.unansweredQuotes).toBe(7);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.unitId).toBe(unitId);
      expect(calls[0]?.quotes.map((row) => row.quoteId)).toEqual([quote.id]);
    }));
});

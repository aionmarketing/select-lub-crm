/**
 * Test design (testing-strategy)
 *
 * Setup: `reportConversations(db, { unitId, query }, ports)` — the slice's plain
 * function, no HTTP — on the worktree database inside one rolling-back
 * transaction per test. Every row is created inside the transaction.
 *
 * Runs under module role: `module_reports`.
 *
 * Moved from `apps/api/src/reports/prisma.test.ts` (adopt-modular-vertical-slices
 * 2C), which drove `createPrismaReportsStore` through a HAND-ROLLED FAKE PRISMA
 * CLIENT: a stub object with one method per delegate, returning canned rows and
 * recording the `where` it was handed. It was not a `memory.ts` store, which is
 * why route-tests-on-real-database left it standing. Eight of its fourteen cases
 * are here, rewritten from "the stub was called with X" into "the database
 * returns X"; the other six are not, because what they tested is gone:
 *
 *   - "resolveUnitId …" (5 cases). `ReportsStore.resolveUnitId` had no
 *     production caller — `routes.ts` has always taken the unit from the auth
 *     hook's `unitIdOf(request)`. It was dead code tested only by these five,
 *     and the slice does not carry it. The unit resolution they describe is the
 *     hook's, which keeps its own tests in `apps/api`.
 *   - "maps an unknown source_type string to UNKNOWN …" (1 case), removed by an
 *     owner decision. It needs a conversation stored with a non-canonical origin,
 *     and the database now refuses one: migration 20260924120000 adds a CHECK
 *     constraint limiting `conversation.source_type` to AD, ORGANIC and UNKNOWN,
 *     tested in `apps/api/test/conversation-source-type.integration.test.ts`
 *     ("refuses any other value"). See finding 2 below for why it was raised.
 *     `queries.ts`'s `asSourceType` still maps anything else to UNKNOWN — harmless
 *     and defensive, and now unreachable from stored data.
 *
 * ASSERTIONS THAT ONLY HELD ON THE FAKE
 *   1. Every "passes X into findMany" case asserted on the stub's recorded
 *      `where` object — the query's SHAPE, not its effect. A where clause that
 *      named the right key and still matched the wrong rows would have passed.
 *      Each is now asserted on which rows the report actually counts.
 *   2. The stub IGNORED `where` altogether: `findMany` returned the canned rows
 *      whatever the filter. So "maps an unknown source_type string to UNKNOWN"
 *      asserted that filtering by UNKNOWN counts a row stored as `GARBAGE` —
 *      which held only because the stub never applied the filter, and the
 *      in-memory `asSourceType` mapping then reclassified the row. On Postgres
 *      the origin filter compares the raw column, so `'GARBAGE'` never matched
 *      `'UNKNOWN'`, while the unfiltered report still filed the row under the
 *      UNKNOWN origin — the origin table and its own drill-through would have
 *      disagreed about it. Latent when found (the column was unconstrained TEXT,
 *      but every writer is typed to AD/ORGANIC/UNKNOWN), it was closed by the
 *      owner with a CHECK constraint (see above), so the state can no longer
 *      exist and the case is gone.
 *   3. Directions and statuses were whatever the stub said. A message direction
 *      is now a real `message.direction` value the mapping has to drop.
 *
 * Oracle: relatorios spec — the origin filter narrows by source; unknown stored
 * origins are not ORGANIC; ativas count real directions only; respondidas and
 * the unanswered list follow the first outbound and `shouldReply`; scheduled
 * counts come from stored rows, and service-only rows drop out under a
 * conversation filter.
 *
 * Sampled-cell
 *   AD filter keeps only AD            | the ORGANIC row counted
 *   no filter counts every origin      | only one origin counted
 *   AD survives the mapping            | reclassified as UNKNOWN
 *   tag + campaign narrow together     | either filter ignored
 *   a removed tag application          | still matches the tag filter
 *   garbage direction dropped          | counted as an ativa
 *   respondidas 1/2 and unanswered [A] | B listed, or 2/2
 *   no scheduled rows → zeros          | invented non-zero
 *   service-only schedule under filter | still counted
 */
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import type { ReportQuery } from "../../contracts/http.js";
import { createDb, type DbClient } from "../../../../kernel/index.js";
import { describeWithDatabase, runInTransactionOnTx, withTestTransaction } from "../../../../testing/index.js";
import { reportConversations } from "../index.js";
import { CALLER_USER_ID, db, recordingPorts, seedCallerUnit, seedNova } from "./report-app.fixture.js";

const query: ReportQuery = {
  periodStart: "2026-08-01T00:00:00.000Z",
  periodEnd: "2026-09-01T00:00:00.000Z",
  granularity: "day",
};

/** Runs the slice's function on the test transaction. */
function report(tx: DbClient, unitId: string, cut: ReportQuery = query) {
  return reportConversations(createDb(tx, runInTransactionOnTx(tx)), { unitId, query: cut }, recordingPorts().ports);
}

/** Adds one message to a conversation. */
async function message(tx: DbClient, conversationId: string, direction: string, at: string, shouldReply?: boolean) {
  await tx.message.create({
    data: {
      conversationId,
      externalMessageId: `t-msg-${randomUUID()}`,
      direction,
      messageType: "text",
      providerTimestamp: new Date(at),
      ...(shouldReply === undefined ? {} : { shouldReply }),
    },
  });
}

/** An origin row's lead count, from the unfiltered report's origin table. */
function leadsOf(result: Awaited<ReturnType<typeof report>>, origin: "AD" | "ORGANIC" | "UNKNOWN") {
  return result.insights.originRows.find((row) => row.origin === origin)?.leads;
}

describeWithDatabase("report-conversations: what the loaded rows become", () => {
  it("keeps only AD conversations under an AD origin filter", () =>
    withTestTransaction(db(), async (tx) => {
      const { unitId, connectionId } = await seedCallerUnit(tx);
      await seedNova(tx, connectionId, { data: { sourceType: "AD" } });
      await seedNova(tx, connectionId, { data: { sourceType: "ORGANIC" } });

      const result = await report(tx, unitId, { ...query, sourceType: "AD" });

      expect(result.newConversationCount).toBe(1);
    }));

  it("counts every origin when no origin filter is given", () =>
    withTestTransaction(db(), async (tx) => {
      const { unitId, connectionId } = await seedCallerUnit(tx);
      await seedNova(tx, connectionId, { data: { sourceType: "AD" } });
      await seedNova(tx, connectionId, { data: { sourceType: "ORGANIC" } });

      const result = await report(tx, unitId);

      expect(result.newConversationCount).toBe(2);
    }));

  it("keeps an AD conversation as AD through the mapping", () =>
    withTestTransaction(db(), async (tx) => {
      const { unitId, connectionId } = await seedCallerUnit(tx);
      await seedNova(tx, connectionId, { data: { sourceType: "AD" } });

      const result = await report(tx, unitId);

      expect(leadsOf(result, "AD")).toBe(1);
      expect(leadsOf(result, "UNKNOWN")).toBe(0);
    }));

  it("narrows by tag and campaign together, and ignores a removed tag application", () =>
    withTestTransaction(db(), async (tx) => {
      const { unitId, connectionId } = await seedCallerUnit(tx);
      const tag = await tx.tag.create({
        data: { unitId, name: `t-${randomUUID().slice(0, 8)}`, color: "#000000" },
        select: { id: true },
      });
      const tagged = await seedNova(tx, connectionId, { data: { campaignId: "camp-1" } });
      const untagged = await seedNova(tx, connectionId, { data: { campaignId: "camp-1" } });
      const removed = await seedNova(tx, connectionId);
      await tx.conversationTag.create({ data: { conversationId: tagged, tagId: tag.id } });
      await tx.conversationTag.create({
        data: { conversationId: removed, tagId: tag.id, removedAt: new Date() },
      });
      // Precondition: both campaign rows exist, so the 1 below is the tag narrowing.
      expect(untagged).not.toBe(tagged);

      const both = await report(tx, unitId, { ...query, tagId: tag.id, campaignId: "camp-1" });
      const tagOnly = await report(tx, unitId, { ...query, tagId: tag.id });

      expect(both.newConversationCount).toBe(1);
      expect(tagOnly.newConversationCount).toBe(1);
    }));

  it("drops a message with an unknown direction, so it makes no ativa", () =>
    withTestTransaction(db(), async (tx) => {
      const { unitId, connectionId } = await seedCallerUnit(tx);
      const conversationId = await seedNova(tx, connectionId, { answered: false });
      await message(tx, conversationId, "SIDEWAYS", "2026-08-10T12:00:00.000Z");

      const result = await report(tx, unitId);

      expect(result.activeConversationCount).toBe(0);
    }));

  it("leaves the answered nova out of unanswered and reports respondidas 1 of 2", () =>
    withTestTransaction(db(), async (tx) => {
      const { unitId, connectionId } = await seedCallerUnit(tx);
      const a = await seedNova(tx, connectionId, { answered: false });
      await message(tx, a, "inbound", "2026-08-10T12:00:00.000Z", true);
      const b = await seedNova(tx, connectionId);
      await message(tx, b, "inbound", "2026-08-10T12:00:00.000Z");
      await message(tx, b, "outbound", "2026-08-10T13:00:00.000Z");

      const result = await report(tx, unitId);

      expect(result.respondedRate).toEqual({ answered: 1, total: 2 });
      expect(result.unanswered.items.map((item) => item.conversationId)).toEqual([a]);
    }));

  it("returns zero scheduled counts when the unit has no scheduled rows", () =>
    withTestTransaction(db(), async (tx) => {
      const { unitId, connectionId } = await seedCallerUnit(tx);
      await seedNova(tx, connectionId, { answered: false });

      const result = await report(tx, unitId);

      expect(result.scheduled).toEqual({ scheduled: 0, sent: 0, cancelled: 0, failed: 0 });
    }));

  it("counts a service-only schedule unfiltered, and drops it under a conversation filter", () =>
    withTestTransaction(db(), async (tx) => {
      const { unitId } = await seedCallerUnit(tx);
      const customer = await tx.customer.create({
        data: { name: "Cliente", unitId, origin: "crm", status: "active" },
        select: { id: true },
      });
      const service = await tx.service.create({
        data: { customerId: customer.id, unitId, origin: "crm", performedAt: new Date("2026-08-05T12:00:00.000Z") },
        select: { id: true },
      });
      // No conversation: this row reaches the unit only through its service.
      await tx.scheduledMessage.create({
        data: {
          serviceId: service.id,
          customerId: customer.id,
          frozenText: "retorno",
          scheduledAt: new Date("2026-08-20T12:00:00.000Z"),
          status: "SCHEDULED",
          idempotencyKey: `svc-${randomUUID()}`,
          createdByUserId: CALLER_USER_ID,
        },
      });

      const unfiltered = await report(tx, unitId);
      const filtered = await report(tx, unitId, { ...query, sourceType: "AD" });

      expect(unfiltered.scheduled.scheduled).toBe(1);
      expect(filtered.scheduled.scheduled).toBe(0);
    }));
});

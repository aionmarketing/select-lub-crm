/**
 * Test design (testing-strategy) — what the quote answers for the three dead ends (task 5.9, 5.13)
 *
 * SUT: `GET /vehicles/:id/quote-options` (`getQuoteOptions`, parsed by the response schema, and
 *   over HTTP where the serialization is the point) for an identity whose latest row has no liters,
 *   whose research rests in a conflict, or that is queued for an engine re-read. Ran under module
 *   role: `quotes`, on a rolling-back transaction; the rows are written directly.
 *
 * Oracle: `oil-attendant-fill` (a stored volume prices the next quote, from any vehicle of the
 *   identity, until a cited volume exists); `oil-quote` "The attendant can type a missing fill
 *   volume" and "Disagreeing sources are surfaced, never silently decided"; the `shared-types`
 *   delta "Quote options carry what the attendant needs to resolve a dead end" and "… the research
 *   state" (`engine_pick`); design D24 F1, F2, D12 (as amended), D14.
 *
 * Cells (state | expected | the bug it would miss)
 *   no liters + a kept volume, another vehicle  | options at 4,2, attendantFill, no litersSource | a volume kept per vehicle only
 *   two kept volumes                            | the later one                                   | the first row read
 *   kept volume + a later cited row             | the cited liters                                | a typed volume outranking a source
 *   grade conflict, both stocked                | a card per stocked grade, each its own source, agreed 4 L | every card cited to the top source
 *   grade conflict, nothing stocked             | conflict with empty options                     | an invented card, or a 500
 *   volume conflict                             | volumeChoices, highest authority first          | the lower source first
 *   conflict with cards, Tecfil pending         | filters pending                                 | a conflict whose filters never price
 *   old-shape conflict                          | conflicts only, and a quote-open writes nothing | a backfill of old payloads
 *   grade conflict, no stated volume            | the cards and grades, no volume                 | a dead end with no way out (orchestrator 2026-10-01)
 *   the same, with a kept volume                | attendantFill                                   | a kept volume ignored on a conflict
 *   queued engine_pick                          | researching, engine_pick, the engine, 1–2      | a range shown for a re-read
 */
import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import type { DbClient } from "../../../../kernel/db.js";
import { describeWithDatabase, seedUser } from "../../../../testing/index.js";
import { identityKey } from "../../contracts/oil-research-attention.js";
import { getQuoteOptions } from "../index.js";
import { cacheRow, catalog, itInTx, researchRow, runnerRow, seed, tableCounts } from "./quote-options.fixture.js";

const MANUAL = {
  sourcePublisher: "Toyota",
  sourceDocument: "Manual do proprietário",
  sourcePage: "p. 412",
  sourceAuthority: 1,
  sourceUrl: "https://toyota.com.br/manual.pdf",
  sourceClassification: "manufacturer_manual" as const,
};
const CATALOG = { sourcePublisher: "CarroRac", sourceDocument: "Tabela", sourcePage: "Polo", sourceAuthority: 5, sourceUrl: null, sourceClassification: null };

/** A conflict between the manual (0W-8) and the catalog (0W-12), recorded with its card data. */
type Source = typeof MANUAL | typeof CATALOG;
/** The recorded volume (internal/research/outcome.ts ConflictCardData["volume"]). */
type Volume =
  | { kind: "agreed"; fillLiters: number; fillKind: "em_servico"; fillCondition: "with_filter"; source: Source }
  | { kind: "choices"; choices: { liters: number; fillCondition: "with_filter" | "unlabeled"; source: Source }[] }
  | null;

/** A conflict payload, as research records it (internal/research/outcome.ts ConflictPayload). */
function gradeConflict(volume: Volume) {
  return {
    conflicts: [
      {
        field: "viscosityGrades",
        values: [
          { value: "0W-8", sourcePublisher: MANUAL.sourcePublisher, sourceDocument: MANUAL.sourceDocument, sourcePage: MANUAL.sourcePage, sourceAuthority: 1 },
          { value: "0W-12", sourcePublisher: CATALOG.sourcePublisher, sourceDocument: CATALOG.sourceDocument, sourcePage: CATALOG.sourcePage, sourceAuthority: 5 },
        ],
      },
    ],
    card: {
      viscosityGrades: ["0W-8", "0W-12"],
      classification: "",
      gradeSources: [
        { grade: "0W-8", ...MANUAL },
        { grade: "0W-12", ...CATALOG },
      ],
      volume,
    },
  };
}

/** A kept volume, inserted as the fill-volume route inserts it. */
function keep(tx: DbClient, input: { identity: { make: string; year: number; model: string; version: string }; liters: number; recordedByUserId: string; recordedAt?: Date }) {
  return tx.oilAttendantFill.create({
    data: { id: randomUUID(), identityKey: identityKey(input.identity)!, ...input.identity, liters: input.liters, recordedByUserId: input.recordedByUserId, ...(input.recordedAt ? { recordedAt: input.recordedAt } : {}) },
  });
}

describeWithDatabase("GET quote-options — the attendant's volume", () => {
  itInTx("prices the quote of another vehicle of the identity from the kept volume, flagged as the attendant's", async (tx) => {
    const ctx = await seed(tx);
    const items = await catalog(tx);
    await cacheRow(tx, ctx.identity, { fillLiters: null, fillKind: null });
    const user = await seedUser(tx, { units: [ctx.unitId], name: "Marina" });
    const owner = await tx.vehicle.findUniqueOrThrow({ where: { id: ctx.vehicleId }, select: { customerId: true } });
    const sibling = await tx.vehicle.create({ data: { customerId: owner.customerId, origin: "crm", ...ctx.identity }, select: { id: true } });
    await keep(tx, { identity: ctx.identity, liters: 4.2, recordedByUserId: user.id, recordedAt: new Date("2026-09-21T13:00:00.000Z") });

    const quote = await getQuoteOptions(ctx.db, { vehicleId: sibling.id, unitId: ctx.unitId });

    expect(quote).toMatchObject({
      status: "options",
      fillLiters: 4.2,
      fillKind: "em_servico",
      fillCondition: "with_filter",
      attendantFill: { liters: 4.2, recordedBy: "Marina", recordedAt: "2026-09-21T13:00:00.000Z" },
    });
    expect(quote).not.toHaveProperty("litersSource");
    expect(quote?.status === "options" && quote.options.map((card) => card.id)).toEqual([items.oil.id]);
    // And it serializes through the route's schema.
    expect((await ctx.inject()).body).toMatchObject({ status: "options", attendantFill: { liters: 4.2 } });
  });

  itInTx("reads the later of two kept volumes", async (tx) => {
    const ctx = await seed(tx);
    await catalog(tx);
    await cacheRow(tx, ctx.identity, { fillLiters: null, fillKind: null });
    const user = await seedUser(tx, { units: [ctx.unitId] });
    await keep(tx, { identity: ctx.identity, liters: 4.2, recordedByUserId: user.id, recordedAt: new Date("2026-09-21T13:00:00.000Z") });
    await keep(tx, { identity: ctx.identity, liters: 4.4, recordedByUserId: user.id, recordedAt: new Date("2026-09-22T13:00:00.000Z") });

    expect(await ctx.answer()).toMatchObject({ status: "options", fillLiters: 4.4, attendantFill: { liters: 4.4 } });
    expect(await tx.oilAttendantFill.count({ where: { identityKey: ctx.key } })).toBe(2);
  });

  itInTx("shows a later cited row's liters, not the kept volume", async (tx) => {
    const ctx = await seed(tx);
    await catalog(tx);
    await cacheRow(tx, ctx.identity, { fillLiters: null, fillKind: null, consultedAt: new Date("2026-09-20T12:00:00.000Z") });
    const user = await seedUser(tx, { units: [ctx.unitId] });
    await keep(tx, { identity: ctx.identity, liters: 4.2, recordedByUserId: user.id });
    await cacheRow(tx, ctx.identity, { fillLiters: 4, consultedAt: new Date("2026-09-23T12:00:00.000Z") });

    const quote = await ctx.answer();

    expect(quote).toMatchObject({ status: "options", fillLiters: 4, litersSource: { sourcePublisher: "Volkswagen do Brasil" } });
    expect(quote).not.toHaveProperty("attendantFill");
  });
});

describeWithDatabase("GET quote-options — a conflict with its cards", () => {
  itInTx("offers a card per stocked disputed grade, each citing the source that lists it, with the agreed volume", async (tx) => {
    const ctx = await seed(tx);
    const items = await catalog(tx);
    const twelve = await tx.catalogItem.create({
      data: { id: `oil12-${randomUUID().slice(0, 8)}`, brand: "Motul", description: "8100 0W-12", price: 55, stock: 3, active: true, lubricant: { create: { viscosity: "0W-12" } } },
    });
    const agreed = { kind: "agreed" as const, fillLiters: 4, fillKind: "em_servico" as const, fillCondition: "with_filter" as const, source: MANUAL };
    await researchRow(tx, ctx.identity, { state: "conflicting_sources", outcome: "conflicting_sources", outcomePayload: gradeConflict(agreed), finishedAt: new Date(), priority: 0 });

    const { status, body } = await ctx.inject();

    expect(status).toBe(200);
    expect(body).toMatchObject({ status: "conflicting_sources", viscosityGrades: ["0W-8", "0W-12"], fillLiters: 4, fillCondition: "with_filter", litersSource: MANUAL, filters: { source: "unavailable" } });
    const cards = body.status === "conflicting_sources" ? (body.options ?? []) : [];
    expect(cards.map((card) => [card.id, card.gradeSource.sourcePublisher])).toEqual([
      [items.oil.id, "Toyota"],
      [twelve.id, "CarroRac"],
    ]);
    expect(body).not.toHaveProperty("volumeChoices");
  });

  itInTx("answers empty cards when no disputed grade is stocked", async (tx) => {
    const ctx = await seed(tx);
    const agreed = { kind: "agreed" as const, fillLiters: 4, fillKind: "em_servico" as const, fillCondition: "with_filter" as const, source: MANUAL };
    await researchRow(tx, ctx.identity, { state: "conflicting_sources", outcome: "conflicting_sources", outcomePayload: gradeConflict(agreed), finishedAt: new Date() });

    expect(await ctx.answer()).toMatchObject({ status: "conflicting_sources", options: [], gradeSources: [{ grade: "0W-8" }, { grade: "0W-12" }] });
  });

  itInTx("offers a volume conflict's choices, highest authority first", async (tx) => {
    const ctx = await seed(tx);
    await catalog(tx);
    const choices = {
      kind: "choices" as const,
      choices: [
        { liters: 4.3, fillCondition: "with_filter" as const, source: MANUAL },
        { liters: 4, fillCondition: "unlabeled" as const, source: CATALOG },
      ],
    };
    await researchRow(tx, ctx.identity, { state: "conflicting_sources", outcome: "conflicting_sources", outcomePayload: gradeConflict(choices), finishedAt: new Date() });

    const quote = await ctx.answer();

    expect(quote).toMatchObject({ status: "conflicting_sources", volumeChoices: [{ liters: 4.3, source: { sourcePublisher: "Toyota" } }, { liters: 4, source: { sourcePublisher: "CarroRac" } }] });
    expect(quote).not.toHaveProperty("fillLiters");
  });

  // Orchestrator, 2026-10-01: no source stated a usable volume; the attendant picks the grade and
  // types the volume, as on no_capacity, and a kept volume prices it.
  itInTx("offers a grade conflict no source stated a volume for with its cards and no volume, then with a kept one", async (tx) => {
    const ctx = await seed(tx);
    const items = await catalog(tx);
    await researchRow(tx, ctx.identity, { state: "conflicting_sources", outcome: "conflicting_sources", outcomePayload: gradeConflict(null), finishedAt: new Date() });

    const bare = await ctx.answer();

    expect(bare).toMatchObject({ status: "conflicting_sources", viscosityGrades: ["0W-8", "0W-12"], options: [{ id: items.oil.id, gradeSource: { sourcePublisher: "Toyota" } }] });
    for (const field of ["fillLiters", "litersSource", "volumeChoices", "attendantFill"]) expect(bare).not.toHaveProperty(field);

    const user = await seedUser(tx, { units: [ctx.unitId], name: "Marina" });
    await keep(tx, { identity: ctx.identity, liters: 4.2, recordedByUserId: user.id, recordedAt: new Date("2026-09-21T13:00:00.000Z") });

    expect((await ctx.inject()).body).toMatchObject({ status: "conflicting_sources", attendantFill: { liters: 4.2, recordedBy: "Marina" } });
  });

  itInTx("reports its filters pending while its Tecfil claim is to come", async (tx) => {
    const ctx = await seed(tx);
    await catalog(tx);
    await runnerRow(tx);
    const agreed = { kind: "agreed" as const, fillLiters: 4, fillKind: "em_servico" as const, fillCondition: "with_filter" as const, source: MANUAL };
    await researchRow(tx, ctx.identity, { state: "conflicting_sources", outcome: "conflicting_sources", outcomePayload: gradeConflict(agreed), finishedAt: new Date(), tecfilState: "pending" });

    expect(await ctx.answer()).toMatchObject({ status: "conflicting_sources", filters: { source: "pending", stopped: false } });
  });

  itInTx("answers an old-shape conflict with its values only, and a quote-open queues nothing for it", async (tx) => {
    const ctx = await seed(tx);
    await catalog(tx);
    const { conflicts } = gradeConflict({ kind: "agreed", fillLiters: 4, fillKind: "em_servico", fillCondition: "with_filter", source: MANUAL });
    await researchRow(tx, ctx.identity, { state: "conflicting_sources", outcome: "conflicting_sources", outcomePayload: { conflicts }, finishedAt: new Date(), priority: 2 });
    const before = await tableCounts(tx);

    expect(await ctx.answer()).toEqual({ status: "conflicting_sources", conflicts });
    expect(await tableCounts(tx)).toEqual(before);
  });
});

describeWithDatabase("GET quote-options — an engine re-read under way", () => {
  itInTx("answers researching on the engine_pick path with the engine and the fixed 1–2 minutes", async (tx) => {
    const ctx = await seed(tx);
    await runnerRow(tx);
    const requestedAt = new Date(Date.now() - 20_000);
    await researchRow(tx, ctx.identity, { kind: "engine_pick", trigger: "engine_pick", priority: 0, requestedAt, expectedMinS: 900, expectedMaxS: 1800, enginePickEngine: "1.8 Dual VVT-i", enginePickFrom: "x", enginePickPassages: [] });

    const { body } = await ctx.inject();

    expect(body).toMatchObject({ status: "researching", path: "engine_pick", engine: "1.8 Dual VVT-i", expectedMinutes: { min: 1, max: 2 }, requestedAt: requestedAt.toISOString() });
  });
});

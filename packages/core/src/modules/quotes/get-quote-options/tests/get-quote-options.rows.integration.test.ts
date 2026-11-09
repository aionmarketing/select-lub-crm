/**
 * Test design (testing-strategy) — what a stored cache row yields
 *
 * SUT: `GET /vehicles/:id/quote-options` over HTTP for a verified identity: the cards, their
 *   liters and provenance, and the filter slots, all read from the stored rows. Ran under module
 *   role: `quotes`, on a rolling-back transaction. These are the mapping halves of the former
 *   reuse/refetch cases (task 4.2); what the pipeline writes onto the row is the runner's.
 *
 * Oracle: `oil-quote` "Quote offers only compatible catalog items", "Engine fill liters come from a
 *   retrieved reputable source", "Filter prices come from the Tecfil fitment", "Unresolved filters
 *   never block the quote"; oil-quote-liters-pricing D11 (each grade and the liters cited to their
 *   own source, no excerpt in the body); the #86 regression (an empty classification serializes);
 *   ingest-harvested-manuals D5 and its shared-types delta (the capacity type of the liters, and
 *   a volume a change does not use named on `no_capacity`).
 *
 * Cells (row | expected | the bug it would miss)
 *   one source, 0W-8 + 0W-12 grades | the active 0W-8 card only, 4 L, the citation, consultedAt | an inactive card; a card for an unstocked grade
 *   no liters                        | no_capacity with the stocked card and filters, no volume  | a card priced at one litre; no card to type a volume for (D24)
 *   a dry volume only (D5)           | no_capacity naming it, the card, no volume                | a dry figure priced, or hidden
 *   unlabelled / pre-D5 liters       | the capacity type, from the column or the legend          | a 500 on an old row
 *   no stocked grade                 | empty with the grades                                     | an invented card
 *   empty classification             | 200 with ""                                               | a 500 serialization error
 *   two sources                      | each grade's own source, the liters' own, no excerpt      | everything cited to the top source
 *   a row before grade_sources       | one provenance for every grade and the liters             | a 500 on an old row
 *   Tecfil ZPEL108 + AUTHOMIX ZFOL0108 | both matched, the cross-reference normalized              | a brand compared
 *   no catalog fuel item             | no_catalog_match naming ZGI50/7                            | a number invented
 *   Tecfil lists no fuel filter      | no_fitment                                                | a warning on both types
 *   Tecfil unavailable / unmatched   | the slot sources, with the field                          | unmatched read as pending
 */
import { expect } from "vitest";
import { describeWithDatabase } from "../../../../testing/index.js";
import { cacheRow, catalog, itInTx, researchRow, seed, tecfilRow } from "./quote-options.fixture.js";

const MANUAL = { sourcePublisher: "Volkswagen do Brasil", sourceDocument: "Manual do Proprietário Polo (2021)", sourcePage: "p. 287", sourceAuthority: 1, sourceUrl: null };

describeWithDatabase("GET quote-options — what a cache row yields", () => {
  itInTx("offers the active catalog oil of a listed grade, with the liters, the citation and the row's date", async (tx) => {
    const ctx = await seed(tx);
    const items = await catalog(tx);
    await cacheRow(tx, ctx.identity, { viscosities: ["0W-8", "0W-12"] });
    await tecfilRow(tx, ctx.identity);

    const res = await ctx.inject();

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "options",
      viscosityGrades: ["0W-8", "0W-12"],
      fillLiters: 4,
      fillKind: "em_servico",
      ...MANUAL,
      consultedAt: "2026-09-20T12:00:00.000Z",
      litersSource: MANUAL,
      gradeSources: [{ grade: "0W-8", ...MANUAL }, { grade: "0W-12", ...MANUAL }],
    });
    expect(res.body.status === "options" && res.body.options.map((card) => card.id)).toEqual([items.oil.id]);
    expect(res.body.status === "options" && res.body.options[0]).toMatchObject({ description: "8100 Eco-lite", lubricant: { viscosity: "0W-8" } });
  });

  // add-lubricant-oil-type: shared-types "Lubricant-detail contract" — every card carries its
  // lubricant's oil type, null when it has none, and the response validates against the schema.
  itInTx("carries each card's oil type, null for an untyped oil, and never filters by it", async (tx) => {
    const ctx = await seed(tx);
    const items = await catalog(tx);
    const untyped = await tx.catalogItem.create({
      data: { id: `untyped-${items.oil.id}`, brand: "Gen", description: "Básico", price: 30, stock: 1, active: true, lubricant: { create: { viscosity: "0W-8" } } },
    });
    await cacheRow(tx, ctx.identity);
    await tecfilRow(tx, ctx.identity);

    const res = await ctx.inject();

    expect(res.status).toBe(200);
    const cards = res.body.status === "options" ? res.body.options : [];
    expect(Object.fromEntries(cards.map((card) => [card.id, card.lubricant.oilType]))).toEqual({
      [items.oil.id]: "SINTETICO",
      [untyped.id]: null,
    });
  });

  // D24 (task 5.9): the missing volume carries the stocked cards and the filters, and no volume.
  itInTx("answers no_capacity with its stocked card and filters, and no volume, for a row with grades and no liters", async (tx) => {
    const ctx = await seed(tx);
    const items = await catalog(tx);
    await cacheRow(tx, ctx.identity, { fillLiters: null, fillKind: null });

    const { body } = await ctx.inject();

    expect(body).toMatchObject({ status: "no_capacity", viscosityGrades: ["0W-8"], viscosity: "0W-8", classification: "API SP", consultedAt: "2026-09-20T12:00:00.000Z", filters: { source: "pending" } });
    expect(body.status === "no_capacity" && body.options.map((card) => card.id)).toEqual([items.oil.id]);
    expect(body).not.toHaveProperty("fillLiters");
    expect(body).not.toHaveProperty("litersSource");
  });

  // ingest-harvested-manuals D5: the row's capacity type reaches the answer.
  itInTx("names the dry volume a row recorded, and prices nothing from it", async (tx) => {
    const ctx = await seed(tx);
    await catalog(tx);
    await cacheRow(tx, ctx.identity, { fillLiters: null, fillKind: null, fillCondition: "dry", unusableFillLiters: 3.6 });

    const { body } = await ctx.inject();

    expect(body).toMatchObject({
      status: "no_capacity",
      viscosityGrades: ["0W-8"],
      viscosity: "0W-8",
      classification: "API SP",
      consultedAt: "2026-09-20T12:00:00.000Z",
      unusableFill: { liters: 3.6, condition: "dry" },
    });
    expect(body).not.toHaveProperty("fillLiters");
  });

  itInTx("carries the capacity type of priced liters: unlabelled from its column, with the filter from a row before it", async (tx) => {
    const unlabelled = await seed(tx);
    const older = await seed(tx);
    await catalog(tx);
    await cacheRow(tx, unlabelled.identity, { fillKind: "unlabeled", fillCondition: "unlabeled" });
    await cacheRow(tx, older.identity);

    expect((await unlabelled.inject()).body).toMatchObject({ status: "options", fillLiters: 4, fillKind: "unlabeled", fillCondition: "unlabeled" });
    expect((await older.inject()).body).toMatchObject({ status: "options", fillLiters: 4, fillKind: "em_servico", fillCondition: "with_filter" });
  });

  itInTx("answers empty with the grades when the catalog stocks none of them", async (tx) => {
    const ctx = await seed(tx);
    await catalog(tx);
    await cacheRow(tx, ctx.identity, { viscosities: ["0W-12"], viscosity: "0W-12" });

    expect((await ctx.inject()).body).toEqual({ status: "empty", viscosityGrades: ["0W-12"], viscosity: "0W-12", classification: "API SP", consultedAt: "2026-09-20T12:00:00.000Z" });
  });

  itInTx("serializes a row whose source stated no classification", async (tx) => {
    const ctx = await seed(tx);
    await catalog(tx);
    await cacheRow(tx, ctx.identity, { classification: "" });

    const res = await ctx.inject();

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "options", classification: "" });
  });

  itInTx("cites each grade to the source that lists it and the liters to theirs, with no passage", async (tx) => {
    const ctx = await seed(tx);
    await catalog(tx);
    const catalogSource = { publisher: "CarroRac", document: "Catálogo 2024", page: "Polo", authority: 5, url: "https://carrorac.test/polo", classification: "aftermarket_catalog", excerpt: "0W-8 ou 0W-12, 4 L" };
    await cacheRow(tx, ctx.identity, {
      viscosities: ["0W-8", "0W-12"],
      gradeSources: {
        grades: [
          { publisher: MANUAL.sourcePublisher, document: MANUAL.sourceDocument, page: MANUAL.sourcePage, authority: 1, url: null, classification: "manufacturer_manual", excerpt: "0W-8", grades: ["0W-8"] },
          { ...catalogSource, grades: ["0W-12"] },
        ],
        liters: catalogSource,
      },
    });

    const res = await ctx.inject();

    const shownCatalog = { sourcePublisher: "CarroRac", sourceDocument: "Catálogo 2024", sourcePage: "Polo", sourceAuthority: 5, sourceUrl: "https://carrorac.test/polo" };
    expect(res.body).toMatchObject({ gradeSources: [{ grade: "0W-8", ...MANUAL }, { grade: "0W-12", ...shownCatalog }], litersSource: shownCatalog });
    expect(JSON.stringify(res.body)).not.toContain("0W-8 ou 0W-12, 4 L");
  });

  itInTx("reads a row written before grade_sources as one source for every grade and the liters", async (tx) => {
    const ctx = await seed(tx);
    await catalog(tx);
    await cacheRow(tx, ctx.identity);

    expect((await ctx.inject()).body).toMatchObject({ gradeSources: [{ grade: "0W-8", ...MANUAL }], litersSource: MANUAL });
  });

  itInTx("offers the fitted Tecfil filter and another brand's cross-reference for the oil slot", async (tx) => {
    const ctx = await seed(tx);
    const items = await catalog(tx, { fuel: true });
    await cacheRow(tx, ctx.identity);
    await tecfilRow(tx, ctx.identity);

    const res = await ctx.inject();

    expect(res.body).toMatchObject({
      status: "options",
      filters: { source: "cached", consultedAt: "2026-09-21T12:00:00.000Z", application: { manufacturer: "VOLKSWAGEN", vehicle: "POLO", engine: "1.0 TSI" }, fuel: { status: "matched" } },
    });
    const oil = res.body.status === "options" ? res.body.filters.oil : null;
    expect(oil?.status === "matched" && oil.candidates.map((card) => card.id).sort()).toEqual([items.authomix.id, items.tecfil.id].sort());
  });

  itInTx("names the Tecfil numbers it looked for when the catalog has no fuel item", async (tx) => {
    const ctx = await seed(tx);
    await catalog(tx);
    await cacheRow(tx, ctx.identity);
    await tecfilRow(tx, ctx.identity);

    expect((await ctx.inject()).body).toMatchObject({ filters: { fuel: { status: "no_catalog_match", tecfilNumbers: ["ZGI50/7"] } } });
  });

  itInTx("reports no_fitment for a type Tecfil lists no part for", async (tx) => {
    const ctx = await seed(tx);
    await catalog(tx, { fuel: true });
    await cacheRow(tx, ctx.identity);
    await tecfilRow(tx, ctx.identity, []);

    expect((await ctx.inject()).body).toMatchObject({ filters: { oil: { status: "matched" }, fuel: { status: "no_fitment" } } });
  });

  itInTx("reports a Tecfil consultation that failed as unavailable, retried in the background", async (tx) => {
    const ctx = await seed(tx);
    await catalog(tx);
    await cacheRow(tx, ctx.identity);
    await researchRow(tx, ctx.identity, { state: "verified", outcome: "verified", tecfilState: "unavailable", tecfilDueAt: new Date(Date.now() + 15 * 60_000), finishedAt: new Date("2026-09-20T12:00:00.000Z") });

    expect((await ctx.inject()).body).toMatchObject({ filters: { source: "unavailable", consultedAt: null, application: null, oil: { status: "unavailable" }, fuel: { status: "unavailable" } } });
  });

  itInTx("names the field Tecfil did not match, inventing no fitment", async (tx) => {
    const ctx = await seed(tx);
    await catalog(tx);
    await cacheRow(tx, ctx.identity);
    await researchRow(tx, ctx.identity, { state: "verified", outcome: "verified", tecfilState: "unmatched", tecfilUnmatchedField: "vehicle", finishedAt: new Date("2026-09-20T12:00:00.000Z") });

    expect((await ctx.inject()).body).toMatchObject({ filters: { source: "unmatched", unmatchedField: "vehicle", application: null, oil: { status: "unavailable" } } });
  });

  itInTx("keeps showing a stored fitment whatever the Tecfil state says", async (tx) => {
    const ctx = await seed(tx);
    await catalog(tx);
    await cacheRow(tx, ctx.identity);
    await tecfilRow(tx, ctx.identity);
    await researchRow(tx, ctx.identity, { state: "verified", outcome: "verified", tecfilState: "unavailable", finishedAt: new Date("2026-09-20T12:00:00.000Z") });

    expect((await ctx.inject()).body).toMatchObject({ filters: { source: "cached", consultedAt: "2026-09-21T12:00:00.000Z" } });
  });
});

/**
 * Test design (testing-strategy) — the orchestrator's rulings on the review of #188
 *
 * SUT: `getQuoteOptions` (the slice's entry point) on the rolling-back transaction, module role
 *   `quotes`. The research and runner rows are written directly, so each case states what the
 *   quote-open meets.
 *
 * Oracle: background-oil-research D10/D15 as amended by the orchestrator (review of #188):
 *   1. a quote-open re-opens a no-source recorded `searched: false` only while the runner's fresh
 *      heartbeat says it can web-search — else every 3 s poll re-queued it, uncapped;
 *   2. the filters are `pending` only while a Tecfil claim can still happen (verified, Tecfil
 *      pending or running); otherwise `unavailable`, which does not poll;
 *   3. an adoptable row holds only the manual path (a queued `manual_resolve`, a wait), never a
 *      queued sweep `full` cycle, and never while a later conflict or clarification hides the row.
 *
 * Cells (state met | expected | the bug it would miss)
 *   not searched, search unavailable, three GETs | nothing written, ever        | the poll loop
 *   then the runner reports search available     | re-opened at 0                | a row never re-opened
 *   not searched, runner stale / missing          | nothing written              | a dead runner vouching for a search
 *   research queued, no Tecfil state, a cache row | filters unavailable          | pending forever on a non-verified row
 *   verified, Tecfil ok, no Tecfil row            | filters unavailable          | pending forever on a lost row
 *   adoptable row + queued 2 `full`               | promoted to 0, refresh       | a car stranded behind the backfill
 *   adoptable row + later conflict + upgrade at 1 | promoted to 0, researching   | a hold with no row shown
 *   historical row + wait at 2                    | promoted to 0                | a hold without an adoptable row
 *   (the upgrade at 1 with an adoptable row keeping no refresh is in `states`)
 */
import { expect } from "vitest";
import { describeWithDatabase } from "../../../../testing/index.js";
import { cacheRow, catalog, historicalRow, itInTx, MIN, researchRow, runnerRow, seed, tableCounts } from "./quote-options.fixture.js";

/** A no-source whose stage 1 could not search, recorded a minute ago. */
const NOT_SEARCHED = { state: "no_spec", outcome: "no_spec", searched: false, attempts: 1, finishedAt: new Date(Date.now() - MIN) };

describeWithDatabase("GET quote-options — a no-source that was not searched (ruling 1)", () => {
  itInTx("writes nothing while the runner cannot search, however often the dialog polls", async (tx) => {
    const ctx = await seed(tx);
    await runnerRow(tx, { searchAvailable: false });
    await researchRow(tx, ctx.identity, NOT_SEARCHED);
    const before = await tableCounts(tx);

    for (let poll = 0; poll < 3; poll += 1) {
      expect(await ctx.answer()).toEqual({ status: "no_spec", reason: "no_source" });
    }

    expect(await tableCounts(tx)).toEqual(before);
  });

  itInTx("re-opens it at priority 0 at the next open once the runner reports it can search", async (tx) => {
    const ctx = await seed(tx);
    await runnerRow(tx, { searchAvailable: false });
    await researchRow(tx, ctx.identity, NOT_SEARCHED);
    await ctx.answer();

    await runnerRow(tx, { searchAvailable: true });
    const result = await ctx.answer();

    expect(result.status).toBe("researching");
    expect(await tx.oilResearch.findUniqueOrThrow({ where: { identityKey: ctx.key } })).toMatchObject({ state: "queued", priority: 0, attempts: 0, trigger: "quote_open" });
  });

  itInTx("does not re-open it on a stale runner row that last said it could search", async (tx) => {
    const ctx = await seed(tx);
    await runnerRow(tx, { searchAvailable: true }, 10 * MIN);
    await researchRow(tx, ctx.identity, NOT_SEARCHED);
    const before = await tableCounts(tx);

    await ctx.answer();

    expect(await tableCounts(tx)).toEqual(before);
  });

  itInTx("does not re-open it with no runner row at all", async (tx) => {
    const ctx = await seed(tx);
    await researchRow(tx, ctx.identity, NOT_SEARCHED);
    const before = await tableCounts(tx);

    await ctx.answer();

    expect(await tableCounts(tx)).toEqual(before);
  });
});

describeWithDatabase("GET quote-options — filters pending only while a claim can happen (ruling 2)", () => {
  itInTx("reports unavailable for a row shown while its research is not verified", async (tx) => {
    const ctx = await seed(tx);
    await catalog(tx);
    await cacheRow(tx, ctx.identity);
    await runnerRow(tx);
    await researchRow(tx, ctx.identity, { kind: "manual_resolve", trigger: "manual_upgrade", priority: 1, requestedAt: new Date() });

    expect(await ctx.answer()).toMatchObject({ status: "options", filters: { source: "unavailable", oil: { status: "unavailable" } } });
  });

  itInTx("reports unavailable for a verified row whose Tecfil is ok but whose row does not match", async (tx) => {
    const ctx = await seed(tx);
    await catalog(tx);
    await cacheRow(tx, ctx.identity);
    await runnerRow(tx);
    await researchRow(tx, ctx.identity, { state: "verified", outcome: "verified", tecfilState: "ok", finishedAt: new Date("2026-09-20T12:00:00.000Z") });

    expect(await ctx.answer()).toMatchObject({ status: "options", filters: { source: "unavailable" } });
  });

  itInTx("reports pending, with stopped, for a verified row whose Tecfil is pending or running", async (tx) => {
    for (const tecfilState of ["pending", "running"] as const) {
      const ctx = await seed(tx);
      await catalog(tx);
      await cacheRow(tx, ctx.identity);
      await runnerRow(tx);
      await researchRow(tx, ctx.identity, { state: "verified", outcome: "verified", tecfilState, tecfilLeaseUntil: new Date(Date.now() + 10 * MIN), finishedAt: new Date("2026-09-20T12:00:00.000Z") });

      expect(await ctx.answer()).toMatchObject({ filters: { source: "pending", stopped: false } });
    }
  });
});

describeWithDatabase("GET quote-options — the adoptable-row hold is the manual path's only (ruling 3)", () => {
  itInTx("promotes a queued backfill full cycle to 0 even when an adoptable row is shown", async (tx) => {
    const ctx = await seed(tx);
    await catalog(tx);
    await cacheRow(tx, ctx.identity);
    await runnerRow(tx);
    await researchRow(tx, ctx.identity, { kind: "full", trigger: "backfill", priority: 2, requestedAt: null });
    const now = new Date();

    const result = await ctx.answer(now);

    expect(await tx.oilResearch.findUniqueOrThrow({ where: { identityKey: ctx.key } })).toMatchObject({ state: "queued", kind: "full", priority: 0, requestedAt: now });
    expect(result).toMatchObject({ status: "options", refresh: { requestedAt: now.toISOString() } });
  });

  itInTx("promotes a manual upgrade when a later conflict hides the row, and answers researching", async (tx) => {
    const ctx = await seed(tx);
    await catalog(tx);
    await cacheRow(tx, ctx.identity);
    await runnerRow(tx);
    const conflict = {
      conflicts: [{ field: "fillLiters", values: [{ value: "4", sourcePublisher: "a", sourceDocument: "a", sourcePage: "1", sourceAuthority: 1 }, { value: "5", sourcePublisher: "b", sourceDocument: "b", sourcePage: "1", sourceAuthority: 5 }] }],
    };
    await researchRow(tx, ctx.identity, {
      kind: "manual_resolve",
      trigger: "manual_upgrade",
      priority: 1,
      requestedAt: new Date(Date.now() - MIN),
      outcome: "conflicting_sources",
      outcomePayload: conflict,
      finishedAt: new Date("2026-09-22T12:00:00.000Z"),
    });

    const result = await ctx.answer();

    expect(await tx.oilResearch.findUniqueOrThrow({ where: { identityKey: ctx.key } })).toMatchObject({ state: "queued", priority: 0 });
    expect(result.status).toBe("researching");
  });

  itInTx("promotes a manual wait whose only row is historical, which is not adoptable", async (tx) => {
    const ctx = await seed(tx);
    await historicalRow(tx, ctx.identity);
    await runnerRow(tx);
    await researchRow(tx, ctx.identity, { state: "waiting_manual", kind: "full", priority: 2, requestedAt: null, waitStartedAt: new Date(Date.now() - MIN), manualWaitUntil: new Date(Date.now() + 29 * MIN) });

    await ctx.answer();

    expect(await tx.oilResearch.findUniqueOrThrow({ where: { identityKey: ctx.key } })).toMatchObject({ state: "waiting_manual", priority: 0 });
  });
});

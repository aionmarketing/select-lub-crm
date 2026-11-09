/**
 * Test design (testing-strategy) — the quote answers from the research state (D15)
 *
 * SUT: `GET /vehicles/:id/quote-options` over HTTP (`app.inject`, so every body goes through the
 *   response schema's serializer). Ran under module role: `quotes`. Every row — cache, Tecfil,
 *   research, runner — is written on the rolling-back transaction, so each case states the
 *   research state it answers from; nothing runs the worker and nothing reaches a provider.
 *
 * Oracle: background-oil-research D15's table and its `paused` order, D12 (a Tecfil claim is not
 *   research), D7 (a quote-open with a row to show promotes nothing), the `oil-quote` delta "The
 *   quote answers from the research state and calls no provider", and the `shared-types` delta
 *   "Quote options carry the research state".
 *
 * Cells (D15 row | state | expected | the bug it would miss)
 *   incomplete        | no version, no year   | no_spec incomplete_identity [version, year], no write | "no source" for an unresearched car
 *   no row, queued    | inserted at 0         | researching: requestedAt, the default 1–5 range       | cards; a provider call
 *   rows ahead        | one queued, one running | queuePosition 2                                     | the run in progress not counted
 *   no row, resting   | no_spec / failed / clarification (0 or 1 engine) / conflict | its record   | the old Motul copy; min(2) engines
 *   cached, attended  | queued at 0           | options + refresh                                    | no refresh while a search runs
 *   cached, Tecfil    | Tecfil running only   | options, filters pending, no refresh                 | Tecfil shown as research
 *   cached, upgrade   | manual_upgrade at 1   | options, no refresh, still at 1                      | a quote-open promoting an upgrade
 *   later conflict    | resting / refetch queued | conflicting_sources / researching                 | a newer conflict outvoted by the older row
 *   newer attempt     | no_spec / failed      | options + newerAttempt                               | silence about the newer search
 */
import { expect } from "vitest";
import { describeWithDatabase } from "../../../../testing/index.js";
import { cacheRow, catalog, HOUR, itInTx, MIN, researchRow, runnerRow, seed, tableCounts, tecfilRow } from "./quote-options.fixture.js";

const CONFLICT = {
  conflicts: [
    {
      field: "fillLiters",
      values: [
        { value: "4.3", sourcePublisher: "Volkswagen do Brasil", sourceDocument: "Manual Polo", sourcePage: "p. 287", sourceAuthority: 1 },
        { value: "4", sourcePublisher: "CarroRac", sourceDocument: "tabela", sourcePage: "Polo", sourceAuthority: 5 },
      ],
    },
  ],
};

const RESTING = [
  { state: "no_spec", payload: null, expected: { status: "no_spec", reason: "no_source" } },
  { state: "failed", payload: null, expected: { status: "error" } },
  { state: "needs_clarification", payload: { coverage: "several", options: [] }, expected: { status: "needs_clarification", coverage: "several", options: [] } },
  { state: "needs_clarification", payload: { coverage: "mismatch", options: ["1.6"] }, expected: { status: "needs_clarification", coverage: "mismatch", options: ["1.6"] } },
  { state: "conflicting_sources", payload: CONFLICT, expected: { status: "conflicting_sources", ...CONFLICT } },
] as const;

describeWithDatabase("GET quote-options — D15's rows", () => {
  itInTx("names the missing fields of an incomplete identity, in the dialog's order, and writes nothing", async (tx) => {
    const ctx = await seed(tx, { version: " ", year: null });
    const before = await tableCounts(tx);

    const res = await ctx.inject();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "no_spec", reason: "incomplete_identity", missingFields: ["version", "year"] });
    expect(await tableCounts(tx)).toEqual(before);
  });

  itInTx("answers researching for an uncached identity it queues, with no cards", async (tx) => {
    const ctx = await seed(tx);
    await runnerRow(tx);

    const res = await ctx.inject();

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "researching", expectedMinutes: { min: 1, max: 5 }, queuePosition: 0, path: "search", paused: null });
    expect(res.body).not.toHaveProperty("options");
    const row = await tx.oilResearch.findUniqueOrThrow({ where: { identityKey: ctx.key } });
    expect(row).toMatchObject({ state: "queued", priority: 0, trigger: "quote_open" });
    expect(res.body.status === "researching" && res.body.requestedAt).toBe(row.requestedAt!.toISOString());
  });

  itInTx("counts the rows ahead in claim order, and a run in progress", async (tx) => {
    const ctx = await seed(tx);
    await runnerRow(tx);
    const earlier = new Date(Date.now() - HOUR);
    await researchRow(tx, { make: "Fiat", year: 2022, model: "Argo", version: `ahead ${ctx.key}` }, { priority: 0, requestedAt: earlier });
    await researchRow(tx, { make: "Fiat", year: 2022, model: "Argo", version: `running ${ctx.key}` }, { state: "running", leaseUntil: new Date(Date.now() + 10 * MIN), requestedAt: earlier });

    const res = await ctx.inject();

    expect(res.body).toMatchObject({ status: "researching", queuePosition: 2 });
  });

  for (const { state, payload, expected } of RESTING) {
    itInTx(`answers a resting ${state} with no cache row from its record${payload && "coverage" in payload ? ` (${payload.coverage}, ${payload.options.length} engines)` : ""}`, async (tx) => {
      const ctx = await seed(tx);
      // Finished a minute ago: no quote-open re-runs it yet (D10's windows).
      await researchRow(tx, ctx.identity, { state, outcome: state, outcomePayload: payload ?? undefined, finishedAt: new Date(Date.now() - MIN), priority: 0 });

      const res = await ctx.inject();

      expect(res.status).toBe(200);
      expect(res.body).toEqual(expected);
    });
  }

  itInTx("adds refresh to the row's options while research is attended", async (tx) => {
    const ctx = await seed(tx);
    await catalog(tx);
    await cacheRow(tx, ctx.identity);
    await tecfilRow(tx, ctx.identity);
    await runnerRow(tx);
    const requestedAt = new Date(Date.now() - 2 * MIN);
    await researchRow(tx, ctx.identity, { kind: "refetch", trigger: "refetch", priority: 0, requestedAt, expectedMinS: 180, expectedMaxS: 420 });

    const res = await ctx.inject();

    expect(res.body).toMatchObject({
      status: "options",
      consultedAt: "2026-09-20T12:00:00.000Z",
      refresh: { requestedAt: requestedAt.toISOString(), expectedMinutes: { min: 3, max: 7 }, queuePosition: 0, path: "search", paused: null },
    });
    expect(res.body).not.toHaveProperty("newerAttempt");
  });

  itInTx("shows a verified row whose Tecfil is being consulted with the filters pending, and no refresh", async (tx) => {
    const ctx = await seed(tx);
    await catalog(tx);
    await cacheRow(tx, ctx.identity);
    await runnerRow(tx);
    await researchRow(tx, ctx.identity, { state: "verified", outcome: "verified", tecfilState: "running", tecfilLeaseUntil: new Date(Date.now() + 10 * MIN), finishedAt: new Date("2026-09-20T12:00:00.000Z") });

    const res = await ctx.inject();

    expect(res.body).toMatchObject({ status: "options", filters: { source: "pending", stopped: false, consultedAt: null, application: null } });
    expect(res.body).not.toHaveProperty("refresh");
  });

  itInTx("does not promote a manual upgrade queued at priority 1, nor say a new search is under way", async (tx) => {
    const ctx = await seed(tx);
    await catalog(tx);
    await cacheRow(tx, ctx.identity);
    await tecfilRow(tx, ctx.identity);
    await runnerRow(tx);
    await researchRow(tx, ctx.identity, { kind: "manual_resolve", trigger: "manual_upgrade", priority: 1, requestedAt: new Date(Date.now() - MIN), tecfilState: "ok" });

    const res = await ctx.inject();

    expect(res.body).toMatchObject({ status: "options", filters: { source: "cached" } });
    expect(res.body).not.toHaveProperty("refresh");
    expect(await tx.oilResearch.findUniqueOrThrow({ where: { identityKey: ctx.key } })).toMatchObject({ state: "queued", priority: 1 });
  });

  itInTx("shows a conflict found after the row, not the row's options, while nothing is under way", async (tx) => {
    const ctx = await seed(tx);
    await catalog(tx);
    await cacheRow(tx, ctx.identity);
    await researchRow(tx, ctx.identity, { state: "conflicting_sources", outcome: "conflicting_sources", outcomePayload: CONFLICT, finishedAt: new Date("2026-09-22T12:00:00.000Z") });

    const res = await ctx.inject();

    expect(res.body).toEqual({ status: "conflicting_sources", ...CONFLICT });
  });

  itInTx("answers researching when a refetch runs after that later conflict", async (tx) => {
    const ctx = await seed(tx);
    await catalog(tx);
    await cacheRow(tx, ctx.identity);
    await runnerRow(tx);
    await researchRow(tx, ctx.identity, {
      kind: "refetch",
      trigger: "refetch",
      priority: 0,
      requestedAt: new Date(Date.now() - MIN),
      outcome: "conflicting_sources",
      outcomePayload: CONFLICT,
      finishedAt: new Date("2026-09-22T12:00:00.000Z"),
    });

    expect((await ctx.inject()).body).toMatchObject({ status: "researching", paused: null });
  });

  for (const outcome of ["no_spec", "failed"] as const) {
    itInTx(`keeps the row's options after a newer attempt that ended ${outcome}, and says so`, async (tx) => {
      const ctx = await seed(tx);
      await catalog(tx);
      await cacheRow(tx, ctx.identity);
      await tecfilRow(tx, ctx.identity);
      const finishedAt = new Date(Date.now() - MIN);
      await researchRow(tx, ctx.identity, { state: outcome, outcome, finishedAt, tecfilState: "ok" });

      const res = await ctx.inject();

      expect(res.body).toMatchObject({ status: "options", consultedAt: "2026-09-20T12:00:00.000Z", newerAttempt: { outcome, finishedAt: finishedAt.toISOString() } });
      expect(res.body).not.toHaveProperty("refresh");
    });
  }

  itInTx("strips a stale tab's ?mode=refetch and neither queues a refetch nor fails", async (tx) => {
    const ctx = await seed(tx);
    await catalog(tx);
    await cacheRow(tx, ctx.identity);
    await tecfilRow(tx, ctx.identity);

    const res = await ctx.inject("?mode=refetch");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "options" });
    expect(await tx.oilResearch.findUniqueOrThrow({ where: { identityKey: ctx.key } })).toMatchObject({ state: "verified", trigger: "adopted" });
  });
});

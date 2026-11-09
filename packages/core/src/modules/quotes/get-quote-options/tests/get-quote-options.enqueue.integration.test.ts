/**
 * Test design (testing-strategy) — what opening a quote writes, when it pauses, and what it never calls
 *
 * SUT: `getQuoteOptions` (the slice's entry point) at a stated clock, and the route over HTTP for
 *   the 404s and the provider trap. Ran under module role: `quotes`, on a rolling-back transaction.
 *
 * Oracle: background-oil-research D7 (the one enqueue: adoption, promotion, re-enqueue, Tecfil
 *   promotion; a repeat read writes nothing), D10's re-run policy, D14 (`requested_at` and the
 *   stored estimate), D15's `paused` order (`stopped`, then a future `retryAt`, no budget reason),
 *   and the `oil-quote` delta "Opening a quote calls no provider".
 *
 * Cells
 *   adoption          | a provenance row, no research row | options, verified/adopted, Tecfil ok, no refresh | a research queued for a cached car
 *   historical row    | queued for the backfill           | promoted to 0 with requested_at; no_capacity + refresh; a second read writes nothing
 *   backfill promote  | uncached, queued at 2             | 0, requested_at and the estimate stored; a second read writes nothing
 *   Tecfil promotion  | verified, Tecfil pending at 2     | priority 0, state and attempts untouched
 *   re-run rules      | no_spec 1 d / 8 d, not searched, failed 1 h / 25 h, clarification, conflict | reopened or not
 *   paused            | stale beat alone; stale + live lease; stale + live Tecfil lease; a past
 *                       retryAt; a future one; a provider pause; a budget pause; a budget of 0
 *   404               | another unit's vehicle, an unknown id | 404, nothing written
 *   no provider       | fetch trapped to throw across every status | every status answers, fetch never called
 */
import { afterEach, expect, vi } from "vitest";
import { describeWithDatabase } from "../../../../testing/index.js";
import { cacheRow, catalog, HOUR, historicalRow, itInTx, MIN, researchRow, runnerRow, seed, tableCounts, tecfilRow } from "./quote-options.fixture.js";

const DAY = 24 * HOUR;

const CONFLICT = {
  conflicts: [
    {
      field: "fillLiters",
      values: [
        { value: "4", sourcePublisher: "a", sourceDocument: "a", sourcePage: "1", sourceAuthority: 1 },
        { value: "5", sourcePublisher: "b", sourceDocument: "b", sourcePage: "1", sourceAuthority: 5 },
      ],
    },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describeWithDatabase("GET quote-options — the one enqueue", () => {
  itInTx("adopts a cached identity with no research row: options, no refresh, nothing queued", async (tx) => {
    const ctx = await seed(tx);
    await catalog(tx);
    await cacheRow(tx, ctx.identity);
    await tecfilRow(tx, ctx.identity);
    await runnerRow(tx);

    const result = await ctx.answer();

    expect(result).toMatchObject({ status: "options", filters: { source: "cached" } });
    expect(result).not.toHaveProperty("refresh");
    expect(await tx.oilResearch.findUniqueOrThrow({ where: { identityKey: ctx.key } })).toMatchObject({
      state: "verified",
      trigger: "adopted",
      tecfilState: "ok",
      requestedAt: null,
      sourcesReadAt: new Date("2026-09-20T12:00:00.000Z"),
    });
    expect(await tx.oilResearchRun.count()).toBe(0);
  });

  itInTx("promotes a historical row's backfill research to the front, shows the row, and writes nothing on a second read", async (tx) => {
    const ctx = await seed(tx);
    // A stocked grade: a missing volume with no card would answer empty (D24).
    await catalog(tx);
    await historicalRow(tx, ctx.identity);
    await runnerRow(tx);
    await researchRow(tx, ctx.identity, { priority: 2, trigger: "backfill", requestedAt: null });
    const now = new Date();

    const first = await ctx.answer(now);

    expect(first).toMatchObject({ status: "no_capacity", viscosityGrades: ["0W-8"], consultedAt: "2026-08-01T12:00:00.000Z", refresh: { requestedAt: now.toISOString(), paused: null } });
    const row = await tx.oilResearch.findUniqueOrThrow({ where: { identityKey: ctx.key } });
    expect(row).toMatchObject({ state: "queued", priority: 0, trigger: "quote_open", requestedAt: now });
    const before = await tableCounts(tx);
    await ctx.answer(new Date(now.getTime() + 3_000));
    expect(await tableCounts(tx)).toEqual(before);
  });

  itInTx("promotes an uncached backfill row with requested_at and the stored estimate, then writes nothing", async (tx) => {
    const ctx = await seed(tx);
    await runnerRow(tx);
    await researchRow(tx, ctx.identity, { priority: 2, trigger: "backfill", requestedAt: null, queuedAt: new Date(Date.now() - 3 * DAY), cycleQueuedAt: new Date(Date.now() - 3 * DAY) });
    const now = new Date();

    const result = await ctx.answer(now);

    expect(result).toMatchObject({ status: "researching", requestedAt: now.toISOString(), expectedMinutes: { min: 1, max: 5 } });
    expect(await tx.oilResearch.findUniqueOrThrow({ where: { identityKey: ctx.key } })).toMatchObject({ priority: 0, requestedAt: now, expectedMinS: 60, expectedMaxS: 300 });
    const before = await tableCounts(tx);
    await ctx.answer(new Date(now.getTime() + 3_000));
    expect(await tableCounts(tx)).toEqual(before);
  });

  itInTx("moves a verified row's pending Tecfil claim to the front, leaving the spec alone", async (tx) => {
    const ctx = await seed(tx);
    await catalog(tx);
    await cacheRow(tx, ctx.identity);
    await runnerRow(tx);
    await researchRow(tx, ctx.identity, { state: "verified", outcome: "verified", trigger: "adopted", priority: 2, attempts: 1, tecfilState: "pending", finishedAt: new Date("2026-09-20T12:00:00.000Z") });

    const result = await ctx.answer();

    expect(result).toMatchObject({ status: "options", filters: { source: "pending", stopped: false } });
    expect(result).not.toHaveProperty("refresh");
    expect(await tx.oilResearch.findUniqueOrThrow({ where: { identityKey: ctx.key } })).toMatchObject({ state: "verified", priority: 0, attempts: 1, tecfilState: "pending" });
  });

  const RERUN = [
    { name: "no_spec a day ago stays resting", state: "no_spec", ago: DAY, searched: true, reopened: false },
    { name: "no_spec eight days ago is queued again", state: "no_spec", ago: 8 * DAY, searched: true, reopened: true },
    { name: "no_spec not searched is queued again at once", state: "no_spec", ago: MIN, searched: false, reopened: true },
    { name: "failed an hour ago stays failed", state: "failed", ago: HOUR, searched: true, reopened: false },
    { name: "failed 25 hours ago is queued again with its attempts reset", state: "failed", ago: 25 * HOUR, searched: true, reopened: true },
    { name: "a clarification a month ago stays", state: "needs_clarification", ago: 30 * DAY, searched: true, reopened: false },
    { name: "a conflict a month ago stays", state: "conflicting_sources", ago: 30 * DAY, searched: true, reopened: false },
  ] as const;
  for (const rule of RERUN) {
    itInTx(`re-run policy: ${rule.name}`, async (tx) => {
      const ctx = await seed(tx);
      await runnerRow(tx);
      const payload = rule.state === "needs_clarification" ? { coverage: "several", options: [] } : rule.state === "conflicting_sources" ? CONFLICT : undefined;
      await researchRow(tx, ctx.identity, { state: rule.state, outcome: rule.state, outcomePayload: payload, searched: rule.searched, attempts: 3, finishedAt: new Date(Date.now() - rule.ago) });

      const result = await ctx.answer();

      const row = await tx.oilResearch.findUniqueOrThrow({ where: { identityKey: ctx.key } });
      if (rule.reopened) {
        expect(row).toMatchObject({ state: "queued", priority: 0, attempts: 0, trigger: "quote_open" });
        expect(result.status).toBe("researching");
      } else {
        expect(row).toMatchObject({ state: rule.state, attempts: 3 });
        expect(result.status).not.toBe("researching");
      }
    });
  }
});

describeWithDatabase("GET quote-options — the pause, in D15's order", () => {
  /** An uncached identity queued at 0, its answer under `runner`, with `extra` on the research row. */
  async function pausedWith(tx: Parameters<typeof seed>[0], runner: () => Promise<unknown>, extra: Record<string, unknown> = {}) {
    const ctx = await seed(tx);
    await runner();
    await researchRow(tx, ctx.identity, { priority: 0, requestedAt: new Date(Date.now() - MIN), ...extra });
    const result = await ctx.answer();
    if (result.status !== "researching") throw new Error(`expected researching, got ${result.status}`);
    return result.paused;
  }

  itInTx("no runner row is stopped", async (tx) => {
    expect(await pausedWith(tx, async () => undefined)).toEqual({ reason: "stopped" });
  });

  itInTx("a heartbeat older than three minutes, with no live lease, is stopped", async (tx) => {
    expect(await pausedWith(tx, () => runnerRow(tx, {}, 10 * MIN))).toEqual({ reason: "stopped" });
  });

  itInTx("a stale heartbeat while another identity runs under an unexpired lease is not stopped", async (tx) => {
    const paused = await pausedWith(tx, async () => {
      await runnerRow(tx, {}, 10 * MIN);
      await researchRow(tx, { make: "Fiat", year: 2022, model: "Argo", version: `lease ${Date.now()}` }, { state: "running", leaseUntil: new Date(Date.now() + 5 * MIN) });
    });
    expect(paused).toBeNull();
  });

  itInTx("a stale heartbeat while a Tecfil claim holds an unexpired lease is not stopped", async (tx) => {
    const paused = await pausedWith(tx, async () => {
      await runnerRow(tx, {}, 10 * MIN);
      await researchRow(tx, { make: "Fiat", year: 2022, model: "Argo", version: `tecfil ${Date.now()}` }, { state: "verified", tecfilState: "running", tecfilLeaseUntil: new Date(Date.now() + 5 * MIN) });
    });
    expect(paused).toBeNull();
  });

  itInTx("a provider pause is stopped", async (tx) => {
    expect(await pausedWith(tx, () => runnerRow(tx, { pausedReason: "provider", pausedUntil: new Date(Date.now() + 10 * MIN) }))).toEqual({ reason: "stopped" });
  });

  itInTx("a missing key is stopped", async (tx) => {
    expect(await pausedWith(tx, () => runnerRow(tx, { keySet: false, pausedReason: "no_key" }))).toEqual({ reason: "stopped" });
  });

  itInTx("a retry still due in the future is retrying, with its time", async (tx) => {
    const retryAt = new Date(Date.now() + 5 * MIN);
    expect(await pausedWith(tx, () => runnerRow(tx), { attempts: 1, dueAt: retryAt })).toEqual({ reason: "retrying", retryAt: retryAt.toISOString() });
  });

  itInTx("a retry already due is not retrying", async (tx) => {
    expect(await pausedWith(tx, () => runnerRow(tx), { attempts: 1, dueAt: new Date(Date.now() - MIN) })).toBeNull();
  });

  itInTx("a runner paused by the budget answers an attended identity with no pause", async (tx) => {
    const until = new Date(Date.now() + 6 * HOUR);
    expect(await pausedWith(tx, () => runnerRow(tx, { pausedReason: "budget", pausedUntil: until, daySpendUsd: 1.2, budgetUsd: 1 }))).toBeNull();
  });

  itInTx("a budget of 0 answers an attended identity with no pause", async (tx) => {
    expect(await pausedWith(tx, () => runnerRow(tx, { pausedReason: "budget", pausedUntil: new Date(Date.now() + HOUR), daySpendUsd: 0, budgetUsd: 0 }))).toBeNull();
  });

  itInTx("a pending Tecfil carries stopped while research is not running", async (tx) => {
    const ctx = await seed(tx);
    await catalog(tx);
    await cacheRow(tx, ctx.identity);

    expect(await ctx.answer()).toMatchObject({ status: "options", filters: { source: "pending", stopped: true } });
  });
});

describeWithDatabase("GET quote-options — scope, and no provider", () => {
  itInTx("answers 404 for another unit's vehicle and an unknown id, and writes nothing", async (tx) => {
    const ctx = await seed(tx);
    const before = await tableCounts(tx);

    const foreign = await ctx.app.inject({ method: "GET", url: `/vehicles/${ctx.foreignVehicleId}/quote-options` });
    const unknown = await ctx.app.inject({ method: "GET", url: "/vehicles/no-such-vehicle/quote-options" });

    expect([foreign.statusCode, unknown.statusCode]).toEqual([404, 404]);
    expect(foreign.json()).toEqual({});
    expect(await tableCounts(tx)).toEqual(before);
  });

  itInTx("answers every status with a fetch that throws when called, and never calls it", async (tx) => {
    // Every provider the old quote path reached — Motul, Tecfil, the web search and OpenAI —
    // goes through `fetch`. Trapped here, a quote that reached any of them would fail or count.
    const trap = vi.fn(async () => {
      throw new Error("the quote path must not call a provider");
    });
    vi.stubGlobal("fetch", trap);
    const seen = new Set<string>();

    const uncached = await seed(tx);
    seen.add((await uncached.inject()).body.status);
    const incomplete = await seed(tx, { make: null });
    seen.add((await incomplete.inject()).body.status);
    for (const state of ["no_spec", "failed", "needs_clarification", "conflicting_sources"] as const) {
      const ctx = await seed(tx);
      const payload = state === "needs_clarification" ? { coverage: "several", options: [] } : state === "conflicting_sources" ? CONFLICT : undefined;
      await researchRow(tx, ctx.identity, { state, outcome: state, outcomePayload: payload, finishedAt: new Date(Date.now() - MIN) });
      seen.add((await ctx.inject()).body.status);
    }
    await catalog(tx);
    const cached = await seed(tx);
    await cacheRow(tx, cached.identity);
    seen.add((await cached.inject()).body.status);
    const empty = await seed(tx);
    await cacheRow(tx, empty.identity, { viscosities: ["0W-12"], viscosity: "0W-12" });
    seen.add((await empty.inject()).body.status);
    const noCapacity = await seed(tx);
    await cacheRow(tx, noCapacity.identity, { fillLiters: null, fillKind: null });
    seen.add((await noCapacity.inject()).body.status);

    expect([...seen].sort()).toEqual(["conflicting_sources", "empty", "error", "needs_clarification", "no_capacity", "no_spec", "options", "researching"]);
    expect(trap).not.toHaveBeenCalled();
  });
});

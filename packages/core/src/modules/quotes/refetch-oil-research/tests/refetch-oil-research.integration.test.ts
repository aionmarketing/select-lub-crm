/**
 * Test design (testing-strategy) — "Buscar novamente" is a POST that enqueues (D16)
 *
 * SUT: `POST /vehicles/:id/oil-research/refetch` over HTTP (`app.inject`, so the body goes through
 *   the response schema), mounted alone on the rolling-back transaction. Ran under module role:
 *   `quotes`. The research row is written directly, so each case states what the refetch meets.
 *
 * Oracle: background-oil-research D16 and D7's table for a `refetch`; the `oil-quote` delta
 *   "Buscar novamente asks for a new research"; the `shared-types` delta "The refetch route SHALL
 *   answer with a body of this same union". That the claimed refetch searches the web whatever the
 *   miss window says, and that the budget pause does not hold it, is the runner's
 *   (`packages/core/test/oil-research-quote-path.live.test.ts`).
 *
 * Cells (the row met | expected | the bug it would miss)
 *   verified, cached       | queued refetch at 0, attempts 0; options + refresh        | a GET that forces a search; no progress shown
 *   refetch already queued | nothing written                                         | a second research
 *   manual_resolve queued  | it becomes the refetch, due now, attempts 0             | a re-resolve that skips the web
 *   full running           | pending_kind refetch at 0; state, attempts, lease kept   | a run's result destroyed, or the refetch lost
 *   waiting_manual (full)  | a queued refetch at 0                                   | a wait that outlasts the click
 *   resting clarification  | a new cycle; researching                                | a clarification only a version edit can clear
 *   budget pause           | researching with no pause                                | a budget sentence for attended research
 *   another unit / unknown | 404, nothing written                                     | a confirmed foreign vehicle
 */
import { randomUUID } from "node:crypto";
import { prisma, type PrismaClient } from "@select-lub/core/db";
import { expect, it } from "vitest";
import { createDb, type DbClient } from "../../../../kernel/db.js";
import { registerSlice } from "../../../../kernel/http.js";
import { buildSliceApp, describeWithDatabase, runInTransactionOnTx, seedUnit, withTestTransaction } from "../../../../testing/index.js";
import { quoteOptionsResultSchema } from "../../contracts/http.js";
import { identityKey } from "../../contracts/oil-research-attention.js";
import { route } from "../index.js";

const MIN = 60_000;

function itInTx(name: string, fn: (tx: DbClient) => Promise<void>) {
  it(name, () => withTestTransaction(prisma as PrismaClient, fn));
}

/** A unit with a vehicle of a fresh identity, one in another unit, and the slice mounted. */
async function seed(tx: DbClient) {
  const identity = { make: "Volkswagen", year: 2021, model: "Gol", version: `1.0 ${randomUUID().slice(0, 8)}` };
  const unit = await seedUnit(tx);
  const other = await seedUnit(tx);
  const customer = await tx.customer.create({ data: { name: "Ana", unitId: unit.id, origin: "manual", status: "active" }, select: { id: true } });
  const outsider = await tx.customer.create({ data: { name: "Outra", unitId: other.id, origin: "manual", status: "active" }, select: { id: true } });
  const vehicle = await tx.vehicle.create({ data: { customerId: customer.id, origin: "crm", ...identity }, select: { id: true } });
  const foreign = await tx.vehicle.create({ data: { customerId: outsider.id, origin: "crm", ...identity }, select: { id: true } });
  const app = await buildSliceApp({
    db: createDb(tx, runInTransactionOnTx(tx)),
    plugin: (a) => registerSlice(a, "quotes", "refetch-oil-research", route()),
    caller: { userId: "attendant", unitId: unit.id, unitIds: [unit.id, other.id] },
  });
  const key = identityKey(identity)!;
  const post = async (vehicleId = vehicle.id) => {
    const res = await app.inject({ method: "POST", url: `/vehicles/${vehicleId}/oil-research/refetch` });
    return { status: res.statusCode, body: res.json() as unknown };
  };
  const row = () => tx.oilResearch.findUniqueOrThrow({ where: { identityKey: key } });
  const research = (data: Record<string, unknown>) => {
    const queuedAt = new Date(Date.now() - 10 * MIN);
    return tx.oilResearch.create({ data: { id: randomUUID(), identityKey: key, ...identity, trigger: "quote_open", queuedAt, cycleQueuedAt: queuedAt, ...data } });
  };
  const runner = (data: Record<string, unknown> = {}) =>
    tx.oilResearchRunner.upsert({ where: { id: "runner" }, create: { id: "runner", lastSeenAt: new Date(), keySet: true, ...data }, update: { lastSeenAt: new Date(), keySet: true, ...data } });
  return { identity, key, foreignId: foreign.id, post, row, research, runner };
}

describeWithDatabase("POST /vehicles/:id/oil-research/refetch", () => {
  itInTx("queues a refetch of a verified, cached car at the front and answers its options with the new search", async (tx) => {
    const ctx = await seed(tx);
    await ctx.runner();
    await tx.motulCompatibility.create({
      data: { ...ctx.identity, viscosities: ["0W-8"], viscosity: "0W-8", classification: "", fillLiters: 4, fillKind: "em_servico", sourcePublisher: "VW", sourceDocument: "Manual", sourcePage: "p. 1", consultedAt: new Date("2026-09-20T12:00:00.000Z") },
    });
    await ctx.research({ state: "verified", outcome: "verified", trigger: "adopted", priority: 2, attempts: 1, tecfilState: "ok", finishedAt: new Date("2026-09-20T12:00:00.000Z") });

    const res = await ctx.post();

    expect(res.status).toBe(200);
    expect(quoteOptionsResultSchema.parse(res.body)).toMatchObject({ status: "empty", consultedAt: "2026-09-20T12:00:00.000Z", refresh: { queuePosition: 0, paused: null } });
    expect(await ctx.row()).toMatchObject({ state: "queued", kind: "refetch", trigger: "refetch", priority: 0, attempts: 0, dueAt: null, tecfilAttempts: 0 });
  });

  itInTx("queues nothing more while a refetch is already queued", async (tx) => {
    const ctx = await seed(tx);
    await ctx.runner();
    await ctx.research({ kind: "refetch", trigger: "refetch", priority: 0, requestedAt: new Date(Date.now() - MIN) });
    const before = await ctx.row();

    const res = await ctx.post();

    expect(quoteOptionsResultSchema.parse(res.body)).toMatchObject({ status: "researching" });
    expect(await ctx.row()).toEqual(before);
  });

  itInTx("turns a queued manual re-resolve into the refetch, which searches the web", async (tx) => {
    const ctx = await seed(tx);
    await ctx.runner();
    await ctx.research({ kind: "manual_resolve", trigger: "wait_ended", priority: 1, attempts: 1, dueAt: new Date(Date.now() + 5 * MIN), requestedAt: new Date(Date.now() - 5 * MIN) });

    await ctx.post();

    expect(await ctx.row()).toMatchObject({ state: "queued", kind: "refetch", trigger: "refetch", priority: 0, attempts: 0, dueAt: null });
    expect(await tx.oilResearch.count({ where: { identityKey: ctx.key } })).toBe(1);
  });

  itInTx("gives a running full research the refetch as its pending cycle, leaving the run alone", async (tx) => {
    const ctx = await seed(tx);
    await ctx.runner();
    const leaseUntil = new Date(Date.now() + 10 * MIN);
    await ctx.research({ state: "running", kind: "full", priority: 2, trigger: "backfill", attempts: 1, leaseUntil, currentRunId: "run-1", startedAt: new Date(Date.now() - MIN) });

    const res = await ctx.post();

    expect(quoteOptionsResultSchema.parse(res.body)).toMatchObject({ status: "researching", queuePosition: 0 });
    expect(await ctx.row()).toMatchObject({ state: "running", kind: "full", attempts: 1, leaseUntil, currentRunId: "run-1", pendingKind: "refetch", pendingPriority: 0 });
  });

  itInTx("ends a manual wait in a queued refetch", async (tx) => {
    const ctx = await seed(tx);
    await ctx.runner();
    await ctx.research({ state: "waiting_manual", kind: "full", priority: 0, requestedAt: new Date(Date.now() - 5 * MIN), waitStartedAt: new Date(Date.now() - MIN), manualWaitUntil: new Date(Date.now() + 29 * MIN) });

    await ctx.post();

    expect(await ctx.row()).toMatchObject({ state: "queued", kind: "refetch", priority: 0, attempts: 0, waitStartedAt: null });
  });

  itInTx("re-opens a resting clarification, which only a refetch or a manual upgrade may do", async (tx) => {
    const ctx = await seed(tx);
    await ctx.runner();
    await ctx.research({ state: "needs_clarification", outcome: "needs_clarification", outcomePayload: { coverage: "several", options: [] }, attempts: 2, finishedAt: new Date(Date.now() - MIN) });

    const res = await ctx.post();

    expect(quoteOptionsResultSchema.parse(res.body)).toMatchObject({ status: "researching", paused: null });
    expect(await ctx.row()).toMatchObject({ state: "queued", kind: "refetch", priority: 0, attempts: 0 });
  });

  itInTx("answers researching with no pause while the backfill is paused by the budget", async (tx) => {
    const ctx = await seed(tx);
    await ctx.runner({ pausedReason: "budget", pausedUntil: new Date(Date.now() + 6 * 60 * MIN), daySpendUsd: 1.5, budgetUsd: 1 });

    const res = await ctx.post();

    expect(quoteOptionsResultSchema.parse(res.body)).toMatchObject({ status: "researching", paused: null });
  });

  itInTx("answers 404 for another unit's vehicle and an unknown id, and queues nothing", async (tx) => {
    const ctx = await seed(tx);

    expect((await ctx.post(ctx.foreignId)).status).toBe(404);
    expect((await ctx.post("no-such-vehicle")).status).toBe(404);
    expect(await tx.oilResearch.count({ where: { identityKey: ctx.key } })).toBe(0);
  });
});

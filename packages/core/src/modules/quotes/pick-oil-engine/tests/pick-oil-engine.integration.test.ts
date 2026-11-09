/**
 * Test design (testing-strategy) — the engine pick's route and its enqueue (task 5.13)
 *
 * SUT: `POST /vehicles/:id/oil-research/engine-pick` over HTTP (`app.inject`, so the body and the
 *   answers go through the route's schemas), mounted with a fake Omie on the rolling-back
 *   transaction; the version write runs through the customers contract under `customers`, the
 *   enqueue under `quotes`. The research rows are written directly, so each case states what the
 *   pick meets.
 *
 * Oracle: `oil-research` "An engine pick re-reads the stored source for one engine" (the order, G1,
 *   G2, the refusals); the `shared-types` delta (409 `not_clarification` / `engine_not_named`, 422
 *   `version_too_long`, `researching` with `path: "engine_pick"` and 1–2 minutes);
 *   `customer-vehicles` "The quote's engine pick corrects the version"; design D7, D24.
 *
 * Cells (the row met | expected | the bug it would miss)
 *   no clarification / engine not named / too long | 409, 409, 422; nothing written or queued | a pick on any state; a guessed engine
 *   "XEi" + "1.8 Dual VVT-i" (PLACA)  | "XEi 1.8 Dual VVT-i", origin CRM; engine_pick at 0 with the passages; researching engine_pick 1–2 | the trim lost; a PLACA mark kept; a new research
 *   "XEi 1.0" + "1.6"                 | "XEi 1.6"                                 | "XEi 1.0 1.6"
 *   the earlier identity, a sibling   | both untouched                            | the clarification overwritten
 *   no passages (G1)                  | a full research at 0, the normal state    | a re-read of nothing
 *   corrected identity verified (G2)  | its options, nothing queued               | a paid run on a verified car
 *   queued full at 2 / manual_resolve | the engine_pick at 0 with the passages    | the pick lost behind the backfill
 *   queued refetch                    | stays a refetch, at 0                     | a refetch downgraded
 *   running                           | kept, at 0, pending_kind unchanged        | a run's result destroyed
 *   resting no_spec                   | a new engine_pick cycle, reopened         | a resting row the pick cannot reach
 *   the version write fails           | 500, the version unchanged, the row stays | a pick lost on a transient write
 */
import { randomUUID } from "node:crypto";
import { prisma, type PrismaClient } from "@select-lub/core/db";
import { expect, it } from "vitest";
import { createFakeOmie } from "../../../../kernel/clients/erp-mock.js";
import { createDb, type Db, type DbClient } from "../../../../kernel/db.js";
import { registerSlice } from "../../../../kernel/http.js";
import { buildSliceApp, describeWithDatabase, runInTransactionOnTx, seedUnit, seedUser, withTestTransaction } from "../../../../testing/index.js";
import { quoteOptionsResultSchema } from "../../contracts/http.js";
import { identityKey } from "../../contracts/oil-research-attention.js";
import { pickOilEngine, route } from "../index.js";

const MIN = 60_000;

function itInTx(name: string, fn: (tx: DbClient) => Promise<void>) {
  it(name, () => withTestTransaction(prisma as PrismaClient, fn));
}

/** A passage as a clarification keeps it (internal/research/outcome.ts StoredPassage). */
const PASSAGE = {
  publisher: "toyota.com.br",
  document: "Manual do proprietário Corolla 2019",
  page: "p. 412",
  url: "https://toyota.com.br/corolla-2019.pdf",
  tier: 1,
  classification: "manufacturer_manual",
  excerpt: "1.8 Dual VVT-i: 0W-20, 4,2 L com filtro. 2.0 Dynamic Force: 0W-16, 4,4 L com filtro.",
} as const;

/**
 * A unit with a vehicle whose version is `version` (a fresh trim each run), a sibling of the same
 * identity, the clarification on that identity, and the slice mounted.
 */
async function seed(tx: DbClient, options: { version?: string; passages?: (typeof PASSAGE)[]; failVersionWrite?: boolean; placa?: boolean } = {}) {
  const tag = randomUUID().slice(0, 6);
  const identity = { make: "Toyota", year: 2019, model: `Corolla ${tag}`, version: options.version ?? "XEi" };
  const unit = await seedUnit(tx);
  const user = await seedUser(tx, { units: [unit.id] });
  const customer = await tx.customer.create({ data: { name: "Ana", unitId: unit.id, origin: "manual", status: "active" }, select: { id: true } });
  const vehicle = await tx.vehicle.create({ data: { customerId: customer.id, origin: "crm", ...identity }, select: { id: true } });
  const sibling = await tx.vehicle.create({ data: { customerId: customer.id, origin: "crm", ...identity }, select: { id: true } });
  if (options.placa) {
    await tx.vehicleFieldSync.create({ data: { vehicleId: vehicle.id, fieldKey: "version", origin: "PLACA", localVersion: 1 } });
  }
  const key = identityKey(identity)!;
  const queuedAt = new Date(Date.now() - 30 * MIN);
  const clarification = await tx.oilResearch.create({
    data: {
      id: randomUUID(),
      identityKey: key,
      ...identity,
      state: "needs_clarification",
      outcome: "needs_clarification",
      outcomePayload: { coverage: "several", options: ["1.8 Dual VVT-i", "2.0 Dynamic Force"], ...(options.passages === undefined ? { passages: [PASSAGE] } : options.passages.length ? { passages: options.passages } : {}) },
      trigger: "quote_open",
      queuedAt,
      cycleQueuedAt: queuedAt,
      finishedAt: new Date(Date.now() - 20 * MIN),
    },
  });
  const inner = createDb(tx, runInTransactionOnTx(tx));
  const db: Db = options.failVersionWrite
    ? { ...inner, tx: (module, fn, runner) => (module === "customers" ? Promise.reject(new Error("customers down")) : inner.tx(module, fn, runner)) }
    : inner;
  const app = await buildSliceApp({
    db,
    plugin: (a) => registerSlice(a, "quotes", "pick-oil-engine", route({ omieAdapter: createFakeOmie() })),
    caller: { userId: user.id, unitId: unit.id },
  });
  const pick = async (engine: string, vehicleId = vehicle.id) => {
    const res = await app.inject({ method: "POST", url: `/vehicles/${vehicleId}/oil-research/engine-pick`, payload: { engine } });
    return { status: res.statusCode, body: res.json() as unknown };
  };
  const corrected = (version: string) => identityKey({ ...identity, version })!;
  const research = (k: string) => tx.oilResearch.findUnique({ where: { identityKey: k } });
  const version = async (id = vehicle.id) => (await tx.vehicle.findUniqueOrThrow({ where: { id } })).version;
  return { identity, key, clarification, vehicleId: vehicle.id, siblingId: sibling.id, unitId: unit.id, inner, pick, corrected, research, version };
}

describeWithDatabase("POST /vehicles/:id/oil-research/engine-pick — the refusals", () => {
  itInTx("answers 409 not_clarification when the identity does not rest in one, and writes nothing", async (tx) => {
    const ctx = await seed(tx);
    await tx.oilResearch.update({ where: { id: ctx.clarification.id }, data: { state: "no_spec", outcome: "no_spec" } });
    const before = await tx.oilResearch.count();

    expect(await ctx.pick("1.8 Dual VVT-i")).toEqual({ status: 409, body: { reason: "not_clarification" } });
    expect(await tx.oilResearch.count()).toBe(before);
    expect(await ctx.version()).toBe("XEi");
  });

  itInTx("answers 409 engine_not_named for an engine the clarification did not name, and writes nothing", async (tx) => {
    const ctx = await seed(tx);
    const before = await tx.oilResearch.count();

    expect(await ctx.pick("1.6")).toEqual({ status: 409, body: { reason: "engine_not_named" } });
    expect(await tx.oilResearch.count()).toBe(before);
    expect(await ctx.version()).toBe("XEi");
  });

  itInTx("answers 422 version_too_long when the corrected version would not fit, and writes nothing", async (tx) => {
    const long = `XEi ${"Premium ".repeat(7).trim()}`;
    const ctx = await seed(tx, { version: long });
    const before = await tx.oilResearch.count();

    expect(await ctx.pick("2.0 Dynamic Force")).toEqual({ status: 422, body: { error: "version_too_long" } });
    expect(await tx.oilResearch.count()).toBe(before);
    expect(await ctx.version()).toBe(long);
  });

  itInTx("answers 409 not_clarification on a second pick, after the identity changed", async (tx) => {
    const ctx = await seed(tx);

    expect((await ctx.pick("1.8 Dual VVT-i")).status).toBe(200);
    expect(await ctx.pick("1.8 Dual VVT-i")).toEqual({ status: 409, body: { reason: "not_clarification" } });
  });
});

describeWithDatabase("POST /vehicles/:id/oil-research/engine-pick — the pick", () => {
  itInTx("appends the engine, flips a PLACA origin to CRM, queues the re-read at the front and answers researching", async (tx) => {
    const ctx = await seed(tx, { placa: true });

    const res = await ctx.pick("1.8 Dual VVT-i");

    expect(res.status).toBe(200);
    const body = quoteOptionsResultSchema.parse(res.body);
    expect(body).toMatchObject({ status: "researching", path: "engine_pick", engine: "1.8 Dual VVT-i", expectedMinutes: { min: 1, max: 2 }, queuePosition: 0 });
    expect(await ctx.version()).toBe("XEi 1.8 Dual VVT-i");
    expect(await tx.vehicleFieldSync.findUniqueOrThrow({ where: { vehicleId_fieldKey: { vehicleId: ctx.vehicleId, fieldKey: "version" } } })).toMatchObject({ origin: "CRM" });
    expect(await ctx.research(ctx.corrected("XEi 1.8 Dual VVT-i"))).toMatchObject({
      state: "queued",
      kind: "engine_pick",
      trigger: "engine_pick",
      priority: 0,
      enginePickEngine: "1.8 Dual VVT-i",
      enginePickFrom: ctx.key,
      enginePickPassages: [PASSAGE],
      enginePickReopened: false,
    });
    // The earlier identity and the other vehicle that carries it are left as they were.
    expect(await ctx.research(ctx.key)).toMatchObject({ state: "needs_clarification", outcomePayload: ctx.clarification.outcomePayload });
    expect(await ctx.version(ctx.siblingId)).toBe("XEi");
  });

  itInTx("replaces a different engine in the version, keeping the trim", async (tx) => {
    const ctx = await seed(tx, { version: "XEi 1.0" });

    expect((await ctx.pick("2.0 Dynamic Force")).status).toBe(200);
    expect(await ctx.version()).toBe("XEi 2.0 Dynamic Force");
  });

  // Orchestrator, 2026-10-01: everything from the displacement token to the end is the engine part.
  itInTx("replaces a multi-word engine whole, leaving none of its words behind", async (tx) => {
    const ctx = await seed(tx, { version: "XEi 1.8 Dual VVT-i" });

    expect((await ctx.pick("2.0 Dynamic Force")).status).toBe(200);
    expect(await ctx.version()).toBe("XEi 2.0 Dynamic Force");
    expect(await ctx.research(ctx.corrected("XEi 2.0 Dynamic Force"))).toMatchObject({ kind: "engine_pick", enginePickEngine: "2.0 Dynamic Force" });
  });

  // Orchestrator, 2026-10-01: the version is computed once and written as a compare-and-set, so
  // two picks of different engines racing on one vehicle never leave the later one's version
  // written over the earlier one's.
  itInTx("answers 409 version_changed to the slower of two picks of different engines, writing no version", async (tx) => {
    const ctx = await seed(tx);
    const omie = createFakeOmie();
    let raced = false;
    // Pick A has checked and enqueued; just before it writes its version, pick B runs whole.
    const racing: Db = {
      ...ctx.inner,
      tx: async (module, fn, runner) => {
        if (module === "customers" && !raced) {
          raced = true;
          const b = await pickOilEngine(ctx.inner, omie, { vehicleId: ctx.vehicleId, unitId: ctx.unitId, engine: "2.0 Dynamic Force" });
          expect(b.status).toBe("answered");
        }
        return ctx.inner.tx(module, fn, runner);
      },
    };

    const a = await pickOilEngine(racing, omie, { vehicleId: ctx.vehicleId, unitId: ctx.unitId, engine: "1.8 Dual VVT-i" });

    expect(a).toEqual({ status: "refused", reason: "version_changed" });
    expect(await ctx.version()).toBe("XEi 2.0 Dynamic Force");
    // Both picks were queued; A's re-read is left to be abandoned, since no vehicle carries its key.
    expect(await ctx.research(ctx.corrected("XEi 1.8 Dual VVT-i"))).toMatchObject({ kind: "engine_pick" });
    expect(await ctx.research(ctx.corrected("XEi 2.0 Dynamic Force"))).toMatchObject({ kind: "engine_pick" });
  });

  itInTx("queues a full research at the front when the clarification kept no passages (G1)", async (tx) => {
    const ctx = await seed(tx, { passages: [] });

    const res = await ctx.pick("1.8 Dual VVT-i");

    expect(quoteOptionsResultSchema.parse(res.body)).toMatchObject({ status: "researching", path: "search" });
    expect(res.body).not.toHaveProperty("engine");
    expect(await ctx.research(ctx.corrected("XEi 1.8 Dual VVT-i"))).toMatchObject({ state: "queued", kind: "full", trigger: "engine_pick", priority: 0, enginePickPassages: null });
  });

  itInTx("answers 500 when the version write fails, and leaves the queued row", async (tx) => {
    const ctx = await seed(tx, { failVersionWrite: true });

    expect((await ctx.pick("1.8 Dual VVT-i")).status).toBe(500);
    expect(await ctx.version()).toBe("XEi");
    expect(await ctx.research(ctx.corrected("XEi 1.8 Dual VVT-i"))).toMatchObject({ state: "queued", kind: "engine_pick" });
  });
});

describeWithDatabase("POST /vehicles/:id/oil-research/engine-pick — G2, by the corrected identity's row", () => {
  const CORRECTED = "XEi 1.8 Dual VVT-i";
  const corrected = (identity: { make: string; year: number; model: string }) => ({ ...identity, version: CORRECTED });
  const rowOf = (tx: DbClient, identity: { make: string; year: number; model: string }, data: Record<string, unknown>) => {
    const at = new Date(Date.now() - 10 * MIN);
    return tx.oilResearch.create({ data: { id: randomUUID(), identityKey: identityKey(corrected(identity))!, ...corrected(identity), trigger: "backfill", queuedAt: at, cycleQueuedAt: at, ...data } });
  };

  itInTx("shows a verified corrected identity's options and queues nothing", async (tx) => {
    const ctx = await seed(tx);
    await tx.catalogItem.create({ data: { id: `o-${randomUUID().slice(0, 8)}`, brand: "Motul", description: "0W-20", price: 50, stock: 3, active: true, lubricant: { create: { viscosity: "0W-20" } } } });
    await tx.motulCompatibility.create({
      data: { ...corrected(ctx.identity), viscosities: ["0W-20"], viscosity: "0W-20", classification: "", fillLiters: 4.2, fillKind: "em_servico", sourcePublisher: "Toyota", sourceDocument: "Manual", sourcePage: "p. 1", consultedAt: new Date("2026-09-20T12:00:00.000Z") },
    });
    await rowOf(tx, ctx.identity, { state: "verified", outcome: "verified", trigger: "adopted", priority: 2, tecfilState: "ok" });

    const res = await ctx.pick("1.8 Dual VVT-i");

    expect(quoteOptionsResultSchema.parse(res.body)).toMatchObject({ status: "options", fillLiters: 4.2 });
    expect(await ctx.research(ctx.corrected(CORRECTED))).toMatchObject({ state: "verified", kind: "full", enginePickPassages: null });
  });

  it.each(["full", "manual_resolve"])("turns a queued %s into the engine pick at the front, with the passages", (kind) =>
    withTestTransaction(prisma as PrismaClient, async (tx) => {
      const ctx = await seed(tx);
      await rowOf(tx, ctx.identity, { state: "queued", kind, priority: 2, attempts: 1, trigger: kind === "full" ? "backfill" : "manual_upgrade" });

      await ctx.pick("1.8 Dual VVT-i");

      expect(await ctx.research(ctx.corrected(CORRECTED))).toMatchObject({ state: "queued", kind: "engine_pick", trigger: "engine_pick", priority: 0, attempts: 0, enginePickPassages: [PASSAGE] });
    }),
  );

  itInTx("keeps a queued refetch a refetch, moved to the front", async (tx) => {
    const ctx = await seed(tx);
    await rowOf(tx, ctx.identity, { state: "queued", kind: "refetch", trigger: "refetch", priority: 1 });

    await ctx.pick("1.8 Dual VVT-i");

    expect(await ctx.research(ctx.corrected(CORRECTED))).toMatchObject({ kind: "refetch", priority: 0, enginePickPassages: null });
  });

  itInTx("keeps a running research, moved to the front, its pending kind unchanged, and drops the pick", async (tx) => {
    const ctx = await seed(tx);
    const runId = randomUUID();
    await rowOf(tx, ctx.identity, { state: "running", kind: "full", priority: 2, attempts: 1, currentRunId: runId, leaseUntil: new Date(Date.now() + 10 * MIN), startedAt: new Date(), pendingKind: "manual_resolve", pendingPriority: 1 });

    await ctx.pick("1.8 Dual VVT-i");

    expect(await ctx.research(ctx.corrected(CORRECTED))).toMatchObject({ state: "running", kind: "full", priority: 0, attempts: 1, currentRunId: runId, pendingKind: "manual_resolve", enginePickPassages: null });
  });

  itInTx("starts an engine-pick cycle on a resting no-source, marked as reopening it", async (tx) => {
    const ctx = await seed(tx);
    await rowOf(tx, ctx.identity, { state: "no_spec", outcome: "no_spec", priority: 2, finishedAt: new Date() });

    await ctx.pick("1.8 Dual VVT-i");

    expect(await ctx.research(ctx.corrected(CORRECTED))).toMatchObject({ state: "queued", kind: "engine_pick", priority: 0, outcome: "no_spec", enginePickReopened: true, enginePickPassages: [PASSAGE] });
  });
});

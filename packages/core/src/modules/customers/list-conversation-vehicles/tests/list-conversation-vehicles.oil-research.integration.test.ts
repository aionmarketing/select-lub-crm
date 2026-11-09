/**
 * Test design (testing-strategy) — the rail's vehicles carry their oil research state (D18)
 *
 * SUT: `GET /conversations/:id/vehicles` (the `list-conversation-vehicles` slice) with the quotes
 *   contract `readActiveOilResearch`, on the real database in the rolling-back harness. Ran under
 *   module role: `customers` — the research tables are `readableBy: "*"`, so the read runs under
 *   the caller's role. The research and runner rows are written directly on the transaction.
 *
 * Oracle: background-oil-research D18 and D15's attended and `stopped` rules; the
 *   `customer-vehicles` delta "Conversation vehicles carry their oil research state"; the
 *   `shared-types` delta (`oilResearch` `{ status: "researching" }`).
 *
 * Cells (identity's research | marked? | the bug it would miss)
 *   running under a live lease        | yes | the running car unmarked
 *   waiting for a manual              | yes |
 *   queued at priority 0              | yes |
 *   verified / Tecfil running         | no  | a Tecfil consultation shown as research
 *   incomplete identity               | no  |
 *   queued for the backfill (2)       | no  | "Pesquisando…" on every backfilled car
 *   stopped (a stale heartbeat)       | no  | a line promising research that is not running
 *   the read throws                   | the list, unmarked | the whole rail failing
 *   never researched                  | no, and nothing queued or written | a listing that starts research
 */
import { randomUUID } from "node:crypto";
import { prisma, type DbClient, type PrismaClient } from "@select-lub/core/db";
import { expect, it, vi } from "vitest";
import { createFakeOmie } from "../../../../kernel/clients/erp-mock.js";
import { createDb } from "../../../../kernel/db.js";
import { registerSlice } from "../../../../kernel/http.js";
import { buildSliceApp, describeWithDatabase, runInTransactionOnTx, seedConnection, seedConversation, seedUnit, seedUser, withTestTransaction } from "../../../../testing/index.js";
import { identityKey } from "../../../quotes/contracts/oil-research-attention.js";
import type { readActiveOilResearch } from "../../../quotes/contracts/read-active-oil-research.js";
import { conversationVehiclesSchema } from "../../contracts/http.js";
import { route } from "../index.js";

const MIN = 60_000;

function itInTx(name: string, fn: (tx: DbClient) => Promise<void>) {
  it(name, () => withTestTransaction(prisma as PrismaClient, fn));
}

type Identity = { make: string; year: number; model: string; version: string };

/** A conversation linked to a customer with one vehicle per identity, and the slice mounted. */
async function seedRail(tx: DbClient, identities: (Identity | { make: null; year: number; model: string; version: null })[], readResearch?: typeof readActiveOilResearch) {
  const unit = await seedUnit(tx);
  const user = await seedUser(tx, { units: [unit.id] });
  const connection = await seedConnection(tx, { unitId: unit.id });
  const customer = await tx.customer.create({ data: { name: "Ana", unitId: unit.id, origin: "manual", status: "active" }, select: { id: true } });
  const ids: string[] = [];
  for (const identity of identities) {
    ids.push((await tx.vehicle.create({ data: { customerId: customer.id, origin: "crm", ...identity }, select: { id: true } })).id);
  }
  const conversation = await seedConversation(tx, { connectionId: connection.id });
  await tx.conversation.update({ where: { id: conversation.id }, data: { customerId: customer.id } });
  const app = await buildSliceApp({
    db: createDb(tx, runInTransactionOnTx(tx)),
    plugin: (a) => registerSlice(a, "customers", "list-conversation-vehicles", route({ omieAdapter: createFakeOmie() }, readResearch)),
    caller: { userId: user.id, unitId: unit.id },
  });
  // What the handler logs, through the request's own Pino logger.
  const warnings: unknown[][] = [];
  app.addHook("onRequest", async (request) => {
    vi.spyOn(request.log, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args);
    });
  });
  const list = async () => {
    const res = await app.inject({ method: "GET", url: `/conversations/${conversation.id}/vehicles` });
    expect(res.statusCode).toBe(200);
    const body = conversationVehiclesSchema.parse(res.json());
    return new Map(body.vehicles.map((vehicle) => [vehicle.id, vehicle.oilResearch]));
  };
  return { ids, list, warnings };
}

const fresh = (label: string): Identity => ({ make: "Volkswagen", year: 2021, model: "Gol", version: `${label} ${randomUUID().slice(0, 8)}` });

/** The research row of `identity`, with a queued cycle's defaults under `data`. */
function research(tx: DbClient, identity: Identity, data: Record<string, unknown>) {
  const queuedAt = new Date(Date.now() - 10 * MIN);
  return tx.oilResearch.create({ data: { id: randomUUID(), identityKey: identityKey(identity)!, ...identity, trigger: "quote_open", queuedAt, cycleQueuedAt: queuedAt, ...data } });
}

/** A runner seen `agoMs` ago, with the key set. */
function runner(tx: DbClient, agoMs = 10_000) {
  return tx.oilResearchRunner.upsert({ where: { id: "runner" }, create: { id: "runner", lastSeenAt: new Date(Date.now() - agoMs), keySet: true }, update: { lastSeenAt: new Date(Date.now() - agoMs), keySet: true, pausedReason: null, pausedUntil: null } });
}

describeWithDatabase("GET /conversations/:id/vehicles — the research flag", () => {
  itInTx("marks a running, a waiting and a front-of-queue identity, and nothing else", async (tx) => {
    const running = fresh("running");
    const waiting = fresh("waiting");
    const queued = fresh("queued");
    const verified = fresh("verified");
    const backfill = fresh("backfill");
    const tecfil = fresh("tecfil");
    const rail = await seedRail(tx, [running, waiting, queued, verified, backfill, tecfil, { make: null, year: 2021, model: "Gol", version: null }]);
    await runner(tx);
    await research(tx, running, { state: "running", priority: 2, leaseUntil: new Date(Date.now() + 10 * MIN) });
    await research(tx, waiting, { state: "waiting_manual", priority: 1, manualWaitUntil: new Date(Date.now() + 20 * MIN) });
    await research(tx, queued, { priority: 0, requestedAt: new Date() });
    await research(tx, verified, { state: "verified", outcome: "verified", tecfilState: "ok" });
    await research(tx, backfill, { priority: 2, trigger: "backfill" });
    await research(tx, tecfil, { state: "verified", outcome: "verified", tecfilState: "running", tecfilLeaseUntil: new Date(Date.now() + 10 * MIN) });

    const marks = await rail.list();

    expect(rail.ids.map((id) => marks.get(id))).toEqual([
      { status: "researching" },
      { status: "researching" },
      { status: "researching" },
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  itInTx("marks nothing while research is stopped", async (tx) => {
    const queued = fresh("queued");
    const rail = await seedRail(tx, [queued]);
    await runner(tx, 10 * MIN);
    await research(tx, queued, { priority: 0, requestedAt: new Date() });

    expect((await rail.list()).get(rail.ids[0]!)).toBeUndefined();
  });

  itInTx("lists the vehicles unmarked when the research state cannot be read", async (tx) => {
    const queued = fresh("queued");
    const rail = await seedRail(tx, [queued], async () => {
      throw new Error("oil_research unreadable");
    });
    await runner(tx);
    await research(tx, queued, { priority: 0, requestedAt: new Date() });

    const marks = await rail.list();

    expect([...marks.values()]).toEqual([undefined]);
    expect(rail.warnings).toEqual([[expect.objectContaining({ event: "oil_research_read_failed" }), expect.any(String)]]);
  });

  itInTx("starts no research and writes nothing for a complete identity never researched", async (tx) => {
    const never = fresh("never");
    const rail = await seedRail(tx, [never]);
    await runner(tx);
    const counts = async () => ({ research: await tx.oilResearch.count(), runs: await tx.oilResearchRun.count(), runner: await tx.oilResearchRunner.findMany() });
    const before = await counts();

    expect((await rail.list()).get(rail.ids[0]!)).toBeUndefined();
    expect(await counts()).toEqual(before);
  });
});

/**
 * Shared seeding for the get-quote-options suites (background-oil-research PR 4): a unit with a
 * vehicle of an identity no other row holds, the slice mounted on the test transaction, and
 * writers for the rows the quote reads — a cache row, a Tecfil row, the research row, the runner
 * row and a catalog. Every row is written directly on the rolling-back transaction, so a case
 * states the research state it answers from instead of running the worker.
 *
 * The catalog grades here (`0W-8`, `0W-12`) are ones the production catalog does not stock, so a
 * committed demo catalog cannot add a card to what a case expects.
 */
import { randomUUID } from "node:crypto";
import { prisma, type PrismaClient } from "@select-lub/core/db";
import { it } from "vitest";
import { createDb, type Db, type DbClient } from "../../../../kernel/db.js";
import { registerSlice } from "../../../../kernel/http.js";
import { buildSliceApp, runInTransactionOnTx, seedUnit, withTestTransaction } from "../../../../testing/index.js";
import { quoteOptionsResultSchema, type QuoteOptionsResult } from "../../contracts/http.js";
import { identityKey } from "../../contracts/oil-research-attention.js";
import { getQuoteOptions, route } from "../index.js";

export const MIN = 60_000;
export const HOUR = 60 * MIN;

/** `it` whose body runs inside a test transaction that always rolls back. */
export function itInTx(name: string, fn: (tx: DbClient) => Promise<void>) {
  it(name, () => withTestTransaction(prisma as PrismaClient, fn));
}

export type Identity = { make: string; year: number; model: string; version: string };

/** A Polo identity with a version no other suite or seed holds. */
export function freshIdentity(): Identity {
  return { make: "Volkswagen", year: 2021, model: "Polo", version: `1.0 TSI ${randomUUID().slice(0, 8)}` };
}

/** The seeded unit, its vehicle, a vehicle in another unit, and the slice on the transaction. */
export type Seeded = Awaited<ReturnType<typeof seed>>;

/**
 * @param vehicleData - Overrides for the vehicle in the caller's unit (a missing field, say).
 */
export async function seed(tx: DbClient, vehicleData: { make?: string | null; model?: string | null; version?: string | null; year?: number | null } = {}) {
  const identity = freshIdentity();
  const unit = await seedUnit(tx);
  const other = await seedUnit(tx);
  const customer = await tx.customer.create({ data: { name: "Ana", unitId: unit.id, origin: "manual", status: "active" }, select: { id: true } });
  const outsider = await tx.customer.create({ data: { name: "Outra", unitId: other.id, origin: "manual", status: "active" }, select: { id: true } });
  const vehicle = await tx.vehicle.create({ data: { customerId: customer.id, origin: "crm", ...identity, ...vehicleData }, select: { id: true } });
  const foreign = await tx.vehicle.create({ data: { customerId: outsider.id, origin: "crm", ...identity }, select: { id: true } });
  const db: Db = createDb(tx, runInTransactionOnTx(tx));
  const app = await buildSliceApp({
    db,
    plugin: (a) => registerSlice(a, "quotes", "get-quote-options", route()),
    caller: { userId: "attendant", unitId: unit.id, unitIds: [unit.id, other.id] },
  });
  /** The slice's answer at `now`, parsed as the response schema would serialize it. */
  const answer = async (now: Date = new Date()): Promise<QuoteOptionsResult> => {
    const result = await getQuoteOptions(db, { vehicleId: vehicle.id, unitId: unit.id, now });
    if (!result) throw new Error("the seeded vehicle is in the caller's unit, so null is a lookup bug");
    return quoteOptionsResultSchema.parse(result);
  };
  /** The answer over HTTP: the route, its querystring and its response schema. */
  const inject = async (query = "") => {
    const res = await app.inject({ method: "GET", url: `/vehicles/${vehicle.id}/quote-options${query}` });
    return { status: res.statusCode, body: res.json() as QuoteOptionsResult };
  };
  return { app, db, identity, key: identityKey(identity)!, unitId: unit.id, vehicleId: vehicle.id, foreignVehicleId: foreign.id, answer, inject };
}

/** A verified cache row with provenance (adoptable, D7); `overrides` replaces any column. */
export async function cacheRow(tx: DbClient, identity: Identity, overrides: Record<string, unknown> = {}) {
  return tx.motulCompatibility.create({
    data: {
      ...identity,
      viscosities: ["0W-8"],
      viscosity: "0W-8",
      classification: "API SP",
      fillLiters: 4,
      fillKind: "em_servico",
      sourcePublisher: "Volkswagen do Brasil",
      sourceDocument: "Manual do Proprietário Polo (2021)",
      sourcePage: "p. 287",
      sourceAuthority: 1,
      consultedAt: new Date("2026-09-20T12:00:00.000Z"),
      ...overrides,
    },
  });
}

/** A row from before grounded retrieval: one viscosity, no provenance, no liters. */
export async function historicalRow(tx: DbClient, identity: Identity, consultedAt = new Date("2026-08-01T12:00:00.000Z")) {
  return tx.motulCompatibility.create({ data: { ...identity, viscosity: "0W-8", classification: "", consultedAt } });
}

/** A Tecfil row fitting `ZPEL108` (with an Authomix cross-reference) and fuel `ZGI50/7`. */
export async function tecfilRow(tx: DbClient, identity: Identity, fuel = [{ tecfilNumber: "ZGI50/7", tecfilProductCode: 507, description: "Filtro de combustível", crossReferences: [] }]) {
  return tx.tecfilCompatibility.create({
    data: {
      ...identity,
      manufacturerLabel: "VOLKSWAGEN",
      vehicleLabel: "POLO",
      engineLabel: "1.0 TSI",
      matchedBy: { manufacturer: "exact", vehicle: "exact", engine: "exact" },
      oilFilters: [{ tecfilNumber: "ZPEL108", tecfilProductCode: 108, description: "Filtro de óleo", crossReferences: [{ brand: "AUTHOMIX", number: "ZFOL0108" }] }],
      fuelFilters: fuel,
      consultedAt: new Date("2026-09-21T12:00:00.000Z"),
    },
  });
}

/** The research row, with a queued cycle's defaults; `data` sets the state under test. */
export async function researchRow(tx: DbClient, identity: Identity, data: Record<string, unknown> = {}) {
  const queuedAt = new Date(Date.now() - 10 * MIN);
  return tx.oilResearch.create({
    data: { id: randomUUID(), identityKey: identityKey(identity)!, ...identity, trigger: "quote_open", queuedAt, cycleQueuedAt: queuedAt, ...data },
  });
}

/** The runner row as a live worker leaves it: seen `seenAgoMs` ago, the key set, able to search, nothing paused. */
export async function runnerRow(tx: DbClient, data: Record<string, unknown> = {}, seenAgoMs = 10_000) {
  return tx.oilResearchRunner.upsert({
    where: { id: "runner" },
    create: { id: "runner", lastSeenAt: new Date(Date.now() - seenAgoMs), keySet: true, searchAvailable: true, ...data },
    update: { lastSeenAt: new Date(Date.now() - seenAgoMs), keySet: true, searchAvailable: true, pausedReason: null, pausedUntil: null, ...data },
  });
}

/**
 * Catalog rows: an active `0W-8` oil at 50,00/L typed `SINTETICO`, an inactive untyped one, a Tecfil oil filter `ZPEL108`, an
 * Authomix `ZFOL0108` (its cross-reference), and a fuel filter only when `fuel` is set.
 */
export async function catalog(tx: DbClient, options: { fuel?: boolean } = {}) {
  const tag = randomUUID().slice(0, 8);
  const oil = await tx.catalogItem.create({
    data: { id: `oil-${tag}`, brand: "Motul", description: "8100 Eco-lite", price: 50, stock: 10, active: true, lubricant: { create: { viscosity: "0W-8", classification: "API SP", oilType: "SINTETICO" } } },
  });
  await tx.catalogItem.create({
    data: { id: `old-${tag}`, brand: "Motul", description: "Descontinuado", price: 40, stock: 0, active: false, lubricant: { create: { viscosity: "0W-8" } } },
  });
  const tecfil = await tx.catalogItem.create({
    data: { id: `pel-${tag}`, brand: "Tecfil", description: "Filtro de óleo", price: 32, stock: 5, active: true, filter: { create: { filterType: "OLEO", partNumber: "ZPEL108" } } },
  });
  const authomix = await tx.catalogItem.create({
    data: { id: `fol-${tag}`, brand: "Authomix", description: "Filtro de óleo", price: 28, stock: 5, active: true, filter: { create: { filterType: "OLEO", partNumber: "ZFOL-0108" } } },
  });
  const fuel = options.fuel
    ? await tx.catalogItem.create({
        data: { id: `gi-${tag}`, brand: "Tecfil", description: "Filtro de combustível", price: 45, stock: 5, active: true, filter: { create: { filterType: "COMBUSTIVEL", partNumber: "ZGI50/7" } } },
      })
    : null;
  return { oil, tecfil, authomix, fuel };
}

/** The oil_research, run and cache tables' row counts, to show a read wrote nothing. */
export async function tableCounts(tx: DbClient) {
  const [research, runs, motul, tecfil, runner] = await Promise.all([
    tx.oilResearch.findMany({ orderBy: { id: "asc" } }),
    tx.oilResearchRun.count(),
    tx.motulCompatibility.count(),
    tx.tecfilCompatibility.count(),
    tx.oilResearchRunner.findMany(),
  ]);
  return { research, runs, motul, tecfil, runner };
}

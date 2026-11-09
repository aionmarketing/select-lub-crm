/**
 * Test design (testing-strategy)
 *
 * NEW in adopt-modular-vertical-slices 3C. `GET /services/:id` had no route test
 * in `apps/api` — only the web page's mocked tests and the quarantined Serviços
 * tour reached it — and this move changed how it reads (one `db.tx` under
 * `module_services`, joined to three other modules' tables). So it gets cases of
 * its own rather than arriving untested.
 *
 * Setup: the slice alone on the harness app, over a rolled-back transaction, as a
 * caller in the first loja.
 *
 * Oracle: customer-services — the Serviços detail region shows the service's
 *   items and labels and "that vehicle's other services, newest first, excluding
 *   this one"; the attribution is the persisted row, null when there is none; a
 *   service outside the caller's loja is not found.
 *
 * Sampled-cell
 *   service with an item, two siblings on its car | 200: item, labels, history
 *                                                 | newest first without itself | self in history, or unordered
 *   another loja's service                       | 404                         | 200
 *   unknown id                                   | 404                         | 500
 */
import { expect, it } from "vitest";
import { prisma, type DbClient, type PrismaClient } from "@select-lub/core/db";
import {
  buildSliceApp,
  describeWithDatabase,
  runInTransactionOnTx,
  seedUnit,
  seedUser,
  withTestTransaction,
} from "@select-lub/core/testing";
import { createDb } from "../../../../kernel/db.js";
import { registerSlice } from "../../../../kernel/http.js";
import { serviceDetailSchema } from "../../contracts/http.js";
import { route } from "../index.js";

const db = () => prisma as PrismaClient;

/** A loja with one car and three services on it, and another loja with a car and a service of its own. */
async function seedDetail(tx: DbClient) {
  const unit = await seedUnit(tx);
  const other = await seedUnit(tx);
  const user = await seedUser(tx, { units: [unit.id] });
  const customer = await tx.customer.create({
    data: { name: "Ana Beatriz", unitId: unit.id, origin: "omie", status: "active" },
    select: { id: true },
  });
  const vehicle = await tx.vehicle.create({
    data: { customerId: customer.id, plate: "ABC-1D23", origin: "omie" },
    select: { id: true },
  });
  const service = (performedAt: string) =>
    tx.service.create({
      data: {
        customerId: customer.id,
        vehicleId: vehicle.id,
        unitId: unit.id,
        performedAt: new Date(performedAt),
        origin: "omie",
      },
      select: { id: true },
    });
  const oldest = await service("2025-06-01T12:00:00.000Z");
  const middle = await service("2025-12-01T12:00:00.000Z");
  const newest = await service("2026-06-01T12:00:00.000Z");
  await tx.serviceItem.create({ data: { serviceId: middle.id, description: "Óleo 5W30" } });
  const otherCustomer = await tx.customer.create({
    data: { name: "Outra", unitId: other.id, origin: "omie", status: "active" },
    select: { id: true },
  });
  const otherVehicle = await tx.vehicle.create({
    data: { customerId: otherCustomer.id, origin: "omie" },
    select: { id: true },
  });
  const elsewhere = await tx.service.create({
    data: {
      customerId: otherCustomer.id,
      vehicleId: otherVehicle.id,
      unitId: other.id,
      performedAt: new Date("2026-01-01T12:00:00.000Z"),
      origin: "omie",
    },
    select: { id: true },
  });
  const app = await buildSliceApp({
    db: createDb(tx, runInTransactionOnTx(tx)),
    plugin: (instance) => registerSlice(instance, "services", "get-service", route),
    caller: { userId: user.id, unitId: unit.id },
  });
  return { app, oldest: oldest.id, middle: middle.id, newest: newest.id, elsewhere: elsewhere.id };
}

describeWithDatabase("GET /services/:id", () => {
  it("returns the service with its item, its labels and its car's other services", () =>
    withTestTransaction(db(), async (tx) => {
      const t = await seedDetail(tx);
      try {
        const response = await t.app.inject({ method: "GET", url: `/services/${t.middle}` });

        expect(response.statusCode).toBe(200);
        const detail = serviceDetailSchema.parse(response.json());
        expect(detail.id).toBe(t.middle);
        expect(detail.items.map((item) => item.description)).toEqual(["Óleo 5W30"]);
        expect(detail.customerName).toBe("Ana Beatriz");
        expect(detail.vehiclePlate).toBe("ABC-1D23");
        // Newest first, and never the service itself.
        expect(detail.vehicleHistory.map((row) => row.id)).toEqual([t.newest, t.oldest]);
        expect(detail.attributedQuote).toBeNull();
      } finally {
        await t.app.close();
      }
    }));

  it("returns 404 for a service in another loja", () =>
    withTestTransaction(db(), async (tx) => {
      const t = await seedDetail(tx);
      try {
        const response = await t.app.inject({ method: "GET", url: `/services/${t.elsewhere}` });

        expect(response.statusCode).toBe(404);
      } finally {
        await t.app.close();
      }
    }));

  it("returns 404 for an unknown service", () =>
    withTestTransaction(db(), async (tx) => {
      const t = await seedDetail(tx);
      try {
        const response = await t.app.inject({ method: "GET", url: "/services/missing" });

        expect(response.statusCode).toBe(404);
      } finally {
        await t.app.close();
      }
    }));
});

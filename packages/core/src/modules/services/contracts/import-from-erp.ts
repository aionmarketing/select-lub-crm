/**
 * `import-from-erp` — the service-order half of the store the ERP pull
 * (`erp/run-pull`) imports through.
 *
 * Moved from `apps/worker/src/omie/import-prisma.ts`
 * (`createPrismaSurfaceImportStore`) by 3A with the upsert's body unchanged, and
 * kept here by 3C rather than turned into a slice: its only caller is another
 * module, and a module reaches another only through `contracts/` (3C ruling Q5).
 * It is the only writer of `service` and `service_item` outside seeds and tests,
 * which is why `services` has no create route and publishes no
 * `service-recorded` event (W3-C8). The catalog half of that file is the quotes
 * module's `upsert-catalog-product` contract (2B.2); `erp/run-pull` composes the
 * two.
 *
 * The role: each upsert runs in one `db.tx("services", …)`, so
 * it writes `service` and `service_item` under `module_services`, which owns
 * both. `customer`, `unit` and `vehicle` are only read. One transaction per
 * order, because the order and its line items must land together; never one
 * around the pull, which awaits the ERP between orders (W2-C12).
 */
import { itemsFromMockOrder, resolveServiceVehicleId, type OmieSurfaceImportStore } from "../../erp/contracts/import-surfaces-store.js";
import type { MockServiceOrder } from "../../../kernel/clients/erp-mock.js";
import type { Db } from "../../../kernel/db.js";

/** The service-order methods of the pull's surface import store. */
export type ServiceImportStore = Pick<
  OmieSurfaceImportStore,
  "upsertServiceByOmieId" | "listImportedServices"
>;

/**
 * Creates the identifier-keyed service-order import.
 *
 * Has no generic service `create`. Missing customers or units skip the OS row.
 * Line items are replaced on re-import.
 *
 * @param db - The database handle; each order opens its own `services` transaction.
 * @returns The upsert, plus the port's `listImportedServices` inspector, which
 *   only the in-memory fake maintains and which is `[]` here, as it was.
 */
export function createServiceImportStore(db: Db): ServiceImportStore {
  return {
    upsertServiceByOmieId: (order: MockServiceOrder) =>
      db.tx("services", async (prisma) => {
      const customer = await prisma.customer.findUnique({ where: { omieId: order.clientOmieId } });
      if (!customer) {
        return "skipped";
      }
      let unitId = customer.unitId;
      if (!unitId) {
        const unit = await prisma.unit.findFirst({ orderBy: { createdAt: "asc" } });
        unitId = unit?.id ?? null;
      }
      if (!unitId) {
        return "skipped";
      }
      const vehicles = await prisma.vehicle.findMany({
        where: { customerId: customer.id },
        select: { id: true, omieId: true, plate: true },
      });
      const vehicleId = resolveServiceVehicleId(order, vehicles);
      const existing = await prisma.service.findUnique({ where: { omieId: order.omieId } });
      const data = {
        performedAt: order.performedAt ? new Date(order.performedAt) : null,
        description: order.description,
        kind: order.kind,
        status: order.status,
        amount: order.amount,
        odometerKm: order.odometerKm,
      };
      const items = itemsFromMockOrder(order);
      const serviceId = existing
        ? (
            await prisma.service.update({
              where: { id: existing.id },
              data: vehicleId ? { ...data, vehicleId } : data,
            })
          ).id
        : (
            await prisma.service.create({
              data: {
                ...data,
                customerId: customer.id,
                vehicleId,
                unitId,
                omieId: order.omieId,
                origin: "omie",
              },
            })
          ).id;
      await prisma.serviceItem.deleteMany({ where: { serviceId } });
      if (items.length > 0) {
        await prisma.serviceItem.createMany({
          data: items.map((item) => ({
            serviceId,
            description: item.description,
            kind: item.kind,
            quantity: item.quantity,
            unitAmount: item.unitAmount,
            lineAmount: item.lineAmount,
            oilViscosity: item.oilViscosity,
          })),
        });
      }
      return existing ? "updated" : "created";
      }),
    listImportedServices() {
      return [];
    },
  };
}

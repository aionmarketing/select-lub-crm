/**
 * Imports mock Omie OS, catalog products, vehicle identifiers, and duplicate pairs.
 *
 * Writes services and catalog rows only through identifier upserts. Vehicle ids
 * go through {@link CadastroStore}; duplicate pairs are recorded, never merged.
 */
import { randomUUID } from "node:crypto";
import type { OmieSurfaceImportStore } from "../contracts/import-surfaces-store.js";
import type { MockOmieSource } from "../../../kernel/clients/erp-mock.js";
import type { CadastroStore } from "../../customers/contracts/cadastro-store/port.js";
import type { SyncRunStore } from "../contracts/sync-run-store.js";

const DUPLICATE_CODE = "omie_duplicate_candidate";

/**
 * Imports every non-client mock surface into CRM stores. Idempotent on Omie ids.
 *
 * @param input.source - Mock Omie source (OS, products, vehicle ids, duplicates).
 * @param input.cadastro - Customer/vehicle persistence; used for vehicle ids and customer lookup.
 * @param input.surfaces - Identifier-keyed OS and catalog upserts (no generic `create`).
 * @param input.errors - Sink for duplicate-candidate rows; does not merge customers.
 * @returns Counts of rows read from the mock, upserts that inserted, and recorded errors.
 */
export async function importMockSurfaces(input: {
  source: MockOmieSource;
  cadastro: CadastroStore;
  surfaces: OmieSurfaceImportStore;
  errors: { record: SyncRunStore["record"]; hasRecordedError: SyncRunStore["hasRecordedError"] };
}): Promise<{ read: number; written: number; created: number; errors: number }> {
  let read = 0;
  let written = 0;
  let created = 0;
  let errors = 0;

  let page = 1;
  let totalPages = 1;
  const clientOmieIds: string[] = [];
  while (page <= totalPages) {
    const listed = await input.source.clients.listPage(page);
    totalPages = listed.totalPages;
    for (const client of listed.clients) {
      if (client.omieId !== "") {
        clientOmieIds.push(client.omieId);
      }
    }
    page += 1;
  }

  const products = await input.source.products.listProducts();
  read += products.length;
  for (const product of products) {
    const result = await input.surfaces.upsertCatalogProduct(product);
    written += 1;
    if (result === "created") {
      created += 1;
    }
  }

  const vehicleIds = await input.source.vehicleIds.listVehicleIds();
  read += vehicleIds.length;
  for (const row of vehicleIds) {
    const result = await upsertVehicleIdentifier(input.cadastro, row);
    if (result !== "skipped") {
      written += 1;
    }
    if (result === "created") {
      created += 1;
    }
  }

  for (const clientOmieId of clientOmieIds) {
    const orders = await input.source.serviceOrders.listByClient(clientOmieId);
    read += orders.length;
    for (const order of orders) {
      const result = await input.surfaces.upsertServiceByOmieId(order);
      if (result !== "skipped") {
        written += 1;
      }
      if (result === "created") {
        created += 1;
      }
    }
  }

  const pairs = await input.source.duplicates.listDuplicatePairs();
  read += pairs.length;
  for (const pair of pairs) {
    const correlationId = `${pair.leftOmieId}:${pair.rightOmieId}`;
    // Asked of the store rather than scanned from a snapshot: the snapshot
    // form was answered `[]` by the only production adapter, so this guard
    // never fired and every pull appended another row (GitHub #106).
    const already = await input.errors.hasRecordedError({
      code: DUPLICATE_CODE,
      correlationId,
    });
    if (already) {
      continue;
    }
    await input.errors.record({
      operation: "importMockSurfaces",
      code: DUPLICATE_CODE,
      message: "mock Omie duplicate-client candidate (unvalidated stand-in; GitHub #5)",
      retryable: false,
      attemptCount: 1,
      correlationId,
    });
    errors += 1;
  }

  return { read, written, created, errors };
}

async function upsertVehicleIdentifier(
  cadastro: CadastroStore,
  row: { vehicleOmieId: string; clientOmieId: string; plate: string },
): Promise<"created" | "updated" | "skipped"> {
  const customer = await cadastro.findCustomerByOmieId(row.clientOmieId);
  if (!customer) {
    return "skipped";
  }
  const vehicles = await cadastro.listVehicles(customer.id);
  const match =
    vehicles.find((vehicle) => vehicle.omieId === row.vehicleOmieId) ??
    vehicles.find((vehicle) => vehicle.plate === row.plate);
  if (match) {
    if (match.omieId === row.vehicleOmieId) {
      return "updated";
    }
    match.omieId = row.vehicleOmieId;
    await cadastro.saveVehicle(match);
    return "updated";
  }
  const stamp = new Date().toISOString();
  await cadastro.createVehicle({
    id: randomUUID(),
    customerId: customer.id,
    omieId: row.vehicleOmieId,
    plate: row.plate,
    make: null,
    model: null,
    version: null,
    year: null,
    odometerKm: null,
    origin: "omie",
    createdAt: stamp,
    updatedAt: stamp,
  });
  return "created";
}

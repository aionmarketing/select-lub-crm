/**
 * Identifier-keyed upsert port for mock Omie OS and catalog import.
 *
 * Not the cadastro store and not a generic service `create` â€” the importer
 * may only write rows whose Omie id the mock actually listed.
 */
import type { MockCatalogProduct, MockServiceOrder } from "../../../kernel/clients/erp-mock.js";
import type { VehicleRecord } from "../../customers/contracts/cadastro-store/port.js";

/** One imported service line item keyed with its parent Omie OS. */
export type ImportedServiceItem = {
  description: string;
  kind: string | null;
  quantity: number | null;
  unitAmount: number | null;
  lineAmount: number | null;
  oilViscosity: string | null;
};

/** One imported service row keyed by Omie OS id. */
export type ImportedService = {
  id: string;
  omieId: string;
  customerId: string;
  vehicleId: string | null;
  unitId: string;
  performedAt: string | null;
  description: string | null;
  kind: string | null;
  status: string | null;
  amount: number | null;
  odometerKm: number | null;
  origin: "omie";
  items: ImportedServiceItem[];
};

/** Persistence for mock OS and catalog upserts. Has no generic `create`. */
export type OmieSurfaceImportStore = {
  /**
   * Inserts or updates a service by Omie OS id. Skips when the customer is unknown
   * or no unit id can be resolved.
   *
   * @param order - Mock OS row whose `omieId` is the upsert key.
   * @returns `"created"` on insert, `"updated"` on existing omieId, `"skipped"` when the customer or unit is missing.
   */
  upsertServiceByOmieId(order: MockServiceOrder): Promise<"created" | "updated" | "skipped">;
  /**
   * Inserts or updates a catalog row whose CRM `id` equals the mock product `omieId`.
   *
   * @param product - Mock catalog product.
   * @returns `"created"` on insert, `"updated"` when that id already exists.
   */
  upsertCatalogProduct(product: MockCatalogProduct): Promise<"created" | "updated">;
  /**
   * Returns imported service rows for test inspection, keyed by Omie id.
   *
   * @returns Cloned service rows in insertion order.
   */
  listImportedServices(): ImportedService[];
  /**
   * Returns imported catalog ids for test inspection.
   *
   * @returns Catalog row ids (mock product omieIds).
   */
  listImportedCatalogIds(): string[];
  /**
   * Returns the catalog ids that also got a lubricant-detail row, for test inspection.
   *
   * @returns Catalog row ids whose imported product carried a non-empty viscosity.
   */
  listImportedLubricantIds(): string[];
  /**
   * Returns the catalog ids that also got a filter-detail row, for test inspection.
   *
   * @returns Catalog row ids whose imported product carried a filter type. Empty for a
   *   product that also carried a viscosity â€” that combination is rejected and gets
   *   neither detail (tecfil-filter-pricing, omie-mock).
   */
  listImportedFilterIds(): string[];
};

/**
 * Normalizes a plate for import matching (alphanumerics, upper case).
 *
 * @param plate - Raw plate from the mock OS or a CRM vehicle; empty/null â†’ `""`.
 * @returns Comparable plate key.
 */
export function normalizeImportPlate(plate: string | null | undefined) {
  return (plate ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

/**
 * Maps mock OS line items for persistence. Missing `items` becomes `[]`.
 *
 * @param order - Mock OS row.
 * @returns Imported item rows (empty when the mock listed a header-only order).
 */
export function itemsFromMockOrder(order: MockServiceOrder): ImportedServiceItem[] {
  return (order.items ?? []).map((item) => ({
    description: item.description,
    kind: item.kind ?? null,
    quantity: item.quantity,
    unitAmount: item.unitAmount,
    lineAmount: item.lineAmount,
    oilViscosity: item.oilViscosity ?? null,
  }));
}

/**
 * Resolves `Service.vehicleId` from the mock OS against that customer's vehicles.
 *
 * Prefers `vehicleOmieId` (fixture path), then `order.plate` (TIDSCI path).
 *
 * @param order - Mock OS row.
 * @param vehicles - Vehicles already belonging to the linked customer.
 * @returns Matching CRM vehicle id, or `null` when neither key hits.
 */
export function resolveServiceVehicleId(
  order: MockServiceOrder,
  vehicles: Pick<VehicleRecord, "id" | "omieId" | "plate">[],
): string | null {
  if (order.vehicleOmieId) {
    const byOmie = vehicles.find((vehicle) => vehicle.omieId === order.vehicleOmieId);
    if (byOmie) {
      return byOmie.id;
    }
  }
  const plate = normalizeImportPlate(order.plate);
  if (plate === "") {
    return null;
  }
  return vehicles.find((vehicle) => normalizeImportPlate(vehicle.plate) === plate)?.id ?? null;
}


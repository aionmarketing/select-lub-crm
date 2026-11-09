/**
 * Maps internal cadastro rows to shared API DTO shapes for HTTP responses.
 */
import type { Customer } from "./http.customer.js";
import type { PlateSourcedFieldKey } from "../../plate-lookup/contracts/http.js";
import type { ReconciliationPending } from "./http.omie-sync.js";
import type { Vehicle } from "./http.vehicle.js";
import type { CustomerRecord, PendingRow, VehicleRecord } from "./cadastro-store/port.js";

/**
 * Converts a stored customer row into the public `Customer` contract.
 *
 * @param row - Internal cadastro customer row with nested phones and emails.
 * @returns API-facing customer DTO; `mergedInto` mirrors `mergedIntoId`, contacts are copied verbatim.
 */
export function customerToDto(row: CustomerRecord): Customer {
  return {
    id: row.id,
    name: row.name,
    omieId: row.omieId,
    taxId: row.taxId,
    unitId: row.unitId,
    givenName: row.givenName,
    familyName: row.familyName,
    mergedInto: row.mergedIntoId,
    street: row.street,
    streetNumber: row.streetNumber,
    neighborhood: row.neighborhood,
    complement: row.complement,
    city: row.city,
    state: row.state,
    postalCode: row.postalCode,
    country: row.country,
    origin: row.origin,
    status: row.status,
    phones: row.phones.map((item) => ({
      raw: item.raw,
      normalized: item.normalized,
      isPrimary: item.isPrimary,
    })),
    emails: row.emails,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Converts a stored vehicle row into the public `Vehicle` contract.
 *
 * @param row - Internal cadastro vehicle row linked to a titular customer.
 * @param plateSourcedKeys - Identity keys currently marked `PLACA`; omit or pass `[]` when none are marked.
 * @returns API-facing vehicle DTO with the same field names as `packages/shared-types`.
 */
export function vehicleToDto(
  row: VehicleRecord,
  plateSourcedKeys: readonly PlateSourcedFieldKey[] = [],
): Vehicle {
  return {
    id: row.id,
    customerId: row.customerId,
    omieId: row.omieId,
    plate: row.plate,
    make: row.make,
    model: row.model,
    version: row.version,
    year: row.year,
    odometerKm: row.odometerKm,
    origin: row.origin,
    plateSourcedKeys: [...plateSourcedKeys],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Converts an open reconciliation row into the public `ReconciliationPending` contract.
 *
 * @param row - Internal pending row; must represent an open conflict (`status` is forced to `"open"` in the DTO).
 * @returns API-facing pending DTO with stringified CRM and Omie values.
 */
export function pendingToDto(row: PendingRow): ReconciliationPending {
  return {
    fieldKey: row.fieldKey,
    crmValue: row.crmValue,
    omieValue: row.omieValue,
    status: "open",
    customerId: row.customerId,
    vehicleId: row.vehicleId,
  };
}

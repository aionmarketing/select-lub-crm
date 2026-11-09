/**
 * Reading and writing one shared field's business value on a customer or its titular vehicle, and which sync row owns it.
 *
 * Moved from `packages/omie/src/engine.ts` (wave 5.1b) with bodies unchanged.
 */
import type { OmieSharedFieldKey } from "../../../../shared/web/omie-field-keys.js";
import type { VehicleFieldEdit } from "../http.vehicle.js";
import { isVehicleField, type CrmFieldValue } from "../../../../kernel/clients/erp-mock.js";
import type { CustomerRecord, SyncOwner, VehicleRecord } from "../cadastro-store/port.js";

const VEHICLE_SHARED_KEYS = ["plate", "make", "model", "odometerKm"] as const;

export function patchHasVehicleSharedKey(patch: VehicleFieldEdit) {
  return VEHICLE_SHARED_KEYS.some((key) => Object.hasOwn(patch, key));
}

export function applyVehicleColumns(vehicle: VehicleRecord, patch: VehicleFieldEdit) {
  if (Object.hasOwn(patch, "plate")) {
    vehicle.plate = patch.plate ?? null;
  }
  if (Object.hasOwn(patch, "make")) {
    vehicle.make = patch.make ?? null;
  }
  if (Object.hasOwn(patch, "model")) {
    vehicle.model = patch.model ?? null;
  }
  if (Object.hasOwn(patch, "version")) {
    vehicle.version = patch.version ?? null;
  }
  if (Object.hasOwn(patch, "year")) {
    vehicle.year = patch.year ?? null;
  }
  if (Object.hasOwn(patch, "odometerKm")) {
    vehicle.odometerKm = patch.odometerKm ?? null;
  }
}

export function syncOwner(customerId: string, vehicle: VehicleRecord | null, fieldKey: OmieSharedFieldKey): SyncOwner | null {
  if (isVehicleField(fieldKey)) {
    if (!vehicle) {
      return null;
    }
    return { vehicleId: vehicle.id };
  }
  return { customerId };
}

/**
 * Reads the current CRM column value for a shared field from customer and titular vehicle rows.
 *
 * @param customer - Customer row holding person-level shared fields.
 * @param vehicle - Titular vehicle row for vehicle shared fields; `null` yields `null` for vehicle keys.
 * @param fieldKey - Shared Omie field to read.
 * @returns CRM value (`string`, `number`, or `null`); primary phone/email come from the `isPrimary` contact row.
 */
export function getBusinessValue(
  customer: CustomerRecord,
  vehicle: VehicleRecord | null,
  fieldKey: OmieSharedFieldKey,
): CrmFieldValue {
  switch (fieldKey) {
    case "name":
      return customer.name;
    case "taxId":
      return customer.taxId;
    case "primaryPhone":
      return customer.phones.find((row) => row.isPrimary)?.normalized ?? null;
    case "primaryEmail":
      return customer.emails.find((row) => row.isPrimary)?.normalized ?? null;
    case "street":
      return customer.street;
    case "streetNumber":
      return customer.streetNumber;
    case "neighborhood":
      return customer.neighborhood;
    case "complement":
      return customer.complement;
    case "city":
      return customer.city;
    case "state":
      return customer.state;
    case "postalCode":
      return customer.postalCode;
    case "country":
      return customer.country;
    case "plate":
      return vehicle?.plate ?? null;
    case "make":
      return vehicle?.make ?? null;
    case "model":
      return vehicle?.model ?? null;
    case "odometerKm":
      return vehicle?.odometerKm ?? null;
  }
}

function promoteOrSetPrimary(
  rows: { raw: string; normalized: string; isPrimary: boolean }[],
  normalized: string,
) {
  const existing = rows.find((row) => row.normalized === normalized);
  if (existing) {
    for (const row of rows) {
      row.isPrimary = row === existing;
    }
    return;
  }
  const primary = rows.find((row) => row.isPrimary);
  if (primary) {
    primary.raw = normalized;
    primary.normalized = normalized;
    return;
  }
  rows.push({ raw: normalized, normalized, isPrimary: true });
}

export function setBusinessValue(
  customer: CustomerRecord,
  vehicle: VehicleRecord | null,
  fieldKey: OmieSharedFieldKey,
  value: CrmFieldValue,
): void {
  switch (fieldKey) {
    case "name":
      if (typeof value === "string" && value.trim() !== "") {
        customer.name = value;
      }
      return;
    case "taxId":
      customer.taxId = value === null ? null : String(value);
      return;
    case "primaryPhone":
      promoteOrSetPrimary(customer.phones, value === null ? "" : String(value));
      return;
    case "primaryEmail":
      promoteOrSetPrimary(customer.emails, value === null ? "" : String(value));
      return;
    case "street":
      customer.street = value === null ? null : String(value);
      return;
    case "streetNumber":
      customer.streetNumber = value === null ? null : String(value);
      return;
    case "neighborhood":
      customer.neighborhood = value === null ? null : String(value);
      return;
    case "complement":
      customer.complement = value === null ? null : String(value);
      return;
    case "city":
      customer.city = value === null ? null : String(value);
      return;
    case "state":
      customer.state = value === null ? null : String(value);
      return;
    case "postalCode":
      customer.postalCode = value === null ? null : String(value);
      return;
    case "country":
      customer.country = value === null ? null : String(value);
      return;
    case "plate":
      if (vehicle) {
        vehicle.plate = value === null ? null : String(value);
      }
      return;
    case "make":
      if (vehicle) {
        vehicle.make = value === null ? null : String(value);
      }
      return;
    case "model":
      if (vehicle) {
        vehicle.model = value === null ? null : String(value);
      }
      return;
    case "odometerKm":
      if (vehicle) {
        vehicle.odometerKm = value === null ? null : Number(value);
      }
      return;
  }
}

export function parseStoredValue(fieldKey: OmieSharedFieldKey, raw: string): CrmFieldValue {
  if (fieldKey === "odometerKm") {
    if (raw === "") {
      return null;
    }
    const parsed = Number(raw);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return raw === "" ? null : raw;
}

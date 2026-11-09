/**
 * Row mappers shared by the cadastro store's method groups.
 *
 * Moved from `apps/api/src/cadastro/prisma.ts` with bodies unchanged (4B). `toSync`
 * maps any origin other than `OMIE_SYNC` to `CRM`: the port's origin is two-valued,
 * and the plate-origin marks (`PLACA`) are read through `plate-origin.ts`.
 */
import type { CustomerRecord, EmailRow, FieldSyncRow, VehicleRecord } from "./port.js";
import type { OmieSharedFieldKey } from "../../../../shared/web/omie-field-keys.js";

export function iso(value: Date): string {
  return value.toISOString();
}

export function toCustomer(row: {
  id: string;
  name: string | null;
  omieId: string | null;
  taxId: string | null;
  unitId: string | null;
  givenName: string | null;
  familyName: string | null;
  mergedIntoId: string | null;
  street: string | null;
  streetNumber: string | null;
  neighborhood: string | null;
  complement: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
  origin: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  phones: { raw: string; normalized: string; isPrimary: boolean; updatedAt: Date }[];
  emails: EmailRow[];
}): CustomerRecord {
  return {
    id: row.id,
    name: row.name,
    omieId: row.omieId,
    taxId: row.taxId,
    unitId: row.unitId,
    givenName: row.givenName,
    familyName: row.familyName,
    mergedIntoId: row.mergedIntoId,
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
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    phones: row.phones.map((item) => ({
      raw: item.raw,
      normalized: item.normalized,
      isPrimary: item.isPrimary,
      updatedAt: iso(item.updatedAt) })),
    emails: row.emails.map((item) => ({
      raw: item.raw,
      normalized: item.normalized,
      isPrimary: item.isPrimary })) };
}

export function toVehicle(row: {
  id: string;
  customerId: string;
  omieId: string | null;
  plate: string | null;
  make: string | null;
  model: string | null;
  version: string | null;
  year: number | null;
  odometerKm: number | null;
  origin: string;
  createdAt: Date;
  updatedAt: Date;
}): VehicleRecord {
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
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt) };
}

export function toSync(row: {
  fieldKey: string;
  origin: string;
  localVersion: number;
  externalVersion: number;
  syncedLocalVersion: number;
  syncedExternalVersion: number;
  lastOmieWire: string | null;
  lastAttemptedAt: Date | null;
  lastResult: string | null;
  lastError: string | null;
  changedBy: string | null;
}): FieldSyncRow {
  return {
    fieldKey: row.fieldKey as OmieSharedFieldKey,
    origin: row.origin === "OMIE_SYNC" ? "OMIE_SYNC" : "CRM",
    localVersion: row.localVersion,
    externalVersion: row.externalVersion,
    syncedLocalVersion: row.syncedLocalVersion,
    syncedExternalVersion: row.syncedExternalVersion,
    lastOmieWire: row.lastOmieWire,
    lastAttemptedAt: row.lastAttemptedAt ? iso(row.lastAttemptedAt) : null,
    lastResult: row.lastResult,
    lastError: row.lastError,
    changedBy: row.changedBy };
}

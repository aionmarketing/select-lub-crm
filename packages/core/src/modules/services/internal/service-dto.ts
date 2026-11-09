/**
 * Service rows as the routes return them, and the order customer-scoped lists
 * are returned in.
 *
 * Moved from `apps/api/src/services/prisma.ts` (the row types and `to*Dto`
 * mappers) and `services/store.ts` (`sortServices`), bodies unchanged, when the
 * services routes became this module's slices (adopt-modular-vertical-slices 3C).
 * Shared by every slice that returns a service, so no two of them can map a
 * column differently.
 */
import type { Service, ServiceItem, UnitServiceRow } from "../contracts/http.js";

/** Customer and vehicle columns the labelled row needs, pulled in the same query. */
export type LabelRelations = {
  customer: { name: string | null } | null;
  vehicle: { plate: string | null; make: string | null; model: string | null; year: number | null } | null;
};

type DecimalLike = { toNumber(): number };

export function iso(value: Date): string {
  return value.toISOString();
}

function decimalToNumber(value: DecimalLike | null): number | null {
  return value === null ? null : value.toNumber();
}

type ItemRow = {
  id: string;
  serviceId: string;
  description: string;
  kind: string | null;
  quantity: number | null;
  unitAmount: DecimalLike | null;
  lineAmount: DecimalLike | null;
  oilViscosity: string | null;
  oilBrand: string | null;
};

export type ServiceRow = {
  id: string;
  customerId: string;
  vehicleId: string | null;
  omieId: string | null;
  unitId: string;
  performedAt: Date | null;
  description: string | null;
  kind: string | null;
  status: string | null;
  amount: DecimalLike | null;
  odometerKm: number | null;
  origin: string;
  createdAt: Date;
  updatedAt: Date;
  items: ItemRow[];
};

function toItemDto(row: ItemRow): ServiceItem {
  return {
    id: row.id,
    serviceId: row.serviceId,
    description: row.description,
    kind: row.kind,
    quantity: row.quantity,
    unitAmount: decimalToNumber(row.unitAmount),
    lineAmount: decimalToNumber(row.lineAmount),
    oilViscosity: row.oilViscosity,
    oilBrand: row.oilBrand,
  };
}

export function toServiceDto(row: ServiceRow): Service {
  return {
    id: row.id,
    customerId: row.customerId,
    vehicleId: row.vehicleId,
    omieId: row.omieId,
    unitId: row.unitId,
    performedAt: row.performedAt ? iso(row.performedAt) : null,
    description: row.description,
    kind: row.kind,
    status: row.status,
    amount: decimalToNumber(row.amount),
    odometerKm: row.odometerKm,
    origin: row.origin,
    items: row.items.map(toItemDto),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function toUnitRowDto(row: ServiceRow & LabelRelations): UnitServiceRow {
  return {
    ...toServiceDto(row),
    customerName: row.customer?.name ?? "",
    vehiclePlate: row.vehicle?.plate ?? null,
    vehicleMake: row.vehicle?.make ?? null,
    vehicleModel: row.vehicle?.model ?? null,
    vehicleYear: row.vehicle?.year ?? null,
  };
}

/**
 * Orders service rows for customer-scoped HTTP: newest `performedAt` first, undated rows last.
 *
 * @param rows - Service DTOs; only `id` and `performedAt` affect order.
 * @returns A new array (does not mutate `rows`). Ties among null dates keep relative order.
 */
export function sortServices(rows: Service[]): Service[] {
  return [...rows].sort((a, b) => {
    if (a.performedAt === null && b.performedAt === null) {
      return 0;
    }
    if (a.performedAt === null) {
      return 1;
    }
    if (b.performedAt === null) {
      return -1;
    }
    return b.performedAt.localeCompare(a.performedAt);
  });
}

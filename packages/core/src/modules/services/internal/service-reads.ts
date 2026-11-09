/**
 * Reads two services slices share: a customer's services, and whether a
 * customer belongs to the caller's loja.
 *
 * `servicesOfCustomer` is `apps/api/src/services/prisma.ts`'s `listByCustomer`,
 * body unchanged. `customerUnitId` stands for the one thing the routes read off
 * `cadastroStore.getCustomer`: the loja. `customer` is `customers`' table, read
 * here as a foreign read (`readableBy: "*"`), because `customers` is not a module
 * yet (4B) and a module may not import `apps/api`.
 */
import type { Service } from "../contracts/http.js";
import type { DbClient } from "../../../kernel/db.js";
import { sortServices, toServiceDto } from "./service-dto.js";

/**
 * Every service of one customer, newest `performedAt` first, undated last.
 *
 * @param tx - A client under `module_services`.
 * @param customerId - CRM customer primary key (not the Omie id).
 * @returns The customer's services, possibly empty.
 */
export async function servicesOfCustomer(tx: DbClient, customerId: string): Promise<Service[]> {
  const rows = await tx.service.findMany({
    where: { customerId },
    include: { items: true },
  });
  return sortServices(rows.map(toServiceDto));
}

/**
 * The loja a customer belongs to.
 *
 * @param tx - A client under `module_services`.
 * @param customerId - CRM customer primary key.
 * @returns `undefined` for an unknown customer; otherwise its `unitId`, which is
 *   null for a customer in no loja — a third case every caller must treat as
 *   "not in the caller's loja".
 */
export async function customerUnitId(
  tx: DbClient,
  customerId: string,
): Promise<string | null | undefined> {
  const row = await tx.customer.findUnique({
    where: { id: customerId },
    select: { unitId: true },
  });
  return row === null ? undefined : row.unitId;
}

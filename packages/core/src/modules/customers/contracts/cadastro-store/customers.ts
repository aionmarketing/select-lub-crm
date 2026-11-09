/**
 * Customer reads and writes of the cadastro store.
 *
 * Moved from `apps/api/src/cadastro/prisma.ts` with bodies unchanged, except that
 * `saveCustomer` no longer opens its own transaction: every store call is one
 * `db.tx("customers", …)` (see `index.ts`).
 */
import type { DbClient } from "@select-lub/core/db";
import type { CadastroStore } from "./port.js";
import { toCustomer, toVehicle } from "./rows.js";

/** The customer methods of the cadastro store. */
export type CustomerMethods = Pick<
  CadastroStore,
  "getCustomer" | "saveCustomer" | "findCustomerByPhone" | "createWhatsappCadastro" | "findCustomerByOmieId"
>;

/**
 * The customer methods, over one client.
 *
 * @param prisma - The `customers` transaction the call runs in.
 * @returns The methods, with their bodies as the API's store had them.
 */
export function customerMethods(prisma: DbClient): CustomerMethods {
  return {
    async getCustomer(id) {
      const row = await prisma.customer.findUnique({
        where: { id },
        include: { phones: true, emails: true } });
      return row ? toCustomer(row) : null;
    },
    async saveCustomer(customer) {
      // One db.tx per store call: these statements commit or fail together.
      const tx = prisma;
      await tx.customer.update({
        where: { id: customer.id },
        data: {
          name: customer.name,
          omieId: customer.omieId,
          taxId: customer.taxId,
          unitId: customer.unitId,
          givenName: customer.givenName,
          familyName: customer.familyName,
          mergedIntoId: customer.mergedIntoId,
          street: customer.street,
          streetNumber: customer.streetNumber,
          neighborhood: customer.neighborhood,
          complement: customer.complement,
          city: customer.city,
          state: customer.state,
          postalCode: customer.postalCode,
          country: customer.country,
          origin: customer.origin,
          status: customer.status } });
      await tx.customerPhone.deleteMany({ where: { customerId: customer.id } });
      await tx.customerEmail.deleteMany({ where: { customerId: customer.id } });
      if (customer.phones.length > 0) {
        await tx.customerPhone.createMany({
          data: customer.phones.map((phone) => ({
            customerId: customer.id,
            raw: phone.raw,
            normalized: phone.normalized,
            isPrimary: phone.isPrimary })) });
      }
      if (customer.emails.length > 0) {
        await tx.customerEmail.createMany({
          data: customer.emails.map((email) => ({
            customerId: customer.id,
            raw: email.raw,
            normalized: email.normalized,
            isPrimary: email.isPrimary })) });
      }
    },
    async findCustomerByPhone(unitId, normalized) {
      const phone = await prisma.customerPhone.findFirst({
        where: { normalized, customer: { unitId } },
        orderBy: { updatedAt: "desc" },
        include: { customer: { include: { phones: true, emails: true } } } });
      return phone ? toCustomer(phone.customer) : null;
    },
    async createWhatsappCadastro(input) {
      const customer = await prisma.customer.create({
        data: {
          name: null,
          origin: "whatsapp",
          status: "active",
          unitId: input.unitId,
          phones: {
            create: {
              raw: input.phoneRaw,
              normalized: input.phoneNormalized,
              isPrimary: true } } },
        include: { phones: true, emails: true } });
      const vehicle = await prisma.vehicle.create({
        data: {
          customerId: customer.id,
          origin: "whatsapp" } });
      return { customer: toCustomer(customer), vehicle: toVehicle(vehicle) };
    },
    async findCustomerByOmieId(omieId) {
      const row = await prisma.customer.findUnique({
        where: { omieId },
        include: { phones: true, emails: true } });
      return row ? toCustomer(row) : null;
    },
  };
}

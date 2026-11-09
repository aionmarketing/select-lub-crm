/**
 * The three methods only the ERP pull calls: link candidates, the link itself, and the
 * first-link upsert.
 *
 * `listUnlinkedMatchCandidates` is the 3A pull store's body VERBATIM (4B ruling D4):
 * only the pull calls it, and no moved test pins the API store's extra filter, so the
 * version production runs stays (the filter is an owner item).
 *
 * `saveCustomerColumns` is the 3A pull store's `saveCustomer` body VERBATIM (4B review
 * fix 1): the match pass links a candidate read before the slow Omie listing, so it must
 * write exactly what it wrote before 4B — the columns — and never replace the contact
 * rows, or a phone an attendant added in that window is deleted by the link.
 *
 * `upsertByOmieId` is the UNION (4B, D5 overridden): the API store's field mapping and
 * contact-row writes on create and update — pinned by the moved from-snapshot test,
 * the written oracle for this method — plus the pull store's unit assignment on
 * create (Select Lub for the TIDSCI dataset, else the oldest unit), without which a
 * pulled customer is unit-less and invisible. A behaviour FIX of the pull: its old
 * body wrote no phone, e-mail, street number, neighbourhood, complement, city or
 * state, so a pulled customer could not be found by phone until the next pull.
 */
import type { DbClient } from "@select-lub/core/db";
import type { CadastroStore } from "./port.js";
import { toCustomer } from "./rows.js";
import { countryFromWire, unitIdForNewTidsciCustomer } from "../../../../kernel/clients/erp-mock.js";
import { nameFromRazaoSocial, retainStoredName } from "../from-snapshot.js";

/** The pull-only methods of the cadastro store. */
export type PullMethods = Pick<
  CadastroStore,
  "listUnlinkedMatchCandidates" | "saveCustomerColumns" | "upsertByOmieId"
>;

/**
 * The pull-only methods, over one client.
 *
 * @param prisma - The `customers` transaction the call runs in.
 * @returns The methods, with their bodies as the API's store had them.
 */
export function pullMethods(prisma: DbClient, env: NodeJS.ProcessEnv): PullMethods {
  return {
    async listUnlinkedMatchCandidates(scope) {
      const rows = await prisma.customer.findMany({
        where: {
          omieId: null,
          OR: [{ taxId: { not: null } }, { phones: { some: { isPrimary: true } } }],
          // No scope: database-wide, as production runs it.
          ...(scope ? { id: { in: [...scope.customerIds] } } : {}),
        },
        include: { phones: true, emails: true },
      });
      return rows.map((row) => ({
        ...row,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        phones: row.phones.map((phone) => ({
          raw: phone.raw,
          normalized: phone.normalized,
          isPrimary: phone.isPrimary,
          updatedAt: phone.updatedAt.toISOString(),
        })),
        emails: row.emails,
      }));
    },
    async saveCustomerColumns(customer) {
      await prisma.customer.update({
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
          status: customer.status,
        },
      });
    },
    async upsertByOmieId(input) {
      const existing = await prisma.customer.findUnique({
        where: { omieId: input.omieId },
        include: { phones: true, emails: true } });
      const phoneDigits = (input.snapshot.telefone ?? "").replace(/\D/g, "");
      const email = input.snapshot.email && input.snapshot.email !== "" ? input.snapshot.email : null;
      const incomingName = nameFromRazaoSocial(input.snapshot.razao_social);
      const data = {
        name: retainStoredName(existing?.name, incomingName),
        taxId: input.snapshot.cnpj_cpf,
        street: input.snapshot.endereco,
        streetNumber: input.snapshot.endereco_numero,
        neighborhood: input.snapshot.bairro,
        complement: input.snapshot.complemento,
        city: input.snapshot.cidade,
        state: input.snapshot.estado,
        postalCode: input.snapshot.cep,
        country: countryFromWire(input.snapshot.codigo_pais) };
      if (existing) {
        // One db.tx per store call: these statements commit or fail together.
        const tx = prisma;
        await tx.customer.update({
          where: { id: existing.id },
          data });
        await tx.customerPhone.deleteMany({ where: { customerId: existing.id } });
        await tx.customerEmail.deleteMany({ where: { customerId: existing.id } });
        if (phoneDigits !== "") {
          await tx.customerPhone.create({
            data: {
              customerId: existing.id,
              raw: input.snapshot.telefone ?? phoneDigits,
              normalized: phoneDigits,
              isPrimary: true } });
        }
        if (email) {
          await tx.customerEmail.create({
            data: {
              customerId: existing.id,
              raw: email,
              normalized: email.toLowerCase(),
              isPrimary: true } });
        }
        const saved = await prisma.customer.findUniqueOrThrow({
          where: { id: existing.id },
          include: { phones: true, emails: true } });
        return toCustomer(saved);
      }
      const selectLub = await prisma.unit.findFirst({ where: { name: "Select Lub" } });
      const oldest = selectLub ?? (await prisma.unit.findFirst({ orderBy: { createdAt: "asc" } }));
      const unitId = unitIdForNewTidsciCustomer(
        env.OMIE_MOCK_DATASET,
        [selectLub, oldest].filter((row): row is NonNullable<typeof row> => row != null),
      );
      const created = await prisma.customer.create({
        data: {
          ...data,
          omieId: input.omieId,
          unitId,
          origin: "OMIE_SYNC",
          status: "active",
          phones:
            phoneDigits === ""
              ? undefined
              : {
                  create: {
                    raw: input.snapshot.telefone ?? phoneDigits,
                    normalized: phoneDigits,
                    isPrimary: true } },
          emails: email
            ? { create: { raw: email, normalized: email.toLowerCase(), isPrimary: true } }
            : undefined },
        include: { phones: true, emails: true } });
      return toCustomer(created);
    },
  };
}

/**
 * Demo rows that share identifiers with `mockOmieDataset` so seed-then-import is a no-op.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import { mockOmieDataset } from "../../src/kernel/clients/erp-mock/mock/dataset.js";

const LINKED_CUSTOMER_ID = "seed-omie-mock-linked";
const MATCHABLE_CUSTOMER_ID = "seed-omie-mock-matchable";
const DUP_A_CUSTOMER_ID = "seed-omie-mock-dup-a";
const DUP_B_CUSTOMER_ID = "seed-omie-mock-dup-b";
const VEHICLE_ID = "seed-omie-mock-veh";
const SERVICE_ID = "seed-omie-mock-os";

/**
 * Returns the mock Omie rows the demo seed writes, keyed by the shared dataset identifiers.
 *
 * Refuses rather than seeding a partial surface: demo-seed requires the dataset
 * to demonstrate every mocked Omie surface, so an identifier that has gone
 * missing from the mock dataset (core's `kernel/clients/erp-mock`, formerly `@select-lub/omie`) must stop the seed, not quietly write five of
 * the six rows and leave the sixth screen empty.
 *
 * @param data - The shared mock dataset. Injectable so the refusal above can be
 *   sampled without mocking the package; production callers pass nothing.
 * @returns Linked/unlinked/duplicate customers, OS, catalog product, and vehicle id from `mockOmieDataset()`.
 */
export function mockOmieSeedPlan(data: ReturnType<typeof mockOmieDataset> = mockOmieDataset()) {
  const linked = data.clients.find((row) => row.omieId === "omie-mock-linked");
  const matchable = data.clients.find((row) => row.omieId === "omie-mock-matchable");
  const dupA = data.clients.find((row) => row.omieId === "omie-mock-dup-a");
  const dupB = data.clients.find((row) => row.omieId === "omie-mock-dup-b");
  const service = data.serviceOrders.find((row) => row.omieId === "os-mock-1");
  const product = data.products.find((row) => row.omieId === "cat-motul-8100-5w30");
  const vehicle = data.vehicleIds.find((row) => row.vehicleOmieId === "veh-omie-mock-1");
  if (!linked || !matchable || !dupA || !dupB || !service || !product || !vehicle) {
    throw new Error("mockOmieDataset is missing a required mock Omie identifier");
  }
  return {
    linked: { crmId: LINKED_CUSTOMER_ID, ...linked },
    matchable: { crmId: MATCHABLE_CUSTOMER_ID, ...matchable },
    dupA: { crmId: DUP_A_CUSTOMER_ID, ...dupA },
    dupB: { crmId: DUP_B_CUSTOMER_ID, ...dupB },
    service: { crmId: SERVICE_ID, ...service },
    product,
    vehicle: { crmId: VEHICLE_ID, ...vehicle },
  };
}

/**
 * Upserts the mock Omie demo rows for one unit. Safe to re-run. Does not call Omie.
 *
 * @param prisma - Shared Prisma client.
 * @param unitId - Primary loja id for linked rows and the OS unit.
 */
export async function seedMockOmieDataset(prisma: PrismaClient, unitId: string) {
  const plan = mockOmieSeedPlan();

  await upsertMockCustomer(prisma, {
    id: plan.linked.crmId,
    name: plan.linked.snapshot.razao_social,
    omieId: plan.linked.omieId,
    unitId,
    taxId: plan.linked.snapshot.cnpj_cpf,
    postalCode: plan.linked.snapshot.cep,
    phone: plan.linked.snapshot.telefone,
  });
  await upsertMockCustomer(prisma, {
    id: plan.matchable.crmId,
    name: plan.matchable.snapshot.razao_social,
    omieId: null,
    unitId,
    taxId: plan.matchable.snapshot.cnpj_cpf,
    postalCode: plan.matchable.snapshot.cep,
    phone: plan.matchable.snapshot.telefone,
  });
  await upsertMockCustomer(prisma, {
    id: plan.dupA.crmId,
    name: plan.dupA.snapshot.razao_social,
    omieId: plan.dupA.omieId,
    unitId,
    taxId: plan.dupA.snapshot.cnpj_cpf,
    postalCode: null,
    phone: null,
  });
  await upsertMockCustomer(prisma, {
    id: plan.dupB.crmId,
    name: plan.dupB.snapshot.razao_social,
    omieId: plan.dupB.omieId,
    unitId,
    taxId: plan.dupB.snapshot.cnpj_cpf,
    postalCode: null,
    phone: null,
  });

  await prisma.vehicle.upsert({
    where: { id: plan.vehicle.crmId },
    create: {
      id: plan.vehicle.crmId,
      customerId: plan.linked.crmId,
      omieId: plan.vehicle.vehicleOmieId,
      plate: plan.vehicle.plate,
      origin: "omie",
    },
    update: {
      omieId: plan.vehicle.vehicleOmieId,
      plate: plan.vehicle.plate,
      origin: "omie",
    },
  });

  await prisma.service.upsert({
    where: { id: plan.service.crmId },
    create: {
      id: plan.service.crmId,
      customerId: plan.linked.crmId,
      vehicleId: plan.vehicle.crmId,
      unitId,
      omieId: plan.service.omieId,
      performedAt: plan.service.performedAt ? new Date(plan.service.performedAt) : null,
      description: plan.service.description,
      kind: plan.service.kind,
      status: plan.service.status,
      amount: plan.service.amount,
      odometerKm: plan.service.odometerKm,
      origin: "omie",
    },
    update: {
      omieId: plan.service.omieId,
      origin: "omie",
      description: plan.service.description,
    },
  });
}

async function upsertMockCustomer(
  prisma: PrismaClient,
  input: {
    id: string;
    name: string | null;
    omieId: string | null;
    unitId: string;
    taxId: string | null;
    postalCode: string | null;
    phone: string | null;
  },
) {
  await prisma.customer.upsert({
    where: { id: input.id },
    create: {
      id: input.id,
      name: input.name,
      omieId: input.omieId,
      taxId: input.taxId,
      unitId: input.unitId,
      postalCode: input.postalCode,
      origin: "omie",
      status: "active",
      country: "br",
    },
    update: {
      name: input.name,
      omieId: input.omieId,
      taxId: input.taxId,
      unitId: input.unitId,
      postalCode: input.postalCode,
      mergedIntoId: null,
    },
  });
  const phone = input.phone?.replace(/\D/g, "") ?? "";
  if (phone === "") {
    return;
  }
  try {
    await prisma.customerPhone.upsert({
      where: { customerId_normalized: { customerId: input.id, normalized: phone } },
      create: {
        id: `${input.id}-phone`,
        customerId: input.id,
        raw: input.phone ?? phone,
        normalized: phone,
        isPrimary: true,
      },
      update: {
        raw: input.phone ?? phone,
        isPrimary: true,
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return;
    }
    throw error;
  }
}

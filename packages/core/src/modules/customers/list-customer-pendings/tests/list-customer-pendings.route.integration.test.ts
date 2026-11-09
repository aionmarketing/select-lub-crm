/**
 * Test design (testing-strategy)
 *
 * Moved from apps/api/src/cadastro.test.ts (adopt-modular-vertical-slices 4B);
 *   runs under module_customers.
 *
 * SUT: `GET /customers/:id/reconciliation-pendings` over HTTP — this slice's route,
 *   mounted alone on the kernel app by `buildSliceApp`, over the test's rolling-back
 *   transaction, with the caller stated rather than resolved by apps/api's auth
 *   hook. The pending is opened by the real engine ingest (R4) against
 *   `createFakeOmie`, which this route never reads; the engine's R1–R4 are not re-run here.
 *
 *   The original file's other cases: PATCH in `update-customer`, resolve in
 *   `resolve-pending`, the conversation customer in `get-conversation-customer` and
 *   `link-conversation-customer`, the unit-wide list in `list-unit-pendings`. Its
 *   403 case ("unit header is not a membership", on this route) is the auth hook's,
 *   and moved to `apps/api/test/customers.integration.test.ts`.
 *
 * Oracle: cadastro-reconciliation-backend omie-sync (HTTP apply + resolve).
 *
 * Sampled-cell
 *   GET empty / one pending             | GET         | [] then 1 | wrong length
 *
 * Decision / branch map (list-customer-pendings/index.ts)
 *   customer missing or unit mismatch   F the it below (the 404 arm is sampled on the
 *     sibling routes, update-customer and resolve-pending)
 *   `if (!unitId)` — contract-hidden: apps/api's hook answers 403/401 first
 */
import { prisma, type PrismaClient } from "@select-lub/core/db";
import { createFakeOmie, emptySnapshot } from "../../../../kernel/clients/erp-mock.js";
import { ingestOmieSnapshot } from "../../contracts/cadastro-engine/index.js";
import { reconciliationPendingSchema } from "../../contracts/http.js";
import { expect, it } from "vitest";
import { createDb, type DbClient } from "../../../../kernel/db.js";
import { registerSlice } from "../../../../kernel/http.js";
import {
  buildSliceApp,
  describeWithDatabase,
  runInTransactionOnTx,
  seedUnit,
  seedUser,
  withTestTransaction,
} from "../../../../testing/index.js";
import { createCadastroStore } from "../../contracts/cadastro-store/index.js";
import { route } from "../index.js";

/** The Omie characteristic the plate travels in; mirrors CARACTERISTICA_CAMPOS.plate. */
const PLATE_CAMPO = "Placa";
/** The customer's stored postal code, in step with Omie at the start of every case. */
const CEP = "01310100";

/**
 * Seeds a unit, the attendant, and one linked customer with a vehicle, builds the
 * Omie fake, then mounts this slice on the test transaction.
 *
 * @param tx - The test transaction.
 * @returns The app, ids, the Omie fake and the cadastro store.
 */
async function seedApp(tx: DbClient) {
  const unit = await seedUnit(tx);
  const user = await seedUser(tx, { units: [unit.id] });
  const fake = createFakeOmie();
  const omieId = "omie-http-1";

  const customer = await tx.customer.create({
    data: {
      name: "Ana",
      omieId,
      unitId: unit.id,
      postalCode: CEP,
      origin: "manual",
      status: "active",
    },
    select: { id: true },
  });
  await tx.vehicle.create({
    data: { customerId: customer.id, plate: "ABC1D23", origin: "manual" },
  });

  fake.seed(omieId, {
    ...emptySnapshot(),
    razao_social: "Ana",
    cep: CEP,
    caracteristicas: [{ campo: PLATE_CAMPO, conteudo: "ABC1D23" }],
  });
  // Both fields in step with Omie, so the first CRM edit is a clean push.
  await tx.customerFieldSync.createMany({
    data: (
      [
        ["name", "Ana"],
        ["postalCode", CEP],
      ] as const
    ).map(([fieldKey, wire]) => ({
      customerId: customer.id,
      fieldKey,
      origin: "CRM",
      localVersion: 1,
      externalVersion: 1,
      syncedLocalVersion: 1,
      syncedExternalVersion: 1,
      lastOmieWire: wire,
    })),
  });

  const db = createDb(tx, runInTransactionOnTx(tx));
  const app = await buildSliceApp({
    db,
    plugin: (a) => registerSlice(a, "customers", "list-customer-pendings", route),
    caller: { userId: user.id, unitId: unit.id },
  });
  return { app, customerId: customer.id, fake, cadastro: createCadastroStore(db) };
}

/**
 * Drives the customer's postal code into a two-sided conflict: CRM moved it and
 * Omie moved it the other way, so the ingest opens a pending.
 *
 * @param tx - The test transaction.
 * @param ctx - A context from {@link seedApp}.
 */
async function openPostalCodeConflict(
  tx: DbClient,
  ctx: Awaited<ReturnType<typeof seedApp>>,
): Promise<void> {
  const customer = (await ctx.cadastro.getCustomer(ctx.customerId))!;
  customer.postalCode = "CRMCEP12";
  await ctx.cadastro.saveCustomer(customer);
  await tx.customerFieldSync.update({
    where: { customerId_fieldKey: { customerId: ctx.customerId, fieldKey: "postalCode" } },
    data: { localVersion: 2 },
  });
  ctx.fake.seed("omie-http-1", { ...(await ctx.fake.get("omie-http-1"))!, cep: "OMIECEP1" });
  await ingestOmieSnapshot(ctx.cadastro, ctx.fake, ctx.customerId);
}

describeWithDatabase("GET /customers/:id/reconciliation-pendings", () => {
  const db = () => prisma as PrismaClient;

  it("returns 200 empty pendings then one open row after engine R4", () =>
    withTestTransaction(db(), async (tx) => {
      const ctx = await seedApp(tx);

      const empty = await ctx.app.inject({
        method: "GET",
        url: `/customers/${ctx.customerId}/reconciliation-pendings`,
      });
      expect(empty.statusCode).toBe(200);
      expect(empty.json()).toEqual([]);

      await openPostalCodeConflict(tx, ctx);

      const listed = await ctx.app.inject({
        method: "GET",
        url: `/customers/${ctx.customerId}/reconciliation-pendings`,
      });
      expect(listed.statusCode).toBe(200);
      expect(listed.json()).toHaveLength(1);
      expect(reconciliationPendingSchema.parse(listed.json()[0]).status).toBe("open");
      await ctx.app.close();
    }));
});

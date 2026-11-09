/**
 * Test design (testing-strategy)
 *
 * Moved from apps/api/src/cadastro.test.ts (adopt-modular-vertical-slices 4B);
 *   runs under module_customers.
 *
 * SUT: `POST /customers/:id/reconciliation-pendings/resolve` over HTTP — this
 *   slice's route, mounted alone on the kernel app by `buildSliceApp`, over the
 *   test's rolling-back transaction, with the caller stated rather than resolved by
 *   apps/api's auth hook. The Omie adapter is `createFakeOmie`, bound as the ERP
 *   port. Does not re-run the engine's R1–R4 through HTTP.
 *
 *   Changed with the move: the "choice omie" case used to confirm the pending was
 *   gone through a second route, `GET /customers/:id/reconciliation-pendings`. A
 *   slice's tests mount only their own route, so it now reads the open pendings
 *   through the cadastro store's `listOpenPendings`, which is what that GET lists.
 *   The "other membership unit" case switched unit through the `x-unit-id` header;
 *   it now states the caller in the other unit (a member of both).
 *
 *   The original file's other cases: see `update-customer.route.integration.test.ts`.
 *
 * Oracle: cadastro-reconciliation-backend omie-sync (HTTP resolve).
 *
 * Axes
 *   A3 resolve — omie / missing pending / unit mismatch / crm+throw
 *
 * Sampled-cell
 *   resolve omie drops the pending      | A3 omie     | 200 + [] | still open
 *   resolve missing pending             | A3 miss     | 404 | field changes
 *   resolve other membership unit       | A3 unit     | 404 | 200
 *   resolve crm put throw               | A3 throw    | 503 + still open | 200 or closed
 *
 * Decision / branch map (resolve-pending/index.ts)
 *   pending_not_found catch             T missing-pending it; F omie it
 *   not_found / unit_mismatch           T other-unit it; F omie it
 *   omie_unavailable                    T crm-throw it; F omie it
 *   `if (!unitId)` / `!crmUserId` — contract-hidden: apps/api's hook answers first
 *   catch pending_not_found F           throw — infeasible unless the engine
 *     throws some other Error
 *
 * Out of scope: engine pairing XOR (resolve-pending.choices.integration.test.ts).
 */
import { prisma, type PrismaClient } from "@select-lub/core/db";
import { createFakeOmie, emptySnapshot } from "../../../../kernel/clients/erp-mock.js";
import { ingestOmieSnapshot } from "../../contracts/cadastro-engine/index.js";
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
 * Seeds a unit, the attendant, and one linked customer with a vehicle, passes the
 * Omie fake to the route, then mounts this slice on the test transaction.
 *
 * @param tx - The test transaction.
 * @param options - `extraUnits`, appended to the attendant's memberships, and
 *   `callerUnitId`, the unit the request is scoped to (default: the customer's).
 * @returns The app, ids, the Omie fake and the cadastro store.
 */
async function seedApp(
  tx: DbClient,
  options: { extraUnits?: string[]; callerUnitId?: string } = {},
) {
  const unit = await seedUnit(tx);
  const unitIds = [unit.id, ...(options.extraUnits ?? [])];
  const user = await seedUser(tx, { units: unitIds });
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
    plugin: (a) => registerSlice(a, "customers", "resolve-pending", route({ omieAdapter: fake })),
    caller: { userId: user.id, unitId: options.callerUnitId ?? unit.id, unitIds },
  });
  return {
    app,
    customerId: customer.id,
    fake,
    cadastro: createCadastroStore(db),
    jsonHeaders: { "content-type": "application/json" },
  };
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

describeWithDatabase("POST /customers/:id/reconciliation-pendings/resolve", () => {
  const db = () => prisma as PrismaClient;

  it("resolves an open pending with choice omie and drops it from the open list", () =>
    withTestTransaction(db(), async (tx) => {
      const ctx = await seedApp(tx);
      await openPostalCodeConflict(tx, ctx);

      const resolved = await ctx.app.inject({
        method: "POST",
        url: `/customers/${ctx.customerId}/reconciliation-pendings/resolve`,
        headers: ctx.jsonHeaders,
        payload: { fieldKey: "postalCode", vehicleId: null, choice: "omie" },
      });

      expect(resolved.statusCode).toBe(200);
      expect(resolved.json().postalCode).toBe("OMIECEP1");

      // Was a second route (GET .../reconciliation-pendings); that route lists
      // exactly `listOpenPendings`, read here through the store.
      expect(await ctx.cadastro.listOpenPendings(ctx.customerId)).toEqual([]);
      await ctx.app.close();
    }));

  it("returns 503 and keeps the pending open when resolve crm put throws", () =>
    withTestTransaction(db(), async (tx) => {
      const ctx = await seedApp(tx);
      await openPostalCodeConflict(tx, ctx);
      ctx.fake.failPuts();

      const response = await ctx.app.inject({
        method: "POST",
        url: `/customers/${ctx.customerId}/reconciliation-pendings/resolve`,
        headers: ctx.jsonHeaders,
        payload: { fieldKey: "postalCode", vehicleId: null, choice: "crm" },
      });

      expect(response.statusCode).toBe(503);
      expect(response.json().postalCode).toBe("CRMCEP12");
      expect(
        (await ctx.cadastro.getOpenPending({ customerId: ctx.customerId }, "postalCode"))?.status,
      ).toBe("open");
      await ctx.app.close();
    }));

  it("returns 404 when resolve targets a field with no open pending", () =>
    withTestTransaction(db(), async (tx) => {
      const ctx = await seedApp(tx);
      const before = (await ctx.cadastro.getCustomer(ctx.customerId))!.name;

      const response = await ctx.app.inject({
        method: "POST",
        url: `/customers/${ctx.customerId}/reconciliation-pendings/resolve`,
        headers: ctx.jsonHeaders,
        payload: { fieldKey: "postalCode", vehicleId: null, choice: "crm" },
      });

      expect(response.statusCode).toBe(404);
      expect((await ctx.cadastro.getCustomer(ctx.customerId))?.name).toBe(before);
      await ctx.app.close();
    }));

  it("returns 404 when resolve uses a membership unit that is not the customer's", () =>
    withTestTransaction(db(), async (tx) => {
      const other = await seedUnit(tx);
      // The attendant IS a member of `other`, so apps/api's hook would let the
      // request through, and the 404 comes from the customer's unit not matching
      // — the distinction the hook's 403 (apps/api/test) would otherwise hide.
      const ctx = await seedApp(tx, { extraUnits: [other.id], callerUnitId: other.id });

      const response = await ctx.app.inject({
        method: "POST",
        url: `/customers/${ctx.customerId}/reconciliation-pendings/resolve`,
        headers: ctx.jsonHeaders,
        payload: { fieldKey: "postalCode", vehicleId: null, choice: "crm" },
      });

      expect(response.statusCode).toBe(404);
      await ctx.app.close();
    }));
});

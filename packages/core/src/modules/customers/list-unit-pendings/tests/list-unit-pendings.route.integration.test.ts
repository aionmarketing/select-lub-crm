/**
 * Test design (testing-strategy)
 *
 * Moved from apps/api/src/cadastro.test.ts (adopt-modular-vertical-slices 4B);
 *   runs under module_customers.
 *
 * SUT: `GET /reconciliation-pendings` over HTTP — this slice's route, mounted alone
 *   on the kernel app by `buildSliceApp`, over the test's rolling-back transaction,
 *   with the caller stated rather than resolved by apps/api's auth hook. The Omie
 *   fake is still built, as the original setup built it; this route never reads it
 *   and takes no adapter.
 *
 *   The "excludes other units" case made the attendant a member of the other unit
 *   too; that is now the stated caller's `unitIds`, with the request still scoped
 *   to the caller's own unit.
 *
 *   The original file's other cases: see `update-customer.route.integration.test.ts`.
 *
 * Oracle: cadastro-reconciliation-backend omie-sync (global list).
 *
 * Axes
 *   A5 global list — empty / two in-unit + one other-unit
 *
 * Sampled-cell
 *   global list empty                   | A5 empty    | [] | rows
 *   global list spans + excludes unit   | A5 two+one  | 2, no other unit | leak or 1
 *
 * Decision / branch map (list-unit-pendings/index.ts)
 *   global list length 0 / >0           T empty it / spans it
 *   `if (!unitId)` — contract-hidden: apps/api's hook answers 403/401 first
 */
import { prisma, type PrismaClient } from "@select-lub/core/db";
import { createFakeOmie, emptySnapshot } from "../../../../kernel/clients/erp-mock.js";
import { globalReconciliationPendingSchema } from "../../contracts/http.js";
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
 * Seeds a unit, the attendant, and one customer with a vehicle, builds the Omie fake,
 * then mounts this slice on the test transaction.
 *
 * @param tx - The test transaction.
 * @param options - `omieId` (default `"omie-http-1"`; `null` for an unlinked
 *   customer) and `extraUnits`, appended to the attendant's memberships.
 * @returns The app, the unit, the customer id and the cadastro store.
 */
async function seedApp(
  tx: DbClient,
  options: { omieId?: string | null; extraUnits?: string[] } = {},
) {
  const unit = await seedUnit(tx);
  const unitIds = [unit.id, ...(options.extraUnits ?? [])];
  const user = await seedUser(tx, { units: unitIds });
  const fake = createFakeOmie();
  const omieId = options.omieId === undefined ? "omie-http-1" : options.omieId;

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

  if (omieId) {
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
  }

  const db = createDb(tx, runInTransactionOnTx(tx));
  const app = await buildSliceApp({
    db,
    plugin: (a) => registerSlice(a, "customers", "list-unit-pendings", route),
    caller: { userId: user.id, unitId: unit.id, unitIds },
  });
  return { app, unit, customerId: customer.id, cadastro: createCadastroStore(db) };
}

describeWithDatabase("GET /reconciliation-pendings", () => {
  const db = () => prisma as PrismaClient;

  it("returns an empty global pendings list when the unit has none", () =>
    withTestTransaction(db(), async (tx) => {
      const ctx = await seedApp(tx);

      const response = await ctx.app.inject({
        method: "GET",
        url: "/reconciliation-pendings",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([]);
      await ctx.app.close();
    }));

  it("lists open pendings across customers in the unit and excludes other units", () =>
    withTestTransaction(db(), async (tx) => {
      const other = await seedUnit(tx);
      const ctx = await seedApp(tx, { omieId: null, extraUnits: [other.id] });
      const make = async (name: string, unitId: string) =>
        tx.customer.create({
          data: { name, unitId, origin: "manual", status: "active" },
          select: { id: true },
        });
      const bia = await make("Bia", ctx.unit.id);
      const cris = await make("Cris", other.id);
      // Ana (from seedApp) and Bia are in the caller's unit; Cris is not.
      for (const [customerId, crmValue, omieValue] of [
        [ctx.customerId, "11111111", "22222222"],
        [bia.id, "Bia", "BIA LTDA"],
        [cris.id, "Cris", "CRIS LTDA"],
      ] as const) {
        await ctx.cadastro.saveOpenPending({
          fieldKey: customerId === ctx.customerId ? "postalCode" : "name",
          crmValue,
          omieValue,
          localVersion: 2,
          externalVersion: 2,
          status: "open",
          customerId,
          vehicleId: null,
        });
      }

      const listed = await ctx.app.inject({
        method: "GET",
        url: "/reconciliation-pendings",
      });

      expect(listed.statusCode).toBe(200);
      const rows = listed.json() as { customerId: string }[];
      // Both units were created in this transaction, so the only pendings
      // either can hold are the three above: a delta, not a global count.
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.customerId).sort()).toEqual(
        [ctx.customerId, bia.id].sort(),
      );
      for (const row of rows) {
        expect(globalReconciliationPendingSchema.parse(row).customerName).toMatch(/Ana|Bia/);
      }
      await ctx.app.close();
    }));
});

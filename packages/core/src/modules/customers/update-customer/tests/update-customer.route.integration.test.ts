/**
 * Test design (testing-strategy)
 *
 * Moved from apps/api/src/cadastro.test.ts (adopt-modular-vertical-slices 4B);
 *   runs under module_customers.
 *
 * SUT: `PATCH /customers/:id` over HTTP — this slice's route, mounted alone on the
 *   kernel app by `buildSliceApp`, over the test's rolling-back transaction, with the
 *   caller stated rather than resolved by apps/api's auth hook. The Omie adapter is
 *   `createFakeOmie`, passed to the route (`route({ omieAdapter })`), because it is
 *   an external service, not a store. Does not re-run the engine's R1–R4 through HTTP.
 *
 *   The original file's other cases went where their route is: the pending list
 *   to `list-customer-pendings`, resolve to `resolve-pending`, the conversation
 *   customer GET and POST to `get-conversation-customer` and
 *   `link-conversation-customer`, the unit-wide list to `list-unit-pendings`, and
 *   the hook's 403 to `apps/api/test/customers.integration.test.ts`.
 *
 * Oracle: cadastro-reconciliation-backend omie-sync (HTTP apply) and the older D7
 *   PATCH 404. Unlinked shared PATCH is 2xx persist, not 409.
 *
 * ASSERTIONS THAT ONLY HELD ON THE FAKE (from the original file)
 *   3. **The empty-name refusal was asserted as a range.** It read
 *      `toBeGreaterThanOrEqual(400)` and `toBeLessThan(500)`, which passes on a
 *      404 or a 409 as happily as on the schema rejection it is about. It is
 *      pinned to 400, with the 200 on the same route in the neighbouring cases
 *      as the positive control.
 *   4. **Ids were Map keys.** The customer, the vehicle and the units are
 *      FK-backed rows; `customer.omie_id` is additionally UNIQUE.
 *
 * Axes
 *   A1 PATCH body — shared / CRM-only / empty name / unlinked shared
 *   A2 adapter put — ok / throw
 *
 * Sampled-cell
 *   PATCH shared 2xx                    | A1 shared   | 200 | non-2xx or schema fail
 *   PATCH CRM-only 2xx no put           | A1 CRM-only | 200 | putCount > 0
 *   404 unknown id                      | not found   | 404 | 2xx
 *   2xx shared + omieId null            | A1 unlinked | 200 | 409 or putCount > 0
 *   400 empty name                      | A1 zod      | exactly 400 | any 4xx
 *   PATCH shared changed_by             | actor       | the caller's id | other id
 *   PATCH linked put throw              | A2 throw    | 503 + saved name | 200 or empty body
 *
 * Decision / branch map (update-customer/index.ts)
 *   omie_unavailable                    T 503 it; F 200 shared it
 *   `if (!unitId)` — contract-hidden: apps/api's hook answers 403/401 first
 *   not_linked 409                      T unlinked-shared is 200 persist; F linked 409
 */
import { prisma, type PrismaClient } from "@select-lub/core/db";
import { createFakeOmie, emptySnapshot } from "../../../../kernel/clients/erp-mock.js";
import { customerSchema } from "../../contracts/http.js";
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
 * Seeds a unit, the attendant, and one customer with a vehicle, passes the Omie fake
 * to the route, then mounts this slice on the test transaction.
 *
 * @param tx - The test transaction.
 * @param options - `omieId` (default `"omie-http-1"`; `null` for an unlinked customer).
 * @returns The app, ids, the Omie fake and the cadastro store.
 */
async function seedApp(tx: DbClient, options: { omieId?: string | null } = {}) {
  const unit = await seedUnit(tx);
  const user = await seedUser(tx, { units: [unit.id] });
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
    plugin: (a) => registerSlice(a, "customers", "update-customer", route({ omieAdapter: fake })),
    caller: { userId: user.id, unitId: unit.id },
  });
  return {
    app,
    unit,
    userId: user.id,
    customerId: customer.id,
    fake,
    cadastro: createCadastroStore(db),
    jsonHeaders: { "content-type": "application/json" },
  };
}

describeWithDatabase("PATCH /customers/:id", () => {
  const db = () => prisma as PrismaClient;

  it("returns 2xx for PATCH of a shared field with a matching unit header", () =>
    withTestTransaction(db(), async (tx) => {
      const ctx = await seedApp(tx);

      const response = await ctx.app.inject({
        method: "PATCH",
        url: `/customers/${ctx.customerId}`,
        headers: ctx.jsonHeaders,
        payload: { postalCode: "22041080" },
      });

      expect(response.statusCode).toBe(200);
      expect(customerSchema.safeParse(response.json()).success).toBe(true);
      expect(response.json().postalCode).toBe("22041080");
      await ctx.app.close();
    }));

  it("returns 2xx for PATCH of CRM-only fields without calling the adapter", () =>
    withTestTransaction(db(), async (tx) => {
      const ctx = await seedApp(tx);

      const response = await ctx.app.inject({
        method: "PATCH",
        url: `/customers/${ctx.customerId}`,
        headers: ctx.jsonHeaders,
        payload: { givenName: "Ana" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().givenName).toBe("Ana");
      expect(ctx.fake.putCount()).toBe(0);
      await ctx.app.close();
    }));

  it("returns 404 for an unknown customer id", () =>
    withTestTransaction(db(), async (tx) => {
      const ctx = await seedApp(tx);

      const response = await ctx.app.inject({
        method: "PATCH",
        url: "/customers/missing",
        headers: ctx.jsonHeaders,
        payload: { givenName: "Ana" },
      });

      expect(response.statusCode).toBe(404);
      await ctx.app.close();
    }));

  it("persists a shared key on an unlinked customer without calling Omie", () =>
    withTestTransaction(db(), async (tx) => {
      const ctx = await seedApp(tx, { omieId: null });

      const response = await ctx.app.inject({
        method: "PATCH",
        url: `/customers/${ctx.customerId}`,
        headers: ctx.jsonHeaders,
        payload: { name: "Maria" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().name).toBe("Maria");
      expect((await ctx.cadastro.getCustomer(ctx.customerId))?.name).toBe("Maria");
      expect(ctx.fake.putCount()).toBe(0);
      await ctx.app.close();
    }));

  it("records changed_by as the authenticated user on PATCH /customers/:id", () =>
    withTestTransaction(db(), async (tx) => {
      const ctx = await seedApp(tx);

      const response = await ctx.app.inject({
        method: "PATCH",
        url: `/customers/${ctx.customerId}`,
        headers: ctx.jsonHeaders,
        payload: { postalCode: "22041080" },
      });

      expect(response.statusCode).toBe(200);
      expect(
        (await ctx.cadastro.getSync({ customerId: ctx.customerId }, "postalCode"))?.changedBy,
      ).toBe(ctx.userId);
      await ctx.app.close();
    }));

  it("returns 400 when name is present and empty", () =>
    withTestTransaction(db(), async (tx) => {
      const ctx = await seedApp(tx);

      const response = await ctx.app.inject({
        method: "PATCH",
        url: `/customers/${ctx.customerId}`,
        headers: ctx.jsonHeaders,
        payload: { name: "" },
      });

      // Pinned, not a 4xx range: the same route answers 404 in the case above
      // (and 403 behind apps/api's hook), and a range would accept either of
      // those as this refusal.
      expect(response.statusCode).toBe(400);
      await ctx.app.close();
    }));

  it("returns 503 with the saved name when a linked PATCH put throws", () =>
    withTestTransaction(db(), async (tx) => {
      const ctx = await seedApp(tx);
      ctx.fake.failPuts();

      const response = await ctx.app.inject({
        method: "PATCH",
        url: `/customers/${ctx.customerId}`,
        headers: ctx.jsonHeaders,
        payload: { name: "Casa Salva" },
      });

      expect(response.statusCode).toBe(503);
      expect(response.json().name).toBe("Casa Salva");
      // The CRM side committed even though Omie refused: 503 reports the push,
      // not the save.
      expect((await ctx.cadastro.getCustomer(ctx.customerId))?.name).toBe("Casa Salva");
      await ctx.app.close();
    }));
});

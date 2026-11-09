/**
 * Test design (testing-strategy)
 *
 * Exercises the cadastro engine (`customers/contracts/cadastro-engine`) (`applyCrmEdit`) and its `http`
 * module (`createHttpOmieAdapter`) against the real cadastro store,
 * `createPrismaCadastroStore` in `apps/api/src/cadastro/prisma.ts`. Relocated from
 * `packages/omie/src/apply-http.test.ts`: `packages/db` depends on `packages/omie`,
 * so the Prisma adapter cannot live in the Omie package (design D6).
 *
 * Moved from `apps/api/src/cadastro/omie/apply-http.test.ts`
 * (adopt-modular-vertical-slices 4B); the store is now `createCadastroStore`
 * (contracts/cadastro-store), which runs every call under `module_customers`.
 *
 * Setup: real cadastro store on a rolled-back transaction + createHttpOmieAdapter
 * with a stubbed fetch. applyCrmEdit on a linked CRM-ahead postalCode.
 *
 * Fake-only assertion surfaced: the fake let `seedCustomer({ unitId: "unit-1" })`
 * name a unit that did not exist and `seedVehicle` name a customer that did not
 * exist, so the edit ran against a customer floating free of any tenant. Postgres
 * has foreign keys for both, so the fixture now seeds a real unit and hangs the
 * customer and vehicle off it — and the `unitId` the edit is called with is the
 * one actually stored on the row, which on the fake nothing checked.
 *
 * Oracle: omie-http-adapter — linked shared PATCH reaches Omie alterar
 * when HTTP is enabled; OMIE_SYNC still does not put (engine.test.ts R3).
 *
 * Axes
 *   A1 origin — CRM-ahead PATCH vs OMIE_SYNC apply
 *   A2 adapter — HTTP stub vs fake (four-cell stays in engine.test.ts)
 *
 * Sampled: HTTP alterar on CRM-ahead postalCode.
 * Decision: decideField crmAhead && !omieAhead T this it; F engine R3.
 * Out of scope: live credentials; four-cell on fake (engine.test.ts).
 */
import { randomUUID } from "node:crypto";
import { prisma, type PrismaClient } from "@select-lub/core/db";
import { applyCrmEdit } from "../../contracts/cadastro-engine/index.js";
import { createHttpOmieAdapter } from "../../../../kernel/clients/erp-mock.js";
import { emptySync } from "../../contracts/cadastro-store/port.js";
import { expect, it } from "vitest";
import { createDb } from "../../../../kernel/db.js";
import {
  describeWithDatabase,
  runInTransactionOnTx,
  seedUnit,
  withTestTransaction,
} from "../../../../testing/index.js";
import { createCadastroStore } from "../../contracts/cadastro-store/index.js";

describeWithDatabase("applyCrmEdit with HTTP adapter", () => {
  const db = () => prisma as PrismaClient;

  it("sends AlterarCliente for a CRM-ahead postalCode", () =>
    withTestTransaction(db(), async (tx) => {
      const bodies: Array<{ call: string; param: Array<Record<string, unknown>> }> = [];
      const fetchImpl = async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as (typeof bodies)[number];
        bodies.push(body);
        if (body.call === "ConsultarCliente") {
          return new Response(
            JSON.stringify({
              codigo_cliente_omie: 9,
              razao_social: "Ana",
              cep: "01310100",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ codigo_cliente_omie: 9 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      };
      const adapter = createHttpOmieAdapter({
        appKey: "k",
        appSecret: "s",
        fetch: fetchImpl as typeof fetch,
        sleep: async () => undefined,
        now: () => 0,
      });

      const unit = await seedUnit(tx);
      const customer = await tx.customer.create({
        data: {
          name: "Ana",
          omieId: `9-${randomUUID().slice(0, 8)}`,
          unitId: unit.id,
          postalCode: "01310100",
          origin: "CRM",
          status: "active",
        },
      });
      await tx.vehicle.create({ data: { customerId: customer.id, origin: "CRM" } });
      await tx.customerFieldSync.create({
        data: {
          customerId: customer.id,
          ...emptySync("postalCode"),
          lastAttemptedAt: null,
          localVersion: 1,
          externalVersion: 1,
          syncedLocalVersion: 1,
          syncedExternalVersion: 1,
          lastOmieWire: "01310100",
        },
      });
      const store = createCadastroStore(createDb(tx, runInTransactionOnTx(tx)));
      expect((await store.getCustomer(customer.id))?.unitId).toBe(unit.id);

      const result = await applyCrmEdit(store, adapter, {
        customerId: customer.id,
        unitId: unit.id,
        patch: { postalCode: "22041080" },
      });

      expect(result.status).toBe("ok");
      const alterar = bodies.find((body) => body.call === "AlterarCliente");
      expect(alterar?.param[0]?.cep).toBe("22041080");
      expect(alterar?.param[0]?.codigo_cliente_integracao).toBe(customer.id);
      expect((await tx.customer.findUniqueOrThrow({ where: { id: customer.id } })).postalCode).toBe(
        "22041080",
      );
    }));
});

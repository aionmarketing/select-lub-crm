/**
 * Rows and an app for the conversation-scoped services tests.
 *
 * Moved from `apps/api/src/customer-services.test.ts` (`insertService`,
 * `seedScope`, and `insertCustomer` which `seedScope` uses), unchanged — the
 * same helpers `list-customer-services`' tests carry, because a slice's tests
 * may not import another slice's. `appOn` registers THIS slice alone on the
 * harness app with the caller stated.
 */
import { randomUUID } from "node:crypto";
import type { DbClient } from "@select-lub/core/db";
import {
  buildSliceApp,
  runInTransactionOnTx,
  seedConnection,
  seedUnit,
  seedUser,
} from "@select-lub/core/testing";
import { createDb } from "../../../../kernel/db.js";
import { registerSlice } from "../../../../kernel/http.js";
import { route } from "../index.js";

/**
 * The slice on the harness app, over the test transaction, as the scope's caller.
 *
 * @param tx - The test transaction.
 * @param scope - The caller's user id and loja, from {@link seedScope}.
 * @returns The app; the caller closes it.
 */
export async function appOn(tx: DbClient, scope: { userId: string; unitId: string }) {
  return buildSliceApp({
    db: createDb(tx, runInTransactionOnTx(tx)),
    plugin: (app) => registerSlice(app, "services", "list-conversation-services", route),
    caller: { userId: scope.userId, unitId: scope.unitId },
  });
}

export async function insertCustomer(
  tx: DbClient,
  input: { unitId: string | null; name?: string | null },
) {
  return tx.customer.create({
    data: {
      origin: "crm",
      status: "active",
      name: input.name ?? "Ana",
      unitId: input.unitId,
    },
    select: { id: true },
  });
}

export async function insertService(
  tx: DbClient,
  input: {
    customerId: string;
    unitId: string;
    performedAt?: Date | null;
    description?: string | null;
  },
) {
  return tx.service.create({
    data: {
      customerId: input.customerId,
      unitId: input.unitId,
      // The route's contract is Omie-origin rows carrying their OS id; `omieId`
      // is unique in the schema, so each row mints its own.
      origin: "omie",
      omieId: `os-${randomUUID().slice(0, 12)}`,
      performedAt: input.performedAt ?? null,
      description: input.description ?? null,
    },
    select: { id: true, omieId: true },
  });
}

/**
 * One loja, its connection, the test attendant, and a customer in that loja.
 *
 * The attendant's id is generated, not the old shared `TEST_USER_ID`: rolled-back
 * transactions inserting one id at once wait on each other.
 */
export async function seedScope(tx: DbClient) {
  const unit = await seedUnit(tx);
  const connection = await seedConnection(tx, { unitId: unit.id });
  const user = await seedUser(tx, { units: [unit.id] });
  const customer = await insertCustomer(tx, { unitId: unit.id });
  return {
    unitId: unit.id,
    userId: user.id,
    connectionId: connection.id,
    instanceName: connection.instanceName,
    customerId: customer.id,
  };
}

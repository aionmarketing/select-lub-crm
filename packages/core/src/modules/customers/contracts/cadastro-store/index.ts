/**
 * The cadastro store: the one Postgres implementation of the `CadastroStore`
 * port (`port.ts`), used by the customers slices, by the ERP pull (through
 * `contracts/import-from-erp`) and by `contracts/apply-prefill-suggestion`.
 *
 * Moved from `apps/api/src/cadastro/prisma.ts` (4B), and merged with the 3A pull
 * store, so there is one implementation of the port instead of two. Where the two
 * disagreed, 4B's rulings picked per method: the API store's bodies for
 * `getSync`, `saveCustomer`, `saveOpenPending` and the row mappers, and the pull
 * store's for the two pull-only methods (`pull.ts`). `saveCustomer` replacing
 * phones and emails is a behaviour FIX of the pull, which used to drop an Omie
 * change to the shared primary phone or email.
 *
 * Every method runs in its own `db.tx("customers", …)`, so every write lands under
 * `module_customers`, which owns every table written here. `unit` is only read.
 * One transaction per call, never one around a caller's sequence: the engine
 * calls the ERP between store calls (W2-C12).
 *
 * Public in name only — it lives in `contracts/` because a contract may not import
 * `internal/` — and any caller still writes under the customers role (4B, Q3).
 */
import type { DbClient } from "@select-lub/core/db";
import type { CadastroStore } from "./port.js";
import type { Db } from "../../../../kernel/db.js";
import { customerMethods } from "./customers.js";
import { fieldSyncMethods } from "./field-sync.js";
import { pullMethods } from "./pull.js";
import { reconcileMethods } from "./reconcile.js";
import { vehicleMethods } from "./vehicles.js";

/**
 * The store's methods, over one client.
 *
 * @param prisma - The `customers` transaction one call runs in.
 * @param env - Environment map; `OMIE_MOCK_DATASET=tidsci` picks the unit a new pulled customer gets.
 * @returns Every `CadastroStore` method.
 */
function methodsOn(prisma: DbClient, env: NodeJS.ProcessEnv): CadastroStore {
  return {
    ...customerMethods(prisma),
    ...vehicleMethods(prisma),
    ...fieldSyncMethods(prisma),
    ...reconcileMethods(prisma),
    ...pullMethods(prisma, env),
  };
}

/**
 * The cadastro store, one `customers` transaction per call.
 *
 * @param db - The database handle.
 * @param env - Environment map; defaults to `process.env`.
 * @returns A {@link CadastroStore} whose every call runs under `module_customers`.
 */
export function createCadastroStore(
  db: Db,
  env: NodeJS.ProcessEnv = process.env,
): CadastroStore {
  // Built only to enumerate the methods: none of them is called on this copy.
  const template = methodsOn(undefined as unknown as DbClient, env);
  const store: Record<string, unknown> = {};
  for (const key of Object.keys(template)) {
    store[key] = (...args: unknown[]) =>
      db.tx("customers", (tx) => {
        const bound = methodsOn(tx, env) as unknown as Record<
          string,
          (...params: unknown[]) => Promise<unknown>
        >;
        return bound[key]!(...args);
      });
  }
  return store as CadastroStore;
}

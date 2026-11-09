/**
 * The cadastro store the ERP pull (`erp/run-pull`) writes customers and vehicles
 * through: the only way another module writes the customers tables on the
 * pull's behalf.
 *
 * Until 4B this was a STUB holding its own copy of the store, moved from
 * `apps/worker/src/omie/prisma.ts` in 3A. 4B merged it into the one cadastro
 * store (`cadastro-store/`), keeping this name so `erp/run-pull`'s call site is
 * unchanged. It stays a contract, not a slice: its only caller is another module
 * (3C's ruling Q5 for `services/contracts/import-from-erp.ts`).
 *
 * Two methods only the pull calls, `listUnlinkedMatchCandidates` and
 * `upsertByOmieId`, keep the pull store's bodies verbatim. `saveCustomer` now
 * replaces phones and emails, as the API's store always did — a behaviour FIX:
 * the pull used to drop an Omie change to the shared primary phone or email.
 */
import type { CadastroStore } from "./cadastro-store/port.js";
import type { Db } from "../../../kernel/db.js";
import { createCadastroStore } from "./cadastro-store/index.js";

/**
 * The cadastro store the ERP pull writes through, one `customers` transaction per call.
 *
 * @param db - The database handle.
 * @param env - Environment map; `OMIE_MOCK_DATASET=tidsci` assigns `Select Lub` on first upsert.
 * @returns A {@link CadastroStore} whose writes run under `module_customers`.
 */
export function createCadastroImportStore(
  db: Db,
  env: NodeJS.ProcessEnv = process.env,
): CadastroStore {
  return createCadastroStore(db, env);
}

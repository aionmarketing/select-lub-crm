/**
 * `pnpm db:reconcile-returns` — runs the vehicle-returns reconcile once over
 * every vehicle with a service, and nothing else (owner rulings, 2026-09-25).
 *
 * It is what the one-open-return-per-vehicle migration
 * (`20260925140000_one_open_return_per_vehicle`) tells the operator to run when
 * it refuses: a vehicle with OPEN returns from different services needs the
 * stale one superseded and its un-sent reminders stopped under scheduling's
 * rules, which is exactly what every import's reconcile does. Deliberately NOT
 * an Omie import: without Omie credentials the worker's pull reads the fake Omie
 * source, and would write mock customers into production.
 *
 * In order:
 * 1. Refuses unless `DATABASE_URL` is set in the shell (the repo `.env` is not
 *    read), and prints `reconcile-returns: writing to <host>`.
 * 2. Applies `db/grants.generated.sql`. When the migration has refused,
 *    `db:migrate` stopped before its own grants step, and the reconcile's writes
 *    run under module roles.
 * 3. Reconciles, and prints what changed.
 *
 * Calls no network: no Omie, no Evolution.
 */
// A BARE ENTRY (review of #167). Its only static import is the guard, whose own
// chain imports nothing. Everything that touches Prisma is loaded with
// `await import()` AFTER the guard: `@select-lub/core/db`'s client loads the
// repo `.env` when DATABASE_URL is unset, and ESM evaluates static imports
// before this module's body, so a static import would let the `.env` (which in
// the main checkout names production) supply the URL the guard then allows.
// `test/reconcile-returns-entry.test.ts` spawns this script to keep it so.
import { resolveReconcileReturnsTarget } from "../src/kernel/prisma/reconcile-returns-target.js";

const target = resolveReconcileReturnsTarget(process.env);
if (target.kind === "refused") {
  console.error(target.message);
  process.exit(1);
}
console.log(target.message);

const { applyModuleGrants } = await import("../src/kernel/prisma/apply-grants.js");
await applyModuleGrants(target.url);
console.log("reconcile-returns: applied db/grants.generated.sql (module roles)");

const { PrismaClient } = await import("@prisma/client");
const { createDb } = await import("../src/kernel/db.js");
const { reconcileVehicleReturns } = await import("../src/modules/services/contracts/reconcile-vehicle-returns.js");
const prisma = new PrismaClient({ datasourceUrl: target.url });
try {
  const result = await reconcileVehicleReturns(createDb(prisma));
  console.log(`reconcile-returns: done ${JSON.stringify(result)}`);
} finally {
  await prisma.$disconnect();
}

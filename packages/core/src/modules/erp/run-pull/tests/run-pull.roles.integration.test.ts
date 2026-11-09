/**
 * Test design (testing-strategy) — which role writes what, through `runPull`
 *
 * SUT: `runPull(db, mode, env, source, matchScope, log)`, the composition the
 *   worker calls (the worker as `runPull(db, mode, process.env, undefined,
 *   undefined, log)`: no scope, its own log); these cases pass an empty
 *   scope because none of their customers is a match candidate: the
 *   cadastro, service, catalog and sync-run stores it builds from the owning
 *   modules' contracts, then the post-import reconcile.
 * Requirement (3A.3): `sync_execution` and `integration_error` are written only
 *   under `module_erp`. And, because this is what the move changed, every other
 *   write the pull makes runs under the role of the module that owns its table.
 * How it is observed: a `Db` whose clients record every Prisma write method call
 *   with the role Postgres reports for it (`current_user`, mapped back to its
 *   module) — `unscoped` for the login role. Postgres already refuses a write to a
 *   table the role does not own, so the only way a write could land under the
 *   wrong module is outside every `db.tx`; the recorder is what can see that. It
 *   asks Postgres rather than trusting the handle's label because a contract can
 *   be called through a handle over the caller's transaction (`createDb(tx)`),
 *   as `services`' reconcile calls `scheduling`'s reminder cancel: that write runs
 *   as `module_scheduling` through a handle the label would have called
 *   `services`.
 * Controls: the positive one is that the pull does write both erp tables (a run,
 *   and the mock's duplicate-pair finding), so "every erp write was under erp"
 *   cannot pass on zero writes. The negative ones prove the role check is not
 *   vacuous: the same inserts under another module's role are refused. Each sits
 *   last in its own test, because a refused statement aborts the transaction.
 * No write is unscoped. Until 3C the reconcile wrote `vehicle_return` and
 *   `scheduled_message` on the raw client (W3-C3); it now writes the first under
 *   `module_services` and the second through `scheduling`'s contract, nested. The
 *   mock pull alone gives the reconcile nothing to do on a seeded database (its
 *   services are the demo's, already reconciled), so a case of its own seeds a
 *   car the reconcile must supersede, stop a reminder on, and re-open — without
 *   it the two owner entries below would hold on zero writes.
 * Every mock Omie id is this test's own (`scopedMockOmie`), for the reason the
 *   other files give.
 */
import { randomUUID } from "node:crypto";
import { prisma, type DbClient, type PrismaClient } from "@select-lub/core/db";
import { scopedMockOmie } from "./scoped-mock.js";
import { expect, it } from "vitest";
import { createDb, MODULE_NAMES, roleFor, type ModuleName } from "../../../../kernel/db.js";
import {
  describeWithDatabase,
  runInTransactionOnTx,
  seedUnit,
  seedUser,
  withTestTransaction,
} from "../../../../testing/index.js";
import { runPull } from "../index.js";

/** The default test transaction: with scoped ids no case waits on another's rows. */
function inSurfaceTransaction<T>(client: PrismaClient, fn: (tx: DbClient) => Promise<T>): Promise<T> {
  return withTestTransaction(client, fn);
}

const MOCK_ENV = { OMIE_MOCK: "1" };

/** Every Prisma delegate method that writes. */
const WRITE_METHODS = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany",
]);

type Write = { module: ModuleName | "unscoped"; model: string };

/** The module whose role Postgres reports, or `unscoped` for the login role. */
async function moduleNow(client: DbClient): Promise<Write["module"]> {
  const [row] = await client.$queryRawUnsafe<{ role: string }[]>("SELECT current_user AS role");
  return MODULE_NAMES.find((name) => roleFor(name) === row?.role) ?? "unscoped";
}

/** A client that logs each delegate write with the module whose role it ran under. */
function recording(client: DbClient, log: Write[]): DbClient {
  return new Proxy(client, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);
      if (typeof value === "function") return value.bind(target);
      if (typeof prop !== "string" || prop.startsWith("$") || value === null || typeof value !== "object") {
        return value;
      }
      return new Proxy(value, {
        get(delegate, method) {
          const fn: unknown = Reflect.get(delegate, method);
          if (typeof fn !== "function") return fn;
          if (typeof method === "string" && WRITE_METHODS.has(method)) {
            return async (...args: unknown[]) => {
              log.push({ module: await moduleNow(target), model: prop });
              return fn.apply(delegate, args);
            };
          }
          return fn.bind(delegate);
        },
      });
    },
  });
}

/**
 * A `Db` over the test transaction that records which module each write ran under.
 *
 * The transaction is wrapped ONCE and the handle is built over that one wrapper.
 * The kernel remembers the role to hand back after a nested `db.tx` by the
 * identity of the transaction client, so wrapping the client again inside each
 * `db.tx` — as this helper did before 3C — made a contract called through
 * `createDb(tx)` see a transaction with no caller, and reset to the login role
 * on its way out: the caller's next write then ran unscoped. Production passes
 * one transaction object throughout, so only a wrapper can do that.
 */
function recordingDb(tx: DbClient) {
  const writes: Write[] = [];
  const recorded = recording(tx, writes);
  const db = createDb(recorded, runInTransactionOnTx(recorded));
  return { db, writes, real: createDb(tx, runInTransactionOnTx(tx)) };
}

/** The module each written model belongs to, per ownership.json. */
const OWNER: Record<string, Write["module"]> = {
  syncExecution: "erp",
  integrationError: "erp",
  customer: "customers",
  // Since 4B the pull writes contact rows too: `upsertByOmieId` writes the snapshot's
  // phone and e-mail, and `saveCustomer` replaces them on an Omie-only change.
  customerPhone: "customers",
  customerEmail: "customers",
  vehicle: "customers",
  customerFieldSync: "customers",
  vehicleFieldSync: "customers",
  customerReconciliationPending: "customers",
  vehicleReconciliationPending: "customers",
  service: "services",
  serviceItem: "services",
  catalogItem: "quotes",
  catalogLubricant: "quotes",
  catalogFilter: "quotes",
  // The reconcile: its own table under services, reminders through scheduling's
  // contract (W3-C3, resolved in 3C).
  vehicleReturn: "services",
  scheduledMessage: "scheduling",
  // Each stopped reminder's unsent outbox row, through channel's cancelOutbound
  // (owner rulings, 2026-09-25). Recorded even when there is no row to move:
  // it is an updateMany by key.
  outboxMessage: "channel",
};

function itInTx(name: string, fn: (tx: DbClient) => Promise<void>) {
  it(name, () => inSurfaceTransaction(prisma as PrismaClient, fn));
}

describeWithDatabase("runPull roles", () => {
  itInTx("writes sync_execution and integration_error only inside erp transactions", async (tx) => {
    await seedUnit(tx);
    const { db, writes } = recordingDb(tx);

    await runPull(db, "full", MOCK_ENV, scopedMockOmie().source, { customerIds: [] });

    const erpWrites = writes.filter((w) => w.model === "syncExecution" || w.model === "integrationError");
    // Positive control: a run was started and finished, and the mock's duplicate
    // pair was recorded, so the next line cannot pass on nothing.
    expect(erpWrites.map((w) => w.model)).toEqual(
      expect.arrayContaining(["syncExecution", "integrationError"]),
    );
    expect(erpWrites.every((w) => w.module === "erp")).toBe(true);
  });

  itInTx("writes every other table under the role of the module that owns it", async (tx) => {
    await seedUnit(tx);
    const { db, writes } = recordingDb(tx);

    await runPull(db, "full", MOCK_ENV, scopedMockOmie().source, { customerIds: [] });

    const models = new Set(writes.map((w) => w.model));
    // The pull reached each owner: cadastro, service orders, catalog, sync runs.
    for (const model of ["customer", "service", "catalogItem", "syncExecution"]) {
      expect(models.has(model), `${model} was written`).toBe(true);
    }
    const wrong = writes.filter((w) => OWNER[w.model] !== w.module);
    expect(wrong).toEqual([]);
  });

  itInTx("writes the reconcile's returns under services and its reminder stop under scheduling", async (tx) => {
    const unit = await seedUnit(tx);
    const user = await seedUser(tx, { units: [unit.id] });
    const customer = await tx.customer.create({
      data: { unitId: unit.id, origin: "omie", status: "active" },
      select: { id: true },
    });
    const vehicle = await tx.vehicle.create({
      data: { customerId: customer.id, origin: "omie" },
      select: { id: true },
    });
    const service = (performedAt: string) =>
      tx.service.create({
        data: {
          customerId: customer.id,
          unitId: unit.id,
          vehicleId: vehicle.id,
          performedAt: new Date(performedAt),
          origin: "omie",
        },
        select: { id: true },
      });
    const older = await service("2025-10-01T15:00:00.000Z");
    // The newer service the reconcile has not seen: its open return is stale.
    await service("2026-05-01T15:00:00.000Z");
    const stale = await tx.vehicleReturn.create({
      data: {
        vehicleId: vehicle.id,
        sourceServiceId: older.id,
        returnDate: new Date("2026-04-01T00:00:00.000Z"),
        status: "OPEN",
      },
      select: { id: true },
    });
    const message = await tx.returnReminderMessage.create({
      data: { vehicleReturnId: stale.id, bodyTemplate: "Oi!", createdByUserId: user.id },
      select: { id: true },
    });
    const reminder = await tx.scheduledMessage.create({
      data: {
        returnReminderMessageId: message.id,
        frozenText: "Oi!",
        scheduledAt: new Date("2099-01-01T12:00:00.000Z"),
        status: "SCHEDULED",
        idempotencyKey: randomUUID(),
        createdByUserId: user.id,
      },
      select: { id: true },
    });
    const { db, writes } = recordingDb(tx);

    await runPull(db, "full", MOCK_ENV, scopedMockOmie().source, { customerIds: [] });

    // Positive control: the reconcile did supersede, stop and open, so the
    // owner check below is not holding on nothing.
    const returns = await tx.vehicleReturn.findMany({
      where: { vehicleId: vehicle.id },
      select: { status: true },
      orderBy: { createdAt: "asc" },
    });
    expect(returns.map((row) => row.status)).toEqual(["SUPERSEDED", "OPEN"]);
    const stopped = await tx.scheduledMessage.findUniqueOrThrow({
      where: { id: reminder.id },
      select: { status: true },
    });
    expect(stopped.status).toBe("CANCELLED");
    const reconcileWrites = writes.filter(
      (w) => w.model === "vehicleReturn" || w.model === "scheduledMessage",
    );
    expect(reconcileWrites).toEqual(
      expect.arrayContaining([
        { module: "services", model: "vehicleReturn" },
        { module: "scheduling", model: "scheduledMessage" },
      ]),
    );
    expect(writes.filter((w) => OWNER[w.model] !== w.module)).toEqual([]);
  });

  itInTx("is refused a sync_execution insert under any role but erp's", async (tx) => {
    const { real } = recordingDb(tx);
    // Last in its test: the refused insert aborts the transaction it runs in.
    await expect(
      real.tx("customers", (inner) =>
        inner.syncExecution.create({
          data: { source: "OMIE", entity: "cliente", mode: "full", status: "running" },
        }),
      ),
    ).rejects.toThrow(/permission denied for table sync_execution/);
  });

  itInTx("is refused an integration_error insert under any role but erp's", async (tx) => {
    const { real } = recordingDb(tx);
    await expect(
      real.tx("services", (inner) =>
        inner.integrationError.create({
          data: { integration: "OMIE", operation: "test", retryable: false },
        }),
      ),
    ).rejects.toThrow(/permission denied for table integration_error/);
  });
});

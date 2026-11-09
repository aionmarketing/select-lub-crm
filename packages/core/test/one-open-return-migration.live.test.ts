/**
 * Test design (testing-strategy)
 *
 * SUT: migration `20260925140000_one_open_return_per_vehicle` and
 *   `pnpm db:reconcile-returns`, driven by the operator's real commands (`pnpm
 *   db:migrate`, the script, `prisma migrate resolve`) against a scratch database.
 *
 * Oracle: owner rulings 2026-09-25, PR 3 (C) — the migration keeps the oldest of
 *   several OPEN returns on one service and moves the others' reminder messages
 *   to it; OPEN returns from DIFFERENT services make it refuse, naming the
 *   vehicles and the commands; following those commands on a database that has
 *   never had the module grants makes it apply.
 *
 * THE STATE IT STARTS FROM is production's as the orchestrator described it:
 * migrated up to the migration BEFORE the index, and the module grants never
 * applied. `prisma migrate deploy` alone (not `db:migrate`, which grants) is run
 * on an empty scratch, then the index and its `_prisma_migrations` row are
 * removed. That the grants really are missing is checked, not assumed: a read of
 * `vehicle_return` under `module_services` must be refused (42501). The roles
 * themselves are cluster-wide, so on a shared local server they exist already;
 * the per-database GRANTs do not.
 *
 * Cases
 *   1. Cross-service pair: `db:migrate` fails and its output names the vehicle
 *      and `db:reconcile-returns`; the script, run exactly as the message says,
 *      prints `writing to 127.0.0.1`, applies the grants and supersedes the
 *      stale return (its SCHEDULED reminder CANCELLED); `migrate resolve
 *      --rolled-back` and `db:migrate` then apply the index.
 *   1b. The same, for a pair whose services were unlinked from the car: the
 *      reconcile visits a vehicle holding an OPEN return even with no service,
 *      so the commands the message names still clear it.
 *   2. Same-service pair, on the same state again: `db:migrate` applies
 *      directly; the oldest stays OPEN, the other is SUPERSEDED, and its
 *      reminder message now hangs from the one kept, its row still SCHEDULED.
 *   3. The reconcile's own merge of a same-service pair (the code path, not the
 *      migration's SQL): with the index dropped to stage the pair, the oldest
 *      is kept and the other's reminder message moves to it, not cancelled.
 *      Here because staging it needs DDL, which on the shared database would
 *      lock `vehicle_return` for every file running beside it.
 *
 * Runs on its own scratch database, dropped afterwards, so nothing is committed
 * to the shared one.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { shouldRunLiveTests } from "@select-lub/core/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/kernel/db.js";
import { reconcileVehicleReturns } from "../src/modules/services/contracts/index.js";
import { seedUnit, seedUser, withConnectRetry } from "../src/testing/index.js";
import { createScratchDatabase, type ScratchDatabase } from "./scratch-database.js";

const hasDatabase = shouldRunLiveTests();
const repoRoot = resolve(import.meta.dirname, "../../..");
const MIGRATION = "20260925140000_one_open_return_per_vehicle";
const INDEX = "vehicle_return_one_open_per_vehicle";
/** Migrating an empty database runs every migration; each command is its own process. */
const STEP_TIMEOUT_MS = 300_000;

/** `pnpm` is a `.cmd` shim on Windows, which a child process can start only through a shell. */
const PNPM_NEEDS_SHELL = process.platform === "win32";

/** Runs `pnpm <args>` at the repo root against `url`; never throws, returns what happened. */
function pnpm(url: string, args: string[]) {
  if (PNPM_NEEDS_SHELL && args.some((argument) => /\s/.test(argument))) {
    throw new Error("a shell-run argument may not contain whitespace");
  }
  const run = spawnSync("pnpm", args, {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL: url },
    encoding: "utf8",
    shell: PNPM_NEEDS_SHELL,
  });
  return { status: run.status, output: `${run.stdout ?? ""}\n${run.stderr ?? ""}` };
}

describe.skipIf(!hasDatabase)("one-open-return migration and db:reconcile-returns — live, on a scratch database", () => {
  let scratch: ScratchDatabase | undefined;
  let prisma!: PrismaClient;

  beforeAll(async () => {
    scratch = await createScratchDatabase(process.env.DATABASE_URL ?? "", "one_open_return", repoRoot, process.env, {
      migrate: false,
    });
    // Every migration, and deliberately NOT the grants.
    const deployed = pnpm(scratch.url, ["--filter", "@select-lub/core", "exec", "prisma", "migrate", "deploy", "--schema", "prisma/schema"]);
    if (deployed.status !== 0) throw new Error(`migrate deploy failed:\n${deployed.output}`);
    prisma = withConnectRetry(new PrismaClient({ datasourceUrl: scratch.url }));
  }, STEP_TIMEOUT_MS);

  afterAll(async () => {
    try {
      await prisma?.$disconnect();
    } finally {
      await scratch?.drop();
    }
  }, STEP_TIMEOUT_MS);

  /** Back to "migrated up to the migration before the index". */
  async function beforeTheIndex() {
    await prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS "${INDEX}"`);
    await prisma.$executeRawUnsafe(`DELETE FROM "_prisma_migrations" WHERE migration_name = '${MIGRATION}'`);
  }

  /** A vehicle with the given services, OPEN returns and one reminder on the named return. */
  async function vehicleWith(input: { services: Date[]; returns: { service: number; createdAt: Date }[] }) {
    const unit = await seedUnit(prisma);
    const user = await seedUser(prisma, { units: [unit.id] });
    const customer = await prisma.customer.create({ data: { unitId: unit.id, origin: "crm", status: "active" } });
    const vehicle = await prisma.vehicle.create({ data: { customerId: customer.id, origin: "crm" } });
    const services = [];
    for (const performedAt of input.services) {
      services.push(
        await prisma.service.create({
          data: { customerId: customer.id, vehicleId: vehicle.id, unitId: unit.id, origin: "crm", performedAt },
        }),
      );
    }
    const returns = [];
    for (const row of input.returns) {
      returns.push(
        await prisma.vehicleReturn.create({
          data: {
            vehicleId: vehicle.id,
            sourceServiceId: services[row.service]!.id,
            returnDate: new Date("2099-01-01T00:00:00.000Z"),
            status: "OPEN",
            createdAt: row.createdAt,
          },
        }),
      );
    }
    return { vehicleId: vehicle.id, userId: user.id, returnIds: returns.map((row) => row.id) };
  }

  /** A reminder message with one SCHEDULED row on `returnId`. */
  async function reminderOn(returnId: string, userId: string) {
    const message = await prisma.returnReminderMessage.create({
      data: { vehicleReturnId: returnId, bodyTemplate: "Lembrete", createdByUserId: userId },
    });
    const row = await prisma.scheduledMessage.create({
      data: {
        returnReminderMessageId: message.id,
        frozenText: "Lembrete",
        scheduledAt: new Date("2099-01-01T12:00:00.000Z"),
        status: "SCHEDULED",
        idempotencyKey: randomUUID(),
        createdByUserId: userId,
      },
    });
    return { messageId: message.id, rowId: row.id };
  }

  async function indexExists() {
    const rows = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pg_indexes WHERE indexname = ${INDEX}`;
    return Number(rows[0]?.n ?? 0) === 1;
  }

  it(
    "refuses a cross-service pair, and applies after the commands its message names, on a database never granted",
    async () => {
      const url = scratch!.url;
      await beforeTheIndex();
      // Precondition: the module grants really are missing on this database.
      await expect(
        prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe("SET LOCAL ROLE module_services");
          await tx.$queryRawUnsafe('SELECT 1 FROM "vehicle_return" LIMIT 1');
        }),
      ).rejects.toThrow(/permission denied/);

      const pair = await vehicleWith({
        services: [new Date("2025-09-01T12:00:00.000Z"), new Date("2026-03-10T12:00:00.000Z")],
        returns: [
          { service: 0, createdAt: new Date("2025-09-02T00:00:00.000Z") },
          { service: 1, createdAt: new Date("2026-03-11T00:00:00.000Z") },
        ],
      });
      const [staleId, currentId] = pair.returnIds as [string, string];
      const reminder = await reminderOn(staleId, pair.userId);

      const refused = pnpm(url, ["db:migrate"]);
      expect(refused.status).not.toBe(0);
      expect(refused.output).toContain("one_open_return_per_vehicle");
      expect(refused.output).toContain(pair.vehicleId);
      expect(refused.output).toContain("pnpm db:reconcile-returns");
      expect(await indexExists()).toBe(false);
      // Nothing changed: the refusal is the whole statement.
      expect((await prisma.vehicleReturn.findUniqueOrThrow({ where: { id: staleId } })).status).toBe("OPEN");

      const reconciled = pnpm(url, ["db:reconcile-returns"]);
      expect(reconciled.status).toBe(0);
      expect(reconciled.output).toContain("reconcile-returns: writing to 127.0.0.1");

      const resolved = pnpm(url, [
        "--filter",
        "@select-lub/core",
        "exec",
        "prisma",
        "migrate",
        "resolve",
        "--rolled-back",
        MIGRATION,
        "--schema",
        "prisma/schema",
      ]);
      expect(resolved.status).toBe(0);
      const applied = pnpm(url, ["db:migrate"]);
      expect(applied.status).toBe(0);

      expect(await indexExists()).toBe(true);
      expect((await prisma.vehicleReturn.findUniqueOrThrow({ where: { id: staleId } })).status).toBe("SUPERSEDED");
      expect((await prisma.vehicleReturn.findUniqueOrThrow({ where: { id: currentId } })).status).toBe("OPEN");
      expect((await prisma.scheduledMessage.findUniqueOrThrow({ where: { id: reminder.rowId } })).status).toBe("CANCELLED");
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "clears a cross-service pair whose services were unlinked from the car, with the same commands",
    async () => {
      // Review of #167: the reconcile listed vehicles only from services, so a
      // vehicle whose returns' services were unlinked (Service.vehicle SET NULL)
      // was never visited and the migration kept refusing. It now visits every
      // vehicle holding an OPEN return.
      const url = scratch!.url;
      await beforeTheIndex();
      const pair = await vehicleWith({
        services: [new Date("2025-09-01T12:00:00.000Z"), new Date("2026-03-10T12:00:00.000Z")],
        returns: [
          { service: 0, createdAt: new Date("2025-09-02T00:00:00.000Z") },
          { service: 1, createdAt: new Date("2026-03-11T00:00:00.000Z") },
        ],
      });
      await prisma.service.updateMany({ where: { vehicleId: pair.vehicleId }, data: { vehicleId: null } });

      const refused = pnpm(url, ["db:migrate"]);
      expect(refused.status).not.toBe(0);
      expect(refused.output).toContain(pair.vehicleId);

      expect(pnpm(url, ["db:reconcile-returns"]).status).toBe(0);
      expect(
        pnpm(url, ["--filter", "@select-lub/core", "exec", "prisma", "migrate", "resolve", "--rolled-back", MIGRATION, "--schema", "prisma/schema"]).status,
      ).toBe(0);
      const applied = pnpm(url, ["db:migrate"]);
      expect(applied.status).toBe(0);

      expect(await indexExists()).toBe(true);
      const statuses = await prisma.vehicleReturn.findMany({ where: { vehicleId: pair.vehicleId }, select: { status: true } });
      expect(statuses.map((row) => row.status)).toEqual(["SUPERSEDED", "SUPERSEDED"]);
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "keeps the oldest of a same-service pair and moves the other's reminders to it",
    async () => {
      const url = scratch!.url;
      await beforeTheIndex();
      const pair = await vehicleWith({
        services: [new Date("2026-03-10T12:00:00.000Z")],
        returns: [
          { service: 0, createdAt: new Date("2026-03-11T00:00:00.000Z") },
          { service: 0, createdAt: new Date("2026-03-11T00:00:05.000Z") },
        ],
      });
      const [keptId, duplicateId] = pair.returnIds as [string, string];
      const reminder = await reminderOn(duplicateId, pair.userId);

      const applied = pnpm(url, ["db:migrate"]);
      expect(applied.status).toBe(0);

      expect(await indexExists()).toBe(true);
      expect((await prisma.vehicleReturn.findUniqueOrThrow({ where: { id: keptId } })).status).toBe("OPEN");
      expect((await prisma.vehicleReturn.findUniqueOrThrow({ where: { id: duplicateId } })).status).toBe("SUPERSEDED");
      const message = await prisma.returnReminderMessage.findUniqueOrThrow({ where: { id: reminder.messageId } });
      expect(message.vehicleReturnId).toBe(keptId);
      expect((await prisma.scheduledMessage.findUniqueOrThrow({ where: { id: reminder.rowId } })).status).toBe("SCHEDULED");
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "merges a same-service pair in the reconcile itself, moving the duplicate's reminders to the one kept",
    async () => {
      // The index exists after the cases above; drop it to stage the pair.
      await prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS "${INDEX}"`);
      const pair = await vehicleWith({
        services: [new Date("2026-03-10T12:00:00.000Z")],
        returns: [
          { service: 0, createdAt: new Date("2026-03-11T00:00:00.000Z") },
          { service: 0, createdAt: new Date("2026-03-11T00:00:05.000Z") },
        ],
      });
      const [keptId, duplicateId] = pair.returnIds as [string, string];
      const reminder = await reminderOn(duplicateId, pair.userId);

      const result = await reconcileVehicleReturns(createDb(prisma), { vehicleIds: [pair.vehicleId] });

      expect((await prisma.vehicleReturn.findUniqueOrThrow({ where: { id: keptId } })).status).toBe("OPEN");
      expect((await prisma.vehicleReturn.findUniqueOrThrow({ where: { id: duplicateId } })).status).toBe("SUPERSEDED");
      const message = await prisma.returnReminderMessage.findUniqueOrThrow({ where: { id: reminder.messageId } });
      expect(message.vehicleReturnId).toBe(keptId);
      expect((await prisma.scheduledMessage.findUniqueOrThrow({ where: { id: reminder.rowId } })).status).toBe("SCHEDULED");
      expect(result).toMatchObject({ opened: 0, superseded: 1, remindersCancelled: 0, remindersMerged: 1 });
    },
    STEP_TIMEOUT_MS,
  );
});

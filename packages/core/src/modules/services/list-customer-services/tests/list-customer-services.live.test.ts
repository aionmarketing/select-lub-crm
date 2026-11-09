/**
 * Test design (testing-strategy)
 *
 * Setup: live Prisma when DATABASE_URL is set. Unique ids (runId); teardown
 * deletes only its own rows (no TRUNCATE) — services first (FK), then the
 * customer, then the unit.
 *
 * Runs under module role: `module_services` — the slice opens its own
 * transactions through `db.tx("services", …)` on the committed client. The
 * fixture rows are committed by the login role, outside any module role.
 *
 * Moved from `apps/api/src/customer-services.live.test.ts`
 * (adopt-modular-vertical-slices 3C). Its one case is unchanged. What changed is
 * the app: the slice alone on the harness app with the caller stated, instead of
 * `apps/api`'s app behind the auth hook, so the committed `user` row and
 * memberships the hook needed are no longer created. The hook's own cases are in
 * `apps/api/test/services.integration.test.ts`.
 *
 * Oracle: openspec/changes/complete-omie-integration/specs/customer-services/spec.md
 * "Customer-scoped service HTTP is read-only" — "List two services newest first".
 *
 * Axes
 *   A1 DATABASE_URL set vs unset (describe.skipIf)
 *   A2 performedAt ordering — June row vs January row
 *
 * Outputs: O1 200 with June before January; O2 skip
 *
 * Sampled-cell
 *   two services, different dates | A2 | O1 | January before June
 *
 * Decision map: `sortServices` is covered unit-by-unit in
 * internal/sort-services.test.ts; this file only exercises the real Postgres
 * round trip over committed rows (Decimal/DateTime column mapping), not every
 * ordering branch again.
 *
 * Out of scope: HTTP routing decisions (list-customer-services.integration.test.ts);
 * rail UI.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { shouldRunLiveTests } from "@select-lub/core/db";
import { buildSliceApp, withConnectRetry } from "@select-lub/core/testing";
import { createDb } from "../../../../kernel/db.js";
import { registerSlice } from "../../../../kernel/http.js";
import { serviceListSchema } from "../../contracts/http.js";
import { route } from "../index.js";

// tests -> list-customer-services -> services -> modules -> src -> core -> packages -> repo
const repoRoot = resolve(import.meta.dirname, "../../../../../../..");
const envPath = resolve(repoRoot, ".env");
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

const live = shouldRunLiveTests();

describe.skipIf(!live)("live customer services", () => {
  const runId = randomUUID();
  let prisma!: NonNullable<(typeof import("@select-lub/core/db"))["prisma"]>;
  let app!: Awaited<ReturnType<typeof buildSliceApp>>;
  let unitId = "";
  let customerId = "";

  beforeAll(async () => {
    const db = await import("@select-lub/core/db");
    const client = db.prisma;
    if (!client) {
      throw new Error("expected PrismaClient when DATABASE_URL is set");
    }
    prisma = withConnectRetry(client);
    const unit = await prisma.unit.create({ data: { name: `svc-${runId}` } });
    unitId = unit.id;
    const customer = await prisma.customer.create({
      data: { name: `Cliente ${runId}`, unitId, origin: "crm", status: "active" },
    });
    customerId = customer.id;
    app = await buildSliceApp({
      db: createDb(prisma),
      plugin: (instance) =>
        registerSlice(instance, "services", "list-customer-services", route),
      caller: { userId: randomUUID(), unitId },
    });
  }, 120_000);

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    if (!prisma) {
      return;
    }
    if (customerId) {
      await prisma.service.deleteMany({ where: { customerId } });
      await prisma.customer.deleteMany({ where: { id: customerId } });
    }
    if (unitId) {
      await prisma.unit.deleteMany({ where: { id: unitId } });
    }
  });

  it("lists two services with the newer performedAt first", async () => {
    await prisma.service.create({
      data: {
        customerId,
        unitId,
        performedAt: new Date("2026-01-01T00:00:00.000Z"),
        description: "Troca de óleo",
        origin: "omie",
        omieId: `os-${runId}-jan`,
      },
    });
    await prisma.service.create({
      data: {
        customerId,
        unitId,
        performedAt: new Date("2026-06-01T00:00:00.000Z"),
        description: "Revisão",
        origin: "omie",
        omieId: `os-${runId}-jun`,
      },
    });

    const listed = await app.inject({
      method: "GET",
      url: `/customers/${customerId}/services`,
    });
    expect(listed.statusCode).toBe(200);
    expect(serviceListSchema.parse(listed.json()).map((row) => row.description)).toEqual([
      "Revisão",
      "Troca de óleo",
    ]);
  });
});

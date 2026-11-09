/**
 * Test design — the api composition root is ready for module plugins
 *
 * SUT: `buildApp` from `src/app.ts`, which every wave 2 stream registers its
 *   module's `httpPlugin` on, with the real auth hook in front. Inside one
 *   rolling-back transaction on the worktree database (`withTestTransaction`),
 *   in-process through `inject`. The probe slice is registered by the test
 *   under `/reports/`, a prefix the hook authenticates.
 *
 * What it pins, the three things every module slice depends on:
 *   1. `request.server.db` exists and runs under the module's role on the
 *      client `buildApp` was given. Asserted by reading `current_user` inside
 *      `db.tx("reports", …)`: only a handle over this transaction, with the
 *      generated grants applied, can answer with the module's role.
 *   2. The kernel's `unitIdOf` reads the unit `apps/api`'s hook resolved from
 *      `X-Unit-Id`. The field declarations moved to the kernel; the hook that
 *      sets them did not. A slice in `packages/core` sees the hook's answer only
 *      if both agree on the field.
 *   3. A kernel `HttpPlugin` type-checks against this app. Checked by
 *      `pnpm typecheck`, not at run time: if the two Fastify instance types
 *      diverge, the `plugin(app)` line stops compiling.
 *
 * Positive control: the same probe without a bearer token is a 401. It shows
 *   the hook runs in front of a module slice, so a 200 above is a resolved
 *   caller and not a path the hook let through as a static asset.
 */
import { expect, it } from "vitest";
import { z } from "zod";
import type { FastifyRequest } from "fastify";
import { prisma, type DbClient } from "@select-lub/core/db";
import { kernel } from "@select-lub/core";
import {
  describeWithDatabase,
  runInTransactionOnTx,
  seedUnit,
  seedUser,
  withTestTransaction,
} from "@select-lub/core/testing";

import { buildApp } from "../src/app.js";
import { createFakeGetUser, TEST_ACCESS_TOKEN, TEST_USER_ID } from "@select-lub/core/testing";

const probe: kernel.HttpPlugin = (app) => {
  kernel.registerSlice(app, "reports", "seam-probe", {
    method: "GET",
    path: "/reports/seam-probe",
    schema: { response: { 200: z.object({ role: z.string(), unitId: z.string().nullable() }) } },
    handler: async (request: FastifyRequest) => ({
      role: await request.server.db.tx("reports", async (t) => {
        const rows = await t.$queryRaw<{ current_user: string }[]>`SELECT current_user`;
        return rows[0]!.current_user;
      }),
      unitId: kernel.unitIdOf(request) ?? null,
    }),
  });
};

async function appWithProbe(tx: DbClient) {
  const app = await buildApp({
    db: tx,
    runInTransaction: runInTransactionOnTx(tx),
    getUser: createFakeGetUser(),
  });
  await probe(app);
  return app;
}

describeWithDatabase("module plugin seam on the api composition root", () => {
  it("hands a module slice the database under its role and the caller's resolved unit", () =>
    withTestTransaction(prisma!, async (tx) => {
      const unit = await seedUnit(tx);
      await seedUser(tx, { id: TEST_USER_ID, units: [unit.id] });
      const app = await appWithProbe(tx);
      try {
        const response = await app.inject({
          method: "GET",
          url: "/reports/seam-probe",
          headers: { "x-unit-id": unit.id, authorization: `Bearer ${TEST_ACCESS_TOKEN}` },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ role: kernel.roleFor("reports"), unitId: unit.id });
      } finally {
        await app.close();
      }
    }));

  it("still puts the auth hook in front of a module slice", () =>
    withTestTransaction(prisma!, async (tx) => {
      const app = await appWithProbe(tx);
      try {
        const response = await app.inject({ method: "GET", url: "/reports/seam-probe" });
        expect(response.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    }));
});

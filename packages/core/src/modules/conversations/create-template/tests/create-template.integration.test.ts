/**
 * Test design (testing-strategy) — conversations / create-template
 *
 * Module role: `module_conversations`. The insert runs in one
 * `db.tx("conversations", …)`; the unique-constraint catch sits outside it.
 *
 * Moved from `apps/api/src/tags.test.ts` (4A), assertions unchanged: its
 * "rejects a template create with an unknown variable" and "rejects a duplicate
 * active template name with 409" cases.
 *
 * SUT: `POST /templates`, through `buildSliceApp` with this slice's route only,
 *   inside one rolling-back transaction.
 *
 * Oracle: openspec/changes/tags-and-templates-crud design.md axis 1.
 *
 * F1/F2 (from the original file) — the 409 is a P2002 off the partial index
 *   `template_unit_id_name_active_key`; it aborts the test transaction, so the
 *   duplicate case ends on the rejection.
 *
 * Sampled-cell
 *   unknown variable             | O4 400, no row | 201 with a known one
 *   duplicate active name        | O2 409         | 201
 */
import { expect, it } from "vitest";
import { prisma, type DbClient, type PrismaClient } from "@select-lub/core/db";
import { createDb } from "../../../../kernel/db.js";
import { registerSlice } from "../../../../kernel/http.js";
import {
  buildSliceApp,
  describeWithDatabase,
  runInTransactionOnTx,
  seedUnit,
  withTestTransaction,
} from "@select-lub/core/testing";
import { route } from "../index.js";

const db = () => prisma as PrismaClient;

async function scope(tx: DbClient) {
  const unit = await seedUnit(tx);
  const app = await buildSliceApp({
    db: createDb(tx, runInTransactionOnTx(tx)),
    plugin: (app) => registerSlice(app, "conversations", "create-template", route),
    caller: { userId: "tags-test-caller", unitId: unit.id },
  });
  return { unitId: unit.id, app };
}

describeWithDatabase("POST /templates", () => {
  it("rejects a template create with an unknown variable", () =>
    withTestTransaction(db(), async (tx) => {
      const { unitId, app } = await scope(tx);
      try {
        // Positive control: the same shape with a known variable is accepted,
        // so the 400 is about `modelo` and not about the payload.
        const accepted = await app.inject({
          method: "POST",
          url: "/templates",
          payload: { name: "Aceito", text: "Oi {{nome_cliente}}", allowedVariables: ["nome_cliente"] },
        });
        expect(accepted.statusCode).toBe(201);

        const created = await app.inject({
          method: "POST",
          url: "/templates",
          payload: { name: "Aviso", text: "Oi", allowedVariables: ["modelo"] },
        });
        // Refused by the request schema, so nothing reaches the database.
        expect(created.statusCode).toBe(400);
        expect(await tx.template.count({ where: { unitId, name: "Aviso" } })).toBe(0);
      } finally {
        await app.close();
      }
    }));
});

describeWithDatabase("POST /templates conflicts", () => {
  it("rejects a duplicate active template name with 409", () =>
    withTestTransaction(db(), async (tx) => {
      const { app } = await scope(tx);
      try {
        const first = await app.inject({
          method: "POST",
          url: "/templates",
          payload: { name: "Saudacao", text: "Oi" },
        });
        expect(first.statusCode).toBe(201);

        const duplicate = await app.inject({
          method: "POST",
          url: "/templates",
          payload: { name: "Saudacao", text: "Oi de novo" },
        });
        expect(duplicate.statusCode).toBe(409);
      } finally {
        await app.close();
      }
    }));
});

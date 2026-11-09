/**
 * Test design (testing-strategy) — conversations / update-template
 *
 * Module role: `module_conversations`. The loja check and the update each run
 * in their own `db.tx("conversations", …)`.
 *
 * New with the move (4A): the original file reached `PATCH /templates/:id` in no
 * case.
 *
 * SUT: `PATCH /templates/:id`, through `buildSliceApp` with this slice's route
 *   only, inside one rolling-back transaction.
 *
 * Oracle: openspec/changes/tags-and-templates-crud design.md axis 1 — a loja
 *   edits only its own templates.
 *
 * Sampled-cell
 *   own template, new text + inactive | 200, columns changed | 404
 *   another loja's template           | O3 404, row unchanged | 200
 */
import { expect, it } from "vitest";
import { prisma, type PrismaClient } from "@select-lub/core/db";
import { templateSchema } from "../../contracts/http.js";
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

describeWithDatabase("PATCH /templates/:id", () => {
  it("edits the loja's own template and answers 404 for another loja's", () =>
    withTestTransaction(db(), async (tx) => {
      const unit = await seedUnit(tx);
      const otherUnit = await seedUnit(tx);
      const template = (unitId: string) =>
        tx.template.create({
          data: { unitId, name: "Saudacao", text: "Oi", allowedVariables: [], status: "active" },
          select: { id: true },
        });
      const mine = await template(unit.id);
      const foreign = await template(otherUnit.id);
      const app = await buildSliceApp({
        db: createDb(tx, runInTransactionOnTx(tx)),
        plugin: (app) => registerSlice(app, "conversations", "update-template", route),
        caller: { userId: "tags-test-caller", unitId: unit.id },
      });
      try {
        const patched = await app.inject({
          method: "PATCH",
          url: `/templates/${mine.id}`,
          payload: { text: "Oi {{nome_cliente}}", status: "inactive" },
        });
        expect(patched.statusCode).toBe(200);
        expect(templateSchema.parse(patched.json())).toEqual(
          expect.objectContaining({ id: mine.id, text: "Oi {{nome_cliente}}", status: "inactive" }),
        );

        const refused = await app.inject({
          method: "PATCH",
          url: `/templates/${foreign.id}`,
          payload: { text: "Tchau" },
        });
        expect(refused.statusCode).toBe(404);
        expect(
          await tx.template.findUniqueOrThrow({ where: { id: foreign.id }, select: { text: true } }),
        ).toEqual({ text: "Oi" });
      } finally {
        await app.close();
      }
    }));
});

/**
 * Test design (testing-strategy) — conversations / list-templates
 *
 * Module role: `module_conversations`. The list runs in one
 * `db.tx("conversations", …)`.
 *
 * New with the move (4A): the original file reached `GET /templates` in no case.
 *
 * SUT: `GET /templates`, through `buildSliceApp` with this slice's route only,
 *   inside one rolling-back transaction.
 *
 * Oracle: openspec/changes/tags-and-templates-crud design.md axis 1 — a loja
 *   sees only its own templates.
 *
 * Sampled-cell
 *   two in this loja, one in another | this loja's ids, by name | the other's id
 */
import { expect, it } from "vitest";
import { prisma, type PrismaClient } from "@select-lub/core/db";
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

describeWithDatabase("GET /templates", () => {
  it("lists the loja's templates by name and never another loja's", () =>
    withTestTransaction(db(), async (tx) => {
      const unit = await seedUnit(tx);
      const otherUnit = await seedUnit(tx);
      const template = (unitId: string, name: string) =>
        tx.template.create({
          data: { unitId, name, text: "Oi", allowedVariables: [], status: "active" },
          select: { id: true },
        });
      const saudacao = await template(unit.id, "Saudacao");
      const aviso = await template(unit.id, "Aviso");
      const foreign = await template(otherUnit.id, "Bom dia");
      const app = await buildSliceApp({
        db: createDb(tx, runInTransactionOnTx(tx)),
        plugin: (app) => registerSlice(app, "conversations", "list-templates", route),
        caller: { userId: "tags-test-caller", unitId: unit.id },
      });
      try {
        const listed = await app.inject({ method: "GET", url: "/templates" });
        expect(listed.statusCode).toBe(200);
        const ids = listed.json().map((row: { id: string }) => row.id);
        expect(ids).toEqual([aviso.id, saudacao.id]);
        expect(ids).not.toContain(foreign.id);
      } finally {
        await app.close();
      }
    }));
});

/**
 * Test design (testing-strategy) — conversations / list-tag-apply-options
 *
 * Module role: `module_conversations`. The list runs in one
 * `db.tx("conversations", …)`.
 *
 * New with the move (4A). The original file reached this route only through
 * "omits a deactivated tag from apply-options and keeps an open chip", which
 * chains four routes and stays on the whole app in
 * `apps/api/test/tags.integration.test.ts`. This case is the slice's own
 * decision alone: `active` filters, and the order is `sortOrder` then name.
 *
 * SUT: `GET /tags/apply-options`, through `buildSliceApp` with this slice's
 *   route only, inside one rolling-back transaction.
 *
 * Oracle: openspec/changes/tags-and-templates-crud design.md axis 1 — a
 *   deactivated tag is hidden from the picker.
 *
 * Sampled-cell
 *   active and inactive in one loja | only the active ids, sorted | the inactive id
 *
 * Out of scope: the open chip that survives deactivation (whole-app case).
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

describeWithDatabase("GET /tags/apply-options", () => {
  it("offers only the active tags, by sortOrder then name", () =>
    withTestTransaction(db(), async (tx) => {
      const unit = await seedUnit(tx);
      const tag = (name: string, sortOrder: number, active: boolean) =>
        tx.tag.create({ data: { unitId: unit.id, name, sortOrder, active }, select: { id: true } });
      const second = await tag("Orcamento", 1, true);
      const first = await tag("Retorno", 0, true);
      const third = await tag("Agendado", 1, true);
      const inactive = await tag("Antigo", 0, false);
      const app = await buildSliceApp({
        db: createDb(tx, runInTransactionOnTx(tx)),
        plugin: (app) => registerSlice(app, "conversations", "list-tag-apply-options", route),
        caller: { userId: "tags-test-caller", unitId: unit.id },
      });
      try {
        const options = await app.inject({ method: "GET", url: "/tags/apply-options" });
        expect(options.statusCode).toBe(200);
        const ids = options.json().map((row: { id: string }) => row.id);
        expect(ids).toEqual([first.id, third.id, second.id]);
        expect(ids).not.toContain(inactive.id);
      } finally {
        await app.close();
      }
    }));
});

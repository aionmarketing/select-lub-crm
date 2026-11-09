/**
 * Test design (testing-strategy) — conversations / list-tags
 *
 * Module role: `module_conversations`. The list runs in one
 * `db.tx("conversations", …)`.
 *
 * Moved from `apps/api/src/tags.test.ts` (4A), assertions unchanged: its
 * "does not list another loja's tag" case. The tag it hides used to be created
 * over `POST /tags`; a slice test mounts only its own route, so the row is
 * written through `tx`, with the same unit and name.
 *
 * SUT: `GET /tags`, through `buildSliceApp` with this slice's route only, inside
 *   one rolling-back transaction.
 *
 * Oracle: openspec/changes/tags-and-templates-crud design.md axis 1 — a loja
 *   sees only its own tags (F4 in the original file: `tag.unitId` against a real
 *   `unit` FK).
 *
 * Sampled-cell
 *   another loja's tag           | O5 empty list 200 | the other loja's id listed
 *
 * Out of scope: the hook's 403 on a unit the caller is not in (apps/api).
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

function appFor(tx: DbClient, unitId: string) {
  return buildSliceApp({
    db: createDb(tx, runInTransactionOnTx(tx)),
    plugin: (app) => registerSlice(app, "conversations", "list-tags", route),
    caller: { userId: "tags-test-caller", unitId },
  });
}

describeWithDatabase("GET /tags", () => {
  it("does not list another loja's tag", () =>
    withTestTransaction(db(), async (tx) => {
      const unit = await seedUnit(tx);
      const otherUnit = await seedUnit(tx);
      const tag = await tx.tag.create({
        data: { unitId: unit.id, name: "Retorno", color: "primary", sortOrder: 0, active: true },
        select: { id: true },
      });
      // Positive control, new with the move: the owning loja lists the row, so
      // the empty list below is about scope and not a route that lists nothing
      // (the original's control was its `POST /tags` 201).
      const own = await appFor(tx, unit.id);
      try {
        const mine = await own.inject({ method: "GET", url: "/tags" });
        expect(mine.json().map((row: { id: string }) => row.id)).toEqual([tag.id]);
      } finally {
        await own.close();
      }

      const app = await appFor(tx, otherUnit.id);
      try {
        const listed = await app.inject({ method: "GET", url: "/tags" });
        expect(listed.statusCode).toBe(200);
        expect(listed.json().map((row: { id: string }) => row.id)).not.toContain(tag.id);
        expect(listed.json()).toEqual([]);
      } finally {
        await app.close();
      }
    }));
});

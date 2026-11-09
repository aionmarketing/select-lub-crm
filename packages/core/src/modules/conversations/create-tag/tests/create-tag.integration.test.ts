/**
 * Test design (testing-strategy) — conversations / create-tag
 *
 * Module role: `module_conversations`. The insert runs in one
 * `db.tx("conversations", …)`; the unique-constraint catch sits outside it.
 *
 * Moved from `apps/api/src/tags.test.ts` (4A), assertions unchanged: its
 * "rejects a duplicate active tag name with 409" case. "creates a tag … and
 * lists it" and "frees a tag name once the tag is deactivated" chain other
 * routes and stay on the whole app in `apps/api/test/tags.integration.test.ts`.
 *
 * SUT: `POST /tags`, through `buildSliceApp` with this slice's route only,
 *   inside one rolling-back transaction.
 *
 * Oracle: openspec/changes/tags-and-templates-crud design.md axis 1.
 *
 * F1/F2 (from the original file) — the 409 comes from catching P2002 off the
 *   PARTIAL unique index `tag_unit_id_name_active_key`, and the failing statement
 *   aborts the enclosing test transaction, so the positive control comes FIRST
 *   and the rejection is the last statement.
 *
 * Sampled-cell
 *   duplicate active name        | O2 409 | 201
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

describeWithDatabase("POST /tags conflicts", () => {
  it("rejects a duplicate active tag name with 409", () =>
    withTestTransaction(db(), async (tx) => {
      const unit = await seedUnit(tx);
      const app = await buildSliceApp({
        db: createDb(tx, runInTransactionOnTx(tx)),
        plugin: (app) => registerSlice(app, "conversations", "create-tag", route),
        caller: { userId: "tags-test-caller", unitId: unit.id },
      });
      try {
        // Positive control, before the abort: the first create is accepted.
        const created = await app.inject({ method: "POST", url: "/tags", payload: { name: "Retorno" } });
        expect(created.statusCode).toBe(201);

        const duplicate = await app.inject({
          method: "POST",
          url: "/tags",
          payload: { name: "Retorno", color: "primary" },
        });
        expect(duplicate.statusCode).toBe(409);
      } finally {
        await app.close();
      }
    }));
});

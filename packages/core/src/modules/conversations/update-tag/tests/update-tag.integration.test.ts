/**
 * Test design (testing-strategy) — conversations / update-tag
 *
 * Module role: `module_conversations`. The loja check and the update each run
 * in their own `db.tx("conversations", …)`; the unique-constraint catch sits
 * outside them.
 *
 * Moved from `apps/api/src/tags.test.ts` (4A), assertions unchanged: its
 * "returns 404 when patching a tag id that is not in the loja", "patches tag
 * name, color, and sortOrder" and "rejects renaming a tag to another active
 * name with 409" cases. Their tags used to be created over `POST /tags`; a slice
 * test mounts only its own route, so the rows are written through `tx`.
 *
 * SUT: `PATCH /tags/:id`, through `buildSliceApp` with this slice's route only,
 *   inside one rolling-back transaction.
 *
 * Oracle: openspec/changes/tags-and-templates-crud design.md axis 1.
 *
 * F2 (from the original file) — the rename 409 aborts the test transaction, so
 *   that case puts its positive control first and ends on the rejection.
 *
 * Decision map (update-tag)
 *   D2  missing/other loja       T unknown-id it; F its positive control
 *   D10 fields defined           T patch-fields it
 *   D11 P2002                    T rename-to-taken it; F its free-name control
 */
import { expect, it } from "vitest";
import { prisma, type DbClient, type PrismaClient } from "@select-lub/core/db";
import { tagSchema } from "../../contracts/http.js";
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
    plugin: (app) => registerSlice(app, "conversations", "update-tag", route),
    caller: { userId: "tags-test-caller", unitId: unit.id },
  });
  const tag = async (name: string, color: string | null = null) =>
    (await tx.tag.create({ data: { unitId: unit.id, name, color, sortOrder: 0, active: true }, select: { id: true } }))
      .id;
  return { app, tag };
}

describeWithDatabase("PATCH /tags/:id", () => {
  it("returns 404 when patching a tag id that is not in the loja", () =>
    withTestTransaction(db(), async (tx) => {
      const { app, tag } = await scope(tx);
      try {
        // Positive control: the same PATCH succeeds on a tag this loja owns.
        const mine = await tag("Retorno");
        const ok = await app.inject({ method: "PATCH", url: `/tags/${mine}`, payload: { active: false } });
        expect(ok.statusCode).toBe(200);

        const patched = await app.inject({
          method: "PATCH",
          url: "/tags/missing-tag",
          payload: { active: false },
        });
        expect(patched.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    }));

  it("patches tag name, color, and sortOrder", () =>
    withTestTransaction(db(), async (tx) => {
      const { app, tag } = await scope(tx);
      try {
        const tagId = await tag("Retorno", "primary");

        const patched = await app.inject({
          method: "PATCH",
          url: `/tags/${tagId}`,
          payload: { name: "Retorno VIP", color: "secondary", sortOrder: 3 },
        });

        expect(patched.statusCode).toBe(200);
        expect(tagSchema.parse(patched.json())).toEqual(
          expect.objectContaining({ name: "Retorno VIP", color: "secondary", sortOrder: 3 }),
        );
        // The columns, read back through tx.
        expect(
          await tx.tag.findUniqueOrThrow({
            where: { id: tagId },
            select: { name: true, color: true, sortOrder: true },
          }),
        ).toEqual({ name: "Retorno VIP", color: "secondary", sortOrder: 3 });
      } finally {
        await app.close();
      }
    }));
});

describeWithDatabase("PATCH /tags/:id conflicts", () => {
  it("rejects renaming a tag to another active name with 409", () =>
    withTestTransaction(db(), async (tx) => {
      const { app, tag } = await scope(tx);
      try {
        await tag("Retorno");
        const orcamento = await tag("Orcamento");
        // Positive control: a rename to a free name is accepted, so the 409
        // below is about the clash and not about PATCH.
        const free = await app.inject({
          method: "PATCH",
          url: `/tags/${orcamento}`,
          payload: { name: "Orcamento VIP" },
        });
        expect(free.statusCode).toBe(200);

        const clash = await app.inject({
          method: "PATCH",
          url: `/tags/${orcamento}`,
          payload: { name: "Retorno" },
        });
        expect(clash.statusCode).toBe(409);
      } finally {
        await app.close();
      }
    }));
});

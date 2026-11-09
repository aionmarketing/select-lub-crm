/**
 * Test design (testing-strategy) — prefill / set-extract-enabled,
 * `PATCH /conversations/:id/prefill/extract-enabled`
 *
 * Moved from `apps/api/src/cadastro.prefill.test.ts`, its one single-route
 * switch case, assertion unchanged. Its two other switch cases ("turns the
 * extraction switch on and stamps the watermark", "turns the extraction switch
 * back off") read the switch back through `GET /conversations/:id/prefill`, a
 * second slice, so they moved to `apps/api/test/prefill.integration.test.ts`.
 *
 * FAKE-ONLY ASSERTION SURFACED (carried over)
 *   3. A conversation's unit is its WhatsApp connection's, so the 404 comes from
 *      the real join, through a second unit with its own connection — not from
 *      comparing two strings the test set.
 *
 * Oracle: prefill-switch — the switch is scoped to the caller's unit.
 *
 * Sampled-cell
 *   PATCH other unit | 404 | 200
 *
 * Decision map: D14 PATCH other unit — T 404; F same-unit PATCH (the
 *   integration file).
 */
import { prisma, type PrismaClient } from "@select-lub/core/db";
import { expect, it } from "vitest";
import { createDb } from "../../../../kernel/db.js";
import { registerSlice } from "../../../../kernel/http.js";
import {
  buildSliceApp,
  describeWithDatabase,
  runInTransactionOnTx,
  seedConnection,
  seedConversation,
  seedUnit,
  seedUser,
  withTestTransaction,
} from "@select-lub/core/testing";
import { route } from "../index.js";

const db = () => prisma as PrismaClient;

describeWithDatabase("PATCH /conversations/:id/prefill/extract-enabled", () => {
  it("returns 404 when patching extract-enabled on another unit's conversation", () =>
    withTestTransaction(db(), async (tx) => {
      const caller = await seedUnit(tx);
      const otherUnit = await seedUnit(tx);
      const connection = await seedConnection(tx, { unitId: otherUnit.id });
      const other = await seedConversation(tx, { connectionId: connection.id, chatKey: "11988887777" });
      const user = await seedUser(tx, { units: [caller.id] });
      const app = await buildSliceApp({
        db: createDb(tx, runInTransactionOnTx(tx)),
        plugin: (app) => registerSlice(app, "prefill", "set-extract-enabled", route),
        caller: { unitId: caller.id, userId: user.id },
      });

      try {
        const response = await app.inject({
          method: "PATCH",
          url: `/conversations/${other.id}/prefill/extract-enabled`,
          payload: { extractEnabled: true },
        });

        expect(response.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    }));
});

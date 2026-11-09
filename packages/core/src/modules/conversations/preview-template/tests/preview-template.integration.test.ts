/**
 * Test design (testing-strategy) — conversations / preview-template
 *
 * Module role: `module_conversations`. The link read and the template read each
 * run in their own `db.tx("conversations", …)`; the `templateValues` port is
 * awaited between them, outside both.
 *
 * Moved from `apps/api/src/tags.test.ts` (4A), assertions unchanged: its
 * "returns 404 when previewing a missing template" case. Its template used to be
 * created over `POST /templates`; a slice test mounts only its own route, so the
 * row is written through `tx`. The three cases that need a linked customer and
 * titular vehicle assert what the api's `templateValues` port reads from the
 * cadastro, so they stay on the whole app in
 * `apps/api/test/tags.integration.test.ts`. Here the port is a stub, and the
 * second case — new with the move — checks the slice interpolates what the port
 * answers and reads it with the conversation's link.
 *
 * SUT: `POST /conversations/:id/templates/:templateId/preview`, through
 *   `buildSliceApp` with this slice's route only, inside one rolling-back
 *   transaction.
 *
 * Oracle: openspec/changes/tags-and-templates-crud design.md axis 4.
 *
 * Decision map (preview-template)
 *   D8  template missing         T missing-template 404; F its positive control
 *   D9  values substituted       T port-values it
 */
import { expect, it } from "vitest";
import { prisma, type DbClient, type PrismaClient } from "@select-lub/core/db";
import { createDb } from "../../../../kernel/db.js";
import { registerSlice } from "../../../../kernel/http.js";
import {
  buildSliceApp,
  describeWithDatabase,
  runInTransactionOnTx,
  seedConnection,
  seedConversation,
  seedUnit,
  withTestTransaction,
} from "@select-lub/core/testing";
import type { CadastroLink } from "../../contracts/get-cadastro-link.js";
import { createRoute } from "../index.js";

const db = () => prisma as PrismaClient;

async function scope(tx: DbClient, values: { nome_cliente: string | null; placa: string | null }) {
  const unit = await seedUnit(tx);
  const connection = await seedConnection(tx, { unitId: unit.id });
  const conversation = await seedConversation(tx, { connectionId: connection.id, chatKey: "5511999990000" });
  const calls: Array<{ unitId: string; link: CadastroLink }> = [];
  const app = await buildSliceApp({
    db: createDb(tx, runInTransactionOnTx(tx)),
    plugin: (app) =>
      registerSlice(
        app,
        "conversations",
        "preview-template",
        createRoute({
          templateValues: async (unitId, link) => {
            calls.push({ unitId, link });
            return values;
          },
        }),
      ),
    caller: { userId: "tags-test-caller", unitId: unit.id },
  });
  const template = async (text: string) =>
    (
      await tx.template.create({
        data: { unitId: unit.id, name: "Saudacao", text, allowedVariables: [], status: "active" },
        select: { id: true },
      })
    ).id;
  return { unitId: unit.id, conversationId: conversation.id, app, template, calls };
}

describeWithDatabase("POST /conversations/:id/templates/:templateId/preview", () => {
  it("returns 404 when previewing a missing template", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversationId, app, template } = await scope(tx, { nome_cliente: null, placa: null });
      try {
        // Positive control: a real template on this conversation previews 200.
        const templateId = await template("Oi");
        const ok = await app.inject({
          method: "POST",
          url: `/conversations/${conversationId}/templates/${templateId}/preview`,
        });
        expect(ok.statusCode).toBe(200);

        const preview = await app.inject({
          method: "POST",
          url: `/conversations/${conversationId}/templates/missing-template/preview`,
        });
        expect(preview.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    }));

  it("interpolates the values the port answers for this thread's link", () =>
    withTestTransaction(db(), async (tx) => {
      const { unitId, conversationId, app, template, calls } = await scope(tx, {
        nome_cliente: "Ana",
        placa: "ABC1D23",
      });
      try {
        const templateId = await template("Ola {{nome_cliente}}, placa {{placa}}");

        const preview = await app.inject({
          method: "POST",
          url: `/conversations/${conversationId}/templates/${templateId}/preview`,
        });

        expect(preview.statusCode).toBe(200);
        expect(preview.json()).toEqual({ text: "Ola Ana, placa ABC1D23" });
        expect(calls).toEqual([
          { unitId, link: { id: conversationId, phone: "5511999990000", customerId: null } },
        ]);
      } finally {
        await app.close();
      }
    }));
});

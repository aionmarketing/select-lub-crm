/**
 * Test design (testing-strategy)
 *
 * Moved from `apps/api/src/tags.test.ts` (4A), assertions unchanged. These nine
 * cases stay on the whole app because each chains several routes — create,
 * patch, apply, remove, and the inbox list whose chips and tag filter show the
 * result — or, for the three previews, asserts what the api's `templateValues`
 * port reads from the cadastro. The other eleven are the tag and template
 * slices' own tests in each slice's `tests/` under
 * `packages/core/src/modules/conversations/`:
 * list-tags (1), create-tag (1), update-tag (3), create-template (2),
 * apply-tag (2), remove-tag (1), preview-template (1).
 *
 * Setup: `describeWithDatabase` + `withTestTransaction`; every row is created
 *   inside the test's transaction and rolled back with it. The app is built with
 *   `buildApp({ db: tx, runInTransaction: runInTransactionOnTx(tx) })`, so the
 *   Prisma tags, conversations and cadastro adapters are what answer. `getUser`
 *   stays faked — Supabase JWT verification is an external port, not a store
 *   (design D4).
 *
 *   THE APP IS BUILT WITH THIS TEST'S OWN INSTANCE NAME and a pinned channel
 *   probe, for the reason recorded in apps/api/test/services.integration.test.ts:
 *   `buildApp` resolves the instance name AT CONSTRUCTION through
 *   `resolveEvolutionInstanceName`, which THROWS when `EVOLUTION_INSTANCE_NAME`
 *   is unset — so without an injected name this file could not build an app at
 *   all under a gate that runs with `.env` off disk. Injecting the
 *   connection's real `instanceName` also points channel identity at the
 *   connection THIS test seeded. The probe is pinned so the suite cannot reach
 *   the real Evolution instance by construction; no route here consults it.
 *
 * Oracle: openspec/changes/tags-and-templates-crud design.md axes 1–4 and
 *   specs/tags-templates + conversas deltas.
 *
 * FAKE-ONLY ASSERTIONS SURFACED (four; this file's proof)
 *
 * F1 — Every uniqueness rule here is a PARTIAL unique index, and the fake
 *   enforced it in JavaScript. `schema.prisma` declares none of them; they are
 *   raw SQL, and `\d` is the only source of truth:
 *     tag_unit_id_name_active_key       UNIQUE (unit_id, name) WHERE active
 *     template_unit_id_name_active_key  UNIQUE (unit_id, name) WHERE status='active'
 *     conversation_tag_open_apply_key   UNIQUE (conversation_id, tag_id) WHERE removed_at IS NULL
 *   The adapter's 409s come from catching P2002 off those indexes, so on a map
 *   the conflict path was the fake's own logic and the index's PARTIAL scope was
 *   never expressed at all. Two cases are added for exactly what "partial"
 *   means and the fake could not: deactivating a tag FREES its name, and
 *   removing an apply lets the same tag be applied again.
 *
 * F2 — The rejections abort the transaction, which reshapes the tests. Because
 *   the 409s ride on a real constraint violation, the failing statement poisons
 *   the enclosing test transaction and Prisma exposes no savepoint (design D2),
 *   so NOTHING can run after the rejected call. On the fake a rejection was an
 *   ordinary return value and the old tests could keep going. Each of the three
 *   conflict cases here therefore puts its positive control BEFORE the rejection
 *   and ends on it.
 *
 *   Measured, not assumed: a throwaway probe that asked for `tag.count()` after
 *   the duplicate-create 409 failed with Postgres `25P02`, "current transaction
 *   is aborted, commands ignored until end of transaction block". Note what that
 *   would have looked like in a longer test — the failure names whichever line
 *   ran next, not the rejection that caused it, so the misleading error is the
 *   real hazard rather than the abort itself.
 *
 * F3 — "The preview did not enqueue" was read from a fake accessor.
 *   `conversations.outboxCount()` is the store's own counter; asserting it
 *   asserts the fake did not increment its own number. It is read here as a row
 *   count on `outbox_message` through `tx`, which is the only thing that can
 *   show no message was queued.
 *
 * F4 — Tag-to-loja and conversation-to-loja were flat fields. The fake's
 *   `seedUnit`/`seedConversation` wrote scalars the store compared. The adapter
 *   scopes tags by `tag.unitId` against a real `unit` FK and conversations
 *   through `conversation -> whatsappConnection -> unitId`, so the another-loja
 *   cases now hang real rows off a second loja's real connection.
 *
 * Axes
 *   A1 CRUD — create+list / duplicate 409 / name freed after deactivate /
 *      other-loja empty / deactivate hides apply-options / unknown patch 404 /
 *      unknown template variable 400
 *   A2 Apply history — first apply chip / second apply one chip / remove hides
 *      chip / re-apply after remove / inactive 409 / other-loja conversation 404
 *   A3 Filter AND — T1 both threads / T1+T2 one thread / unknown id empty 200
 *   A4 Preview — both values substituted / missing plate leaves {{placa}} /
 *      null name leaves {{nome_cliente}} and never leaks the phone / no outbox row
 *
 * Outputs: O1 201/200 bodies; O2 409; O3 404; O4 400; O5 empty list 200
 *
 * Decision map (tags/routes.ts + tags/prisma.ts)
 *   D1  createTag P2002          T duplicate it; F create+list, freed-name it
 *   D2  patchTag missing/other loja T unknown-id it; F deactivate it
 *   D3  listApplyOptions active  T create-then-options; F after deactivate
 *   D4  apply !tag.active        T inactive 409 it; F apply its
 *   D5  apply open exists        T second apply; F first apply, re-apply it
 *   D6  apply conversation miss  T other-loja 404; F same-loja applies
 *   D7  conversationIdsWithAllTags unknown id T unknown filter; F T1 / T1+T2
 *   D8  preview template missing T missing-template 404; F the preview its
 *   D9  interpolate placa present T both-values; F missing-plate it
 *   D10 patchTag fields defined  T patch-fields it; F deactivate (active only)
 *   D11 patchTag P2002           T rename-to-taken it; F patch-fields it
 *   D12 remove no open apply     T never-applied 404; F apply-then-remove
 *   D13 createTemplate P2002     T duplicate-template it; F preview creates
 *   !unitId                      contract-hidden — the auth hook 403s first
 *
 * Out of scope: the web Configurações screen; `tags.live.test.ts`, which keeps
 *   its own seed-once shape.
 */
import { expect, it } from "vitest";
import { prisma, type DbClient, type PrismaClient } from "@select-lub/core/db";
import {
  describeWithDatabase,
  runInTransactionOnTx,
  seedConnection,
  seedConversation,
  seedUnit,
  seedUser,
  withTestTransaction,
} from "@select-lub/core/testing";
import {
  conversationSummaryListSchema,
  tagSchema,
  templatePreviewSchema,
} from "@select-lub/shared-types";
import { buildApp } from "../src/app.js";
import { createFakeGetUser, TEST_ACCESS_TOKEN, TEST_USER_ID } from "@select-lub/core/testing";

function headers(unitId: string) {
  return {
    "x-unit-id": unitId,
    "content-type": "application/json",
    authorization: `Bearer ${TEST_ACCESS_TOKEN}`,
  };
}

function readHeaders(unitId: string) {
  return { "x-unit-id": unitId, authorization: `Bearer ${TEST_ACCESS_TOKEN}` };
}

async function appOn(tx: DbClient, instanceName: string) {
  return buildApp({
    db: tx,
    runInTransaction: runInTransactionOnTx(tx),
    getUser: createFakeGetUser(),
    evolutionInstanceName: instanceName,
    channelConnected: async () => true,
  });
}

/** One loja, its connection, and the test attendant. */
async function seedScope(tx: DbClient, extraUnits: string[] = []) {
  const unit = await seedUnit(tx);
  const connection = await seedConnection(tx, { unitId: unit.id });
  await seedUser(tx, { id: TEST_USER_ID, units: [unit.id, ...extraUnits] });
  return { unitId: unit.id, connectionId: connection.id, instanceName: connection.instanceName };
}

/** Creates a tag over HTTP and returns its id, asserting the 201 on the way. */
async function createTag(
  app: Awaited<ReturnType<typeof appOn>>,
  unitId: string,
  payload: { name: string; color?: string; sortOrder?: number },
) {
  const created = await app.inject({
    method: "POST",
    url: "/tags",
    headers: headers(unitId),
    payload,
  });
  expect(created.statusCode).toBe(201);
  return created.json().id as string;
}

async function createTemplate(
  app: Awaited<ReturnType<typeof appOn>>,
  unitId: string,
  payload: { name: string; text: string; allowedVariables?: string[] },
) {
  const created = await app.inject({
    method: "POST",
    url: "/templates",
    headers: headers(unitId),
    payload,
  });
  expect(created.statusCode).toBe(201);
  return created.json().id as string;
}

/** The conversation summaries for a loja, optionally filtered by tag ids. */
async function listConversations(
  app: Awaited<ReturnType<typeof appOn>>,
  unitId: string,
  tagIds: string[] = [],
) {
  const query = tagIds.map((id) => `tagId=${encodeURIComponent(id)}`).join("&");
  const response = await app.inject({
    method: "GET",
    url: query ? `/conversations?${query}` : "/conversations",
    headers: readHeaders(unitId),
  });
  expect(response.statusCode).toBe(200);
  return conversationSummaryListSchema.parse(response.json());
}

/** A customer in `unitId` with one vehicle, which is the titular for preview. */
async function insertCustomerWithVehicle(
  tx: DbClient,
  input: { unitId: string; name: string | null; plate: string | null },
) {
  const customer = await tx.customer.create({
    data: { origin: "crm", status: "active", name: input.name, unitId: input.unitId },
    select: { id: true },
  });
  await tx.vehicle.create({
    data: { customerId: customer.id, origin: "crm", plate: input.plate },
  });
  return customer;
}

describeWithDatabase("tags and templates HTTP", () => {
  const db = () => prisma as PrismaClient;

  it("creates a tag with color primary and lists it in the same loja", () =>
    withTestTransaction(db(), async (tx) => {
      const scope = await seedScope(tx);
      const app = await appOn(tx, scope.instanceName);
      try {
        const created = await app.inject({
          method: "POST",
          url: "/tags",
          headers: headers(scope.unitId),
          payload: { name: "Retorno", color: "primary" },
        });
        expect(created.statusCode).toBe(201);
        const tag = tagSchema.parse(created.json());
        expect(tag.color).toBe("primary");

        const listed = await app.inject({
          method: "GET",
          url: "/tags",
          headers: readHeaders(scope.unitId),
        });
        expect(listed.statusCode).toBe(200);
        // This test's own id — the loja is freshly created, but asserting the id
        // keeps the claim about the row that was written (design D9).
        expect(listed.json().map((row: { id: string }) => row.id)).toEqual([tag.id]);
      } finally {
        await app.close();
      }
    }));

  it("frees a tag name once the tag is deactivated", () =>
    withTestTransaction(db(), async (tx) => {
      const scope = await seedScope(tx);
      const app = await appOn(tx, scope.instanceName);
      try {
        const first = await createTag(app, scope.unitId, { name: "Retorno" });

        const patched = await app.inject({
          method: "PATCH",
          url: `/tags/${first}`,
          headers: headers(scope.unitId),
          payload: { active: false },
        });
        expect(patched.statusCode).toBe(200);

        // The index is UNIQUE (unit_id, name) WHERE active, so an inactive row
        // does not occupy the name. The fake enforced uniqueness in JavaScript
        // and could not express the WHERE (F1).
        const second = await createTag(app, scope.unitId, { name: "Retorno" });
        expect(second).not.toBe(first);
        expect(
          await tx.tag.count({ where: { unitId: scope.unitId, name: "Retorno" } }),
        ).toBe(2);
      } finally {
        await app.close();
      }
    }));

  it("omits a deactivated tag from apply-options and keeps an open chip", () =>
    withTestTransaction(db(), async (tx) => {
      const scope = await seedScope(tx);
      const conversation = await seedConversation(tx, { connectionId: scope.connectionId });
      const app = await appOn(tx, scope.instanceName);
      try {
        const tagId = await createTag(app, scope.unitId, { name: "Retorno", color: "primary" });
        const applied = await app.inject({
          method: "POST",
          url: `/conversations/${conversation.id}/tags/${tagId}`,
          headers: readHeaders(scope.unitId),
        });
        expect(applied.statusCode).toBe(200);

        const patched = await app.inject({
          method: "PATCH",
          url: `/tags/${tagId}`,
          headers: headers(scope.unitId),
          payload: { active: false },
        });
        expect(patched.statusCode).toBe(200);

        const options = await app.inject({
          method: "GET",
          url: "/tags/apply-options",
          headers: readHeaders(scope.unitId),
        });
        expect(options.statusCode).toBe(200);
        expect(options.json().map((row: { id: string }) => row.id)).not.toContain(tagId);

        // Deactivating hides the option; it does not close an apply that is
        // already open, so the chip stays on the thread.
        const summaries = await listConversations(app, scope.unitId);
        const mine = summaries.find((row) => row.id === conversation.id);
        expect(mine?.tags).toEqual([expect.objectContaining({ id: tagId, name: "Retorno" })]);
      } finally {
        await app.close();
      }
    }));

  it("applies a tag once, ignores a second apply, and removes the chip", () =>
    withTestTransaction(db(), async (tx) => {
      const scope = await seedScope(tx);
      const conversation = await seedConversation(tx, { connectionId: scope.connectionId });
      const app = await appOn(tx, scope.instanceName);
      try {
        const tagId = await createTag(app, scope.unitId, { name: "Retorno" });
        const apply = () =>
          app.inject({
            method: "POST",
            url: `/conversations/${conversation.id}/tags/${tagId}`,
            headers: readHeaders(scope.unitId),
          });

        expect((await apply()).statusCode).toBe(200);
        expect((await apply()).statusCode).toBe(200);

        const afterApply = await listConversations(app, scope.unitId);
        expect(afterApply.find((row) => row.id === conversation.id)?.tags).toHaveLength(1);
        // One row underneath, not two: the second apply found the open one.
        expect(
          await tx.conversationTag.count({
            where: { conversationId: conversation.id, tagId, removedAt: null },
          }),
        ).toBe(1);

        const removed = await app.inject({
          method: "DELETE",
          url: `/conversations/${conversation.id}/tags/${tagId}`,
          headers: readHeaders(scope.unitId),
        });
        expect(removed.statusCode).toBe(200);

        const afterRemove = await listConversations(app, scope.unitId);
        expect(afterRemove.find((row) => row.id === conversation.id)?.tags).toEqual([]);
        // Closed, not deleted: the row keeps the history with removedAt set.
        expect(
          await tx.conversationTag.count({
            where: { conversationId: conversation.id, tagId, removedAt: { not: null } },
          }),
        ).toBe(1);
      } finally {
        await app.close();
      }
    }));

  it("lets the same tag be applied again after it was removed", () =>
    withTestTransaction(db(), async (tx) => {
      const scope = await seedScope(tx);
      const conversation = await seedConversation(tx, { connectionId: scope.connectionId });
      const app = await appOn(tx, scope.instanceName);
      try {
        const tagId = await createTag(app, scope.unitId, { name: "Retorno" });
        const apply = () =>
          app.inject({
            method: "POST",
            url: `/conversations/${conversation.id}/tags/${tagId}`,
            headers: readHeaders(scope.unitId),
          });

        expect((await apply()).statusCode).toBe(200);
        expect(
          (
            await app.inject({
              method: "DELETE",
              url: `/conversations/${conversation.id}/tags/${tagId}`,
              headers: readHeaders(scope.unitId),
            })
          ).statusCode,
        ).toBe(200);

        // The open-apply index is UNIQUE (conversation_id, tag_id) WHERE
        // removed_at IS NULL, so a closed row does not block a fresh apply. A
        // total index would reject this insert (F1).
        expect((await apply()).statusCode).toBe(200);

        const summaries = await listConversations(app, scope.unitId);
        expect(summaries.find((row) => row.id === conversation.id)?.tags).toHaveLength(1);
        expect(
          await tx.conversationTag.count({ where: { conversationId: conversation.id, tagId } }),
        ).toBe(2);
      } finally {
        await app.close();
      }
    }));

  it("filters the inbox with AND of open tag applies", () =>
    withTestTransaction(db(), async (tx) => {
      const scope = await seedScope(tx);
      const onlyT1 = await seedConversation(tx, { connectionId: scope.connectionId });
      const both = await seedConversation(tx, { connectionId: scope.connectionId });
      const app = await appOn(tx, scope.instanceName);
      try {
        const t1 = await createTag(app, scope.unitId, { name: "T1" });
        const t2 = await createTag(app, scope.unitId, { name: "T2" });
        const apply = async (conversationId: string, tagId: string) => {
          const response = await app.inject({
            method: "POST",
            url: `/conversations/${conversationId}/tags/${tagId}`,
            headers: readHeaders(scope.unitId),
          });
          expect(response.statusCode).toBe(200);
        };
        await apply(onlyT1.id, t1);
        await apply(both.id, t1);
        await apply(both.id, t2);

        const byT1 = await listConversations(app, scope.unitId, [t1]);
        expect(byT1.map((row) => row.id).sort()).toEqual([onlyT1.id, both.id].sort());

        const byBoth = await listConversations(app, scope.unitId, [t1, t2]);
        expect(byBoth.map((row) => row.id)).toEqual([both.id]);

        // An id no tag in this loja carries short-circuits to an empty list,
        // which is a 200 and not a 400.
        const unknown = await listConversations(app, scope.unitId, ["unknown-tag"]);
        expect(unknown).toEqual([]);
      } finally {
        await app.close();
      }
    }));

  it("previews a template without queueing an outbox row", () =>
    withTestTransaction(db(), async (tx) => {
      const scope = await seedScope(tx);
      const customer = await insertCustomerWithVehicle(tx, {
        unitId: scope.unitId,
        name: "Ana",
        plate: "ABC1D23",
      });
      const conversation = await seedConversation(tx, { connectionId: scope.connectionId });
      await tx.conversation.update({
        where: { id: conversation.id },
        data: { customerId: customer.id },
      });
      const app = await appOn(tx, scope.instanceName);
      try {
        const templateId = await createTemplate(app, scope.unitId, {
          name: "Saudacao",
          text: "Ola {{nome_cliente}}, placa {{placa}}",
          allowedVariables: ["nome_cliente", "placa"],
        });

        const preview = await app.inject({
          method: "POST",
          url: `/conversations/${conversation.id}/templates/${templateId}/preview`,
          headers: readHeaders(scope.unitId),
        });

        expect(preview.statusCode).toBe(200);
        expect(templatePreviewSchema.parse(preview.json()).text).toBe("Ola Ana, placa ABC1D23");
        // The table, not the store's own counter: a preview that queued a
        // message would show up here and nowhere else (F3).
        expect(
          await tx.outboxMessage.count({ where: { conversationId: conversation.id } }),
        ).toBe(0);
      } finally {
        await app.close();
      }
    }));

  it("leaves {{placa}} in the preview when the titular vehicle has no plate", () =>
    withTestTransaction(db(), async (tx) => {
      const scope = await seedScope(tx);
      const customer = await insertCustomerWithVehicle(tx, {
        unitId: scope.unitId,
        name: "Ana",
        plate: null,
      });
      const conversation = await seedConversation(tx, { connectionId: scope.connectionId });
      await tx.conversation.update({
        where: { id: conversation.id },
        data: { customerId: customer.id },
      });
      const app = await appOn(tx, scope.instanceName);
      try {
        const templateId = await createTemplate(app, scope.unitId, {
          name: "Saudacao",
          text: "Ola {{nome_cliente}}, placa {{placa}}",
        });

        const preview = await app.inject({
          method: "POST",
          url: `/conversations/${conversation.id}/templates/${templateId}/preview`,
          headers: readHeaders(scope.unitId),
        });

        expect(preview.statusCode).toBe(200);
        // The placeholder survives rather than becoming an empty gap or an
        // invented plate.
        expect(templatePreviewSchema.parse(preview.json()).text).toBe(
          "Ola Ana, placa {{placa}}",
        );
        expect(
          await tx.outboxMessage.count({ where: { conversationId: conversation.id } }),
        ).toBe(0);
      } finally {
        await app.close();
      }
    }));

  it("leaves {{nome_cliente}} in the preview when the customer name is null, without leaking the phone", () =>
    withTestTransaction(db(), async (tx) => {
      const scope = await seedScope(tx);
      const customer = await insertCustomerWithVehicle(tx, {
        unitId: scope.unitId,
        name: null,
        plate: "ABC1D23",
      });
      const chatKey = "5511999990000";
      const conversation = await seedConversation(tx, {
        connectionId: scope.connectionId,
        chatKey,
      });
      await tx.conversation.update({
        where: { id: conversation.id },
        data: { customerId: customer.id },
      });
      const app = await appOn(tx, scope.instanceName);
      try {
        const templateId = await createTemplate(app, scope.unitId, {
          name: "Saudacao",
          text: "Ola {{nome_cliente}}, placa {{placa}}",
        });

        const preview = await app.inject({
          method: "POST",
          url: `/conversations/${conversation.id}/templates/${templateId}/preview`,
          headers: readHeaders(scope.unitId),
        });

        expect(preview.statusCode).toBe(200);
        const { text } = templatePreviewSchema.parse(preview.json());
        expect(text).toBe("Ola {{nome_cliente}}, placa ABC1D23");
        // A nameless contact is not addressed by their number.
        expect(text).not.toContain(chatKey);
      } finally {
        await app.close();
      }
    }));
});


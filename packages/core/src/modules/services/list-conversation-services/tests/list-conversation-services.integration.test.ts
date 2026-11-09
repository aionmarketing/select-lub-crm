/**
 * Test design (testing-strategy)
 *
 * Moved from `apps/api/src/customer-services.test.ts` (adopt-modular-vertical-
 * slices 3C): its four conversation-scoped GET cases, assertions unchanged. The
 * slice runs alone on the harness app over the test transaction, with the
 * caller stated. The fifth case of that describe — the conversation LIST has no
 * `services` key — is about `conversations`' route, not this one, and went to
 * `apps/api/test/services.integration.test.ts`, where the whole app is built.
 *
 * Oracle: openspec/changes/complete-omie-integration/specs/customer-services/spec.md
 *   conversation GET wrappers.
 *
 * F2 (from the original file) — Phone resolution matches a real CustomerPhone
 *   row joined back to the loja, and the phone it is matched against is the
 *   conversation's `chatKey`. Seeded here as a `CustomerPhone` row whose
 *   `normalized` IS the chat key.
 *
 * Axis 3 — conversation-scoped GET (EP, same resolve classes as vehicles)
 *   EP valid: the conversation names a customer → services of that customer
 *   EP valid: it names none, chat key matches a phone → resolved
 *   EP valid: no customer resolves → `{ customerId: null, services: [] }`
 *   EP invalid: unknown conversation id → 404
 *
 * Sampled-cell
 *   GET conversation with customerId      | 200, services present  | empty
 *   GET conversation resolves by chat key | 200, services present  | empty
 *   GET conversation unresolved           | 200, null + []         | 404/populated
 *   GET unknown conversation              | 404                    | 200
 *
 * Decision map (list-conversation-services/index.ts)
 *   conversation missing                T unknown-conversation 404; F the rest
 *   named customer resolves in loja     T the customerId it; F the phone it
 *   phone match hits                    T the phone it; F the unresolved it
 */
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { prisma, type PrismaClient } from "@select-lub/core/db";
import {
  describeWithDatabase,
  seedConversation,
  withTestTransaction,
} from "@select-lub/core/testing";
import { conversationServicesSchema } from "../../contracts/http.js";
import { appOn, insertService, seedScope } from "./conversation-services.fixture.js";

describeWithDatabase("conversation-scoped service HTTP", () => {
  const db = () => prisma as PrismaClient;

  it("lists services when the conversation already names a customer", () =>
    withTestTransaction(db(), async (tx) => {
      const scope = await seedScope(tx);
      const service = await insertService(tx, {
        customerId: scope.customerId,
        unitId: scope.unitId,
      });
      const conversation = await seedConversation(tx, { connectionId: scope.connectionId });
      await tx.conversation.update({
        where: { id: conversation.id },
        data: { customerId: scope.customerId },
      });
      const app = await appOn(tx, scope);
      try {
        const response = await app.inject({
          method: "GET",
          url: `/conversations/${conversation.id}/services`,
        });

        expect(response.statusCode).toBe(200);
        const body = conversationServicesSchema.parse(response.json());
        expect(body.customerId).toBe(scope.customerId);
        expect(body.services.map((row) => row.id)).toEqual([service.id]);
      } finally {
        await app.close();
      }
    }));

  it("resolves the customer by the chat key when the conversation names none", () =>
    withTestTransaction(db(), async (tx) => {
      const scope = await seedScope(tx);
      const service = await insertService(tx, {
        customerId: scope.customerId,
        unitId: scope.unitId,
      });
      // The conversation's chatKey is matched AS the phone, against a real
      // CustomerPhone row joined back to the loja (F2). So the two must be the
      // same string.
      const chatKey = `5519${randomUUID().replace(/\D/g, "").slice(0, 8).padEnd(8, "0")}`;
      await tx.customerPhone.create({
        data: {
          customerId: scope.customerId,
          raw: chatKey,
          normalized: chatKey,
          isPrimary: true,
        },
      });
      const conversation = await seedConversation(tx, {
        connectionId: scope.connectionId,
        chatKey,
      });
      const app = await appOn(tx, scope);
      try {
        const response = await app.inject({
          method: "GET",
          url: `/conversations/${conversation.id}/services`,
        });

        expect(response.statusCode).toBe(200);
        const body = conversationServicesSchema.parse(response.json());
        expect(body.customerId).toBe(scope.customerId);
        expect(body.services.map((row) => row.id)).toEqual([service.id]);
      } finally {
        await app.close();
      }
    }));

  it("returns an empty services list when no customer resolves", () =>
    withTestTransaction(db(), async (tx) => {
      const scope = await seedScope(tx);
      // A chat key no CustomerPhone row carries: the link exists, the resolve
      // misses, and that is a 200 with nothing rather than a 404.
      const conversation = await seedConversation(tx, {
        connectionId: scope.connectionId,
        chatKey: `5511${randomUUID().replace(/\D/g, "").slice(0, 8).padEnd(8, "0")}`,
      });
      const app = await appOn(tx, scope);
      try {
        const response = await app.inject({
          method: "GET",
          url: `/conversations/${conversation.id}/services`,
        });

        expect(response.statusCode).toBe(200);
        expect(conversationServicesSchema.parse(response.json())).toEqual({
          customerId: null,
          services: [],
        });
      } finally {
        await app.close();
      }
    }));

  it("returns 404 for an unknown conversation", () =>
    withTestTransaction(db(), async (tx) => {
      const scope = await seedScope(tx);
      const conversation = await seedConversation(tx, { connectionId: scope.connectionId });
      const app = await appOn(tx, scope);
      try {
        // Positive control: a real conversation on this loja answers 200.
        const present = await app.inject({
          method: "GET",
          url: `/conversations/${conversation.id}/services`,
        });
        expect(present.statusCode).toBe(200);

        const response = await app.inject({
          method: "GET",
          url: "/conversations/missing/services",
        });
        expect(response.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    }));
});

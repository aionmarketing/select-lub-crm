/**
 * Test design (testing-strategy) — conversations / list-conversations
 *
 * Module role: `module_conversations`. The list, customer, quote and
 * attribution reads each run in their own `db.tx("conversations", …)`; the tag
 * chips in one more.
 *
 * Moved (4A), assertions unchanged, from two files:
 *   - `apps/api/src/conversations.test.ts`: its eight list cases — empty unit,
 *     newest first, the three contactLabel cases, the three unanswered cases.
 *   - `apps/api/src/conversations.filters.route.test.ts`: "lists every
 *     connection of the unit and no other unit's, scoping through the join"
 *     (#102's tenancy scenario). It listed both lojas through one app by
 *     switching the `x-unit-id` header; a slice app states its caller, so each
 *     loja gets its own app over the same transaction.
 * The filters are `list-conversations.filters.integration.test.ts`; the store
 * branches are `list-conversations.fake-client.test.ts`.
 *
 * SUT: `GET /conversations`, through `buildSliceApp` with this slice's route
 *   only, inside one rolling-back transaction.
 *
 * WHAT ONLY HELD ON THE FAKE (from the original files)
 *   Scoping is a join: `Conversation` has no `unitId` column; the list scopes
 *   with `whatsappConnection: { unitId }`. The tenancy case needs TWO
 *   connections in one loja, which the fake had no way to express.
 *   `contactLabel` needs a real customer: there is no name column on the
 *   conversation; the list reads `customerId` and looks the name up.
 *
 * Spec rule (openspec/specs/conversations/conversas/spec.md): list scoped to the unit, newest
 *   lastMessageAt first; `unanswered` = a `shouldReply: true` inbound with no
 *   later outbound; false and unlabeled never count.
 *
 * Partitions
 *   P1 empty unit → []            P2 later lastMessageAt listed first
 *   P3 contactLabel: phone / linked name / linked null name
 *   U1 pending shouldReply listed; false and unlabeled omitted
 *   U2 a later outbound drops it  U3 no pending → []
 *   T1 two connections in one loja listed, a third loja's not; and the other
 *      loja sees only its own
 */
import { expect, it } from "vitest";
import {
  describeWithDatabase,
  seedConnection,
  seedConversation,
  seedUnit,
  seedUser,
  withTestTransaction,
} from "@select-lub/core/testing";
import { addCustomer, addMessages, db, idsOf, listApp, listIds, setup } from "./conversation-list.fixture.js";

describeWithDatabase("GET /conversations", () => {
  it("returns an empty list when the unit has no conversations", () =>
    withTestTransaction(db(), async (tx) => {
      const { app } = await setup(tx);
      const response = await listIds(app, "");
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([]);
      await app.close();
    }));

  it("lists conversations newest lastMessageAt first", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, app } = await setup(tx);
      const earlier = await seedConversation(tx, {
        connectionId: connection.id,
        chatKey: "111",
        lastMessageAt: new Date("2026-08-01T12:00:00.000Z"),
      });
      const later = await seedConversation(tx, {
        connectionId: connection.id,
        chatKey: "222",
        lastMessageAt: new Date("2026-08-02T12:00:00.000Z"),
      });

      const response = await listIds(app, "");
      expect(response.statusCode).toBe(200);
      expect(response.json().map((row: { id: string }) => row.id)).toEqual([later.id, earlier.id]);
      await app.close();
    }));

  it("uses the phone as contactLabel when no customer is linked", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, app } = await setup(tx);
      await seedConversation(tx, { connectionId: connection.id, chatKey: "11988887777" });

      const response = await listIds(app, "");
      expect(response.json()[0]?.contactLabel).toBe("11988887777");
      expect(response.json()[0]?.phone).toBe("11988887777");
      await app.close();
    }));

  it("uses the linked customer name as contactLabel when it is non-empty", () =>
    withTestTransaction(db(), async (tx) => {
      const { unit, connection, app } = await setup(tx);
      const conversation = await seedConversation(tx, { connectionId: connection.id, chatKey: "11988887777" });
      // The fake took `customerName` as a field on the conversation. There is no
      // such column: the list reads `customerId` and looks the name up.
      await addCustomer(tx, { unitId: unit.id, conversationId: conversation.id, name: "Maria Silva" });

      const response = await listIds(app, "");
      expect(response.json()[0]?.contactLabel).toBe("Maria Silva");
      expect(response.json()[0]?.phone).toBe("11988887777");
      await app.close();
    }));

  it("uses the phone as contactLabel when the linked customer name is null", () =>
    withTestTransaction(db(), async (tx) => {
      const { unit, connection, app } = await setup(tx);
      const conversation = await seedConversation(tx, { connectionId: connection.id, chatKey: "5511999990000" });
      const customer = await addCustomer(tx, { unitId: unit.id, conversationId: conversation.id, name: null });

      // Precondition: the conversation really is linked, so falling back to the
      // phone is the null NAME talking and not a missing link.
      expect(
        (await tx.conversation.findUnique({ where: { id: conversation.id }, select: { customerId: true } }))
          ?.customerId,
      ).toBe(customer.id);

      const response = await listIds(app, "");
      expect(response.json()[0]?.contactLabel).toBe("5511999990000");
      expect(response.json()[0]?.contactLabel).not.toBe("Omie");
      expect(response.json()[0]?.contactLabel).not.toBe("Sem nome");
      await app.close();
    }));

  it("lists a pending shouldReply conversation and omits false and unlabeled", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, app } = await setup(tx);
      const pending = await seedConversation(tx, { connectionId: connection.id, chatKey: "111" });
      await addMessages(tx, pending.id, [
        {
          direction: "inbound",
          textBody: "quanto custa?",
          providerTimestamp: new Date("2026-08-26T12:00:00.000Z"),
          shouldReply: true,
        },
      ]);
      const answered = await seedConversation(tx, { connectionId: connection.id, chatKey: "222" });
      await addMessages(tx, answered.id, [
        {
          direction: "inbound",
          textBody: "ok",
          providerTimestamp: new Date("2026-08-26T12:01:00.000Z"),
          shouldReply: false,
        },
      ]);
      const unlabeled = await seedConversation(tx, { connectionId: connection.id, chatKey: "333" });
      await addMessages(tx, unlabeled.id, [
        { direction: "inbound", textBody: "histórico", providerTimestamp: new Date("2026-08-26T12:02:00.000Z") },
      ]);

      const filtered = await listIds(app, "?unanswered=true");
      expect(filtered.statusCode).toBe(200);
      expect(filtered.json()).toEqual([expect.objectContaining({ id: pending.id, unanswered: true, phone: "111" })]);

      const all = await listIds(app, "");
      const rows = all.json() as { id: string; unanswered: boolean; phone: string }[];
      expect(rows.find((row) => row.phone === "111")?.unanswered).toBe(true);
      expect(rows.find((row) => row.phone === "222")?.unanswered).toBe(false);
      expect(rows.find((row) => row.phone === "333")?.unanswered).toBe(false);
      await app.close();
    }));

  it("drops a conversation from unanswered after a later outbound", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, app } = await setup(tx);
      const conversation = await seedConversation(tx, { connectionId: connection.id, chatKey: "111" });
      await addMessages(tx, conversation.id, [
        {
          direction: "inbound",
          textBody: "oi",
          providerTimestamp: new Date("2026-08-26T12:00:00.000Z"),
          shouldReply: true,
        },
        { direction: "outbound", textBody: "já respondi", providerTimestamp: new Date("2026-08-26T12:01:00.000Z") },
      ]);

      const response = await listIds(app, "?unanswered=true");
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([]);
      await app.close();
    }));

  it("returns an empty unanswered list when the unit has no pending shouldReply", () =>
    withTestTransaction(db(), async (tx) => {
      const { app } = await setup(tx);

      const response = await listIds(app, "?unanswered=true");
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([]);
      await app.close();
    }));

  it("lists every connection of the unit and no other unit's, scoping through the join", () =>
    withTestTransaction(db(), async (tx) => {
      // Task 2.2. UNWRITABLE against the fake: it stored a flat `unitId` on the
      // conversation and had no connection concept, so "two connections in one
      // unit" could not be expressed and "one unit" was never a join. This pins
      // `where: { whatsappConnection: { unitId } }`.
      const unit = await seedUnit(tx);
      const other = await seedUnit(tx);
      const first = await seedConnection(tx, { unitId: unit.id });
      const second = await seedConnection(tx, { unitId: unit.id });
      const foreign = await seedConnection(tx, { unitId: other.id });
      const user = await seedUser(tx, { units: [unit.id, other.id] });

      const onFirst = await seedConversation(tx, { connectionId: first.id, chatKey: "11911110001" });
      const onSecond = await seedConversation(tx, { connectionId: second.id, chatKey: "11911110002" });
      const onForeign = await seedConversation(tx, { connectionId: foreign.id, chatKey: "11911110003" });

      // Precondition: the two connections really are distinct rows in the same
      // unit. Without this the assertion below would also pass if `seedConnection`
      // had returned the same connection twice.
      expect(first.id).not.toBe(second.id);
      expect(first.unitId).toBe(second.unitId);
      expect(foreign.unitId).not.toBe(unit.id);

      const app = await listApp(tx, { userId: user.id, unitId: unit.id });
      const response = await listIds(app, "");

      expect(response.statusCode).toBe(200);
      expect([...idsOf(response)].sort()).toEqual([onFirst, onSecond].map((c) => c.id).sort());
      expect(idsOf(response)).not.toContain(onForeign.id);
      await app.close();

      // And the other unit sees only its own, so the scope is a filter rather
      // than a global list that happened to match.
      const otherApp = await listApp(tx, { userId: user.id, unitId: other.id });
      const otherResponse = await listIds(otherApp, "");
      expect(idsOf(otherResponse)).toEqual([onForeign.id]);
      await otherApp.close();
    }));
});

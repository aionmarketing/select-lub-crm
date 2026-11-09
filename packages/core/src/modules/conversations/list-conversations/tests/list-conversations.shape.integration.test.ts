/**
 * Test design (testing-strategy) — a conversation list item carries no cadastro
 *
 * Module role: `module_conversations` (the list's reads).
 *
 * Adopted from 4B's `apps/api/src/conversations.list-shape.test.ts` (originally
 * `apps/api/src/cadastro.vehicles.test.ts`) in 4A, assertions unchanged. It ran
 * on the full app with the auth hook; the hook is not what it asserts, so here
 * it runs on this slice's route, with the same fixture: a loja, its connection,
 * a customer with one vehicle, and a conversation linked to that customer.
 *
 * SUT: `GET /conversations`, through `buildSliceApp` with this slice's route only.
 * Oracle: the conversation list's contract — an item is the conversation's
 *   summary; the customer and its vehicles are the rail's own reads
 *   (`GET /conversations/:id/customer`, `GET /conversations/:id/vehicles`), never
 *   inlined into the list.
 *
 * One assertion added with the adoption: the same two absences on the RAW
 * response body. The original reads them off `conversationSummaryListSchema.parse`,
 * which strips unknown keys, so on its own it would pass even if the route sent
 * them.
 */
import { conversationSummaryListSchema } from "../../contracts/http.js";
import { expect, it } from "vitest";
import { describeWithDatabase, seedConversation, withTestTransaction } from "@select-lub/core/testing";
import { db, listIds, setup } from "./conversation-list.fixture.js";

describeWithDatabase("conversation list shape", () => {
  it("keeps conversation list items without customerId or vehicles", () =>
    withTestTransaction(db(), async (tx) => {
      const { unit, connection, app } = await setup(tx);
      const customer = await tx.customer.create({
        data: { name: "Ana", omieId: null, unitId: unit.id, origin: "manual", status: "active" },
        select: { id: true },
      });
      await tx.vehicle.create({ data: { customerId: customer.id, plate: "TITULAR1", origin: "omie" } });
      const conversation = await seedConversation(tx, { connectionId: connection.id });
      await tx.conversation.update({ where: { id: conversation.id }, data: { customerId: customer.id } });

      const response = await listIds(app, "");

      expect(response.statusCode).toBe(200);
      const list = conversationSummaryListSchema.parse(response.json());
      const row = list.find((item) => item.id === conversation.id);
      // By id, not by position: the unit is this transaction's own, but the
      // list is ordered by activity rather than by insertion.
      expect(row).toBeDefined();
      expect("customerId" in row!).toBe(false);
      expect("vehicles" in row!).toBe(false);
      // Added: the raw body, which no parse has stripped.
      const raw = (response.json() as Record<string, unknown>[]).find((item) => item.id === conversation.id);
      expect(raw).toBeDefined();
      expect(Object.keys(raw!)).not.toContain("customerId");
      expect(Object.keys(raw!)).not.toContain("vehicles");
      await app.close();
    }));
});

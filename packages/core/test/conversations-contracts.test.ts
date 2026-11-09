/**
 * Test design (testing-strategy) — conversations' public contracts
 *
 * SUT: `getCadastroLink` and `setCustomer` (`contracts/set-customer.ts`), and
 *   `setExtractEnabled` and `closePrefillWindow` (`contracts/set-extract-enabled.ts`)
 *   — the writes customers (4B) and prefill (4C) make to `conversation` and
 *   `message`, accepted in the 4A contract round.
 *
 * Why here and not beside the contracts: a test under `contracts/` is a
 *   `contracts` element to the boundary rules and may not import the harness
 *   (the scheduling-contracts precedent).
 *
 * Requirements
 *   - All four are scoped to the caller's loja through
 *     `conversation → whatsapp_connection → unit_id`; another loja's thread is
 *     `not_found` / null and is left unchanged. (`closePrefillWindow` takes no
 *     loja: prefill calls it for a window it already owns.)
 *   - Turning the switch ON stamps `last_prefill_window_closed_at = now`; OFF
 *     leaves the watermark alone.
 *   - REQUIRED (accepted contract 5): `closePrefillWindow` is compare-and-set,
 *     forward only. A stale close arriving after a newer stamp leaves the
 *     watermark unmoved. This CAN fail: a plain `update` would move it back.
 *
 * Setup: one loja, one connection, one conversation, rows inserted directly,
 *   inside one rolling-back transaction per test. Each contract runs under
 *   `module_conversations` through `createDb(tx, runInTransactionOnTx(tx))`.
 */
import { prisma, type DbClient, type PrismaClient } from "@select-lub/core/db";
import { expect, it } from "vitest";
import { createDb } from "../src/kernel/db.js";
import {
  closePrefillWindow,
  getCadastroLink,
  setCustomer,
  setExtractEnabled,
} from "../src/modules/conversations/contracts/index.js";
import {
  describeWithDatabase,
  runInTransactionOnTx,
  seedConnection,
  seedConversation,
  seedUnit,
  withTestTransaction,
} from "../src/testing/index.js";

const db = () => prisma as PrismaClient;
const EARLIER = new Date("2099-01-10T12:00:00.000Z");
const LATER = new Date("2099-01-10T12:05:00.000Z");

/** Two lojas, a conversation in the first, and the handle the contracts take. */
async function setup(tx: DbClient) {
  const unit = await seedUnit(tx);
  const otherUnit = await seedUnit(tx);
  const connection = await seedConnection(tx, { unitId: unit.id });
  const conversation = await seedConversation(tx, { connectionId: connection.id, chatKey: "5511988887777" });
  const customer = await tx.customer.create({ data: { origin: "crm", status: "active", unitId: unit.id }, select: { id: true } });
  const read = () =>
    tx.conversation.findUniqueOrThrow({
      where: { id: conversation.id },
      select: { customerId: true, prefillExtractEnabled: true, lastPrefillWindowClosedAt: true },
    });
  return {
    handle: createDb(tx, runInTransactionOnTx(tx)),
    unitId: unit.id,
    otherUnitId: otherUnit.id,
    conversationId: conversation.id,
    customerId: customer.id,
    read,
  };
}

describeWithDatabase("getCadastroLink / setCustomer", () => {
  it("reads the loja's own thread and answers null for another loja's or an unknown id", () =>
    withTestTransaction(db(), async (tx) => {
      const s = await setup(tx);

      expect(await getCadastroLink(s.handle, { conversationId: s.conversationId, unitId: s.unitId })).toEqual({
        id: s.conversationId,
        phone: "5511988887777",
        customerId: null,
      });
      expect(await getCadastroLink(s.handle, { conversationId: s.conversationId, unitId: s.otherUnitId })).toBeNull();
      expect(await getCadastroLink(s.handle, { conversationId: "missing", unitId: s.unitId })).toBeNull();
    }));

  it("links the loja's own thread, and leaves another loja's call unwritten", () =>
    withTestTransaction(db(), async (tx) => {
      const s = await setup(tx);

      // Another loja first, so the not_found cannot be explained by a link that
      // already happened.
      expect(
        await setCustomer(s.handle, { conversationId: s.conversationId, unitId: s.otherUnitId, customerId: s.customerId }),
      ).toEqual({ status: "not_found" });
      expect((await s.read()).customerId).toBeNull();

      expect(
        await setCustomer(s.handle, { conversationId: s.conversationId, unitId: s.unitId, customerId: s.customerId }),
      ).toEqual({ status: "linked" });
      expect((await s.read()).customerId).toBe(s.customerId);
      expect((await getCadastroLink(s.handle, { conversationId: s.conversationId, unitId: s.unitId }))?.customerId).toBe(
        s.customerId,
      );
    }));
});

describeWithDatabase("setExtractEnabled", () => {
  it("stamps the watermark when turned on and leaves it when turned off", () =>
    withTestTransaction(db(), async (tx) => {
      const s = await setup(tx);

      expect(
        await setExtractEnabled(s.handle, { conversationId: s.conversationId, unitId: s.unitId, enabled: true, now: EARLIER }),
      ).toEqual({ status: "updated", extractEnabled: true });
      expect(await s.read()).toMatchObject({ prefillExtractEnabled: true, lastPrefillWindowClosedAt: EARLIER });

      expect(
        await setExtractEnabled(s.handle, { conversationId: s.conversationId, unitId: s.unitId, enabled: false, now: LATER }),
      ).toEqual({ status: "updated", extractEnabled: false });
      // OFF does not move the watermark: LATER was passed and must not land.
      expect(await s.read()).toMatchObject({ prefillExtractEnabled: false, lastPrefillWindowClosedAt: EARLIER });
    }));

  it("answers not_found for another loja's thread and changes nothing", () =>
    withTestTransaction(db(), async (tx) => {
      const s = await setup(tx);

      expect(
        await setExtractEnabled(s.handle, { conversationId: s.conversationId, unitId: s.otherUnitId, enabled: true, now: EARLIER }),
      ).toEqual({ status: "not_found" });
      expect(await s.read()).toMatchObject({ prefillExtractEnabled: false, lastPrefillWindowClosedAt: null });
    }));
});

describeWithDatabase("closePrefillWindow", () => {
  it("sets the watermark when none is stored, and moves it forward", () =>
    withTestTransaction(db(), async (tx) => {
      const s = await setup(tx);

      await closePrefillWindow(s.handle, { conversationId: s.conversationId, watermark: EARLIER });
      expect((await s.read()).lastPrefillWindowClosedAt).toEqual(EARLIER);

      await closePrefillWindow(s.handle, { conversationId: s.conversationId, watermark: LATER });
      expect((await s.read()).lastPrefillWindowClosedAt).toEqual(LATER);
    }));

  it("leaves the watermark unmoved when a stale close arrives after a newer stamp", () =>
    withTestTransaction(db(), async (tx) => {
      // The race the CAS exists for: the switch is turned on (stamp LATER) while
      // an extraction that started earlier is still running; that extraction
      // then closes its window at EARLIER. A plain write would move the
      // watermark back and re-open silence that was already covered.
      const s = await setup(tx);
      await setExtractEnabled(s.handle, { conversationId: s.conversationId, unitId: s.unitId, enabled: true, now: LATER });
      // Precondition: the newer stamp is what is stored.
      expect((await s.read()).lastPrefillWindowClosedAt).toEqual(LATER);

      await closePrefillWindow(s.handle, { conversationId: s.conversationId, watermark: EARLIER });

      expect((await s.read()).lastPrefillWindowClosedAt).toEqual(LATER);
    }));

  it("labels the window's inbound messages with shouldReply", () =>
    withTestTransaction(db(), async (tx) => {
      const s = await setup(tx);
      const inbound = await tx.message.create({
        data: {
          conversationId: s.conversationId,
          externalMessageId: "WA-PREFILL-1",
          direction: "inbound",
          messageType: "text",
          textBody: "quanto custa a troca?",
          providerTimestamp: EARLIER,
        },
        select: { id: true },
      });

      await closePrefillWindow(s.handle, {
        conversationId: s.conversationId,
        watermark: LATER,
        shouldReply: { inboundIds: [inbound.id], value: true },
      });

      expect(await tx.message.findUniqueOrThrow({ where: { id: inbound.id }, select: { shouldReply: true } })).toEqual({
        shouldReply: true,
      });
      expect((await s.read()).lastPrefillWindowClosedAt).toEqual(LATER);
    }));
});

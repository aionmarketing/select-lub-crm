/**
 * Test design (testing-strategy)
 *
 * Module role: `module_prefill`. The scan and each insert run in
 * `db.tx("prefill", …)`; the scan reads `conversation` / `message` under
 * `readableBy`, and only `cadastro_prefill_job` is written.
 *
 * Moved from `apps/worker/src/prefill/enqueue.test.ts`, all 9 cases, assertions
 * unchanged. The worker store is gone: `enqueueClosedWindows` takes the module
 * handle, the in-flight case inserts its existing job directly, and the
 * full-cadastro precondition reads through this slice's `resolveCadastro`.
 *
 * Setup: `enqueueClosedWindows` on a handle over a rolling-back test
 * transaction (`withTestTransaction`) on the worktree database. No OpenAI.
 *
 * Oracle: prefill-switch-realistic-workshop-mix assistive-prefill — derived
 * 60s window runs only while the switch is on; one job per closed window;
 * outbound / young inbound / watermark / in-flight skip; full cadastro still
 * enqueues; enable stamps the watermark so elapsed silence is not backfilled.
 *
 * FAKE-ONLY ASSERTIONS SURFACED (route-tests-on-real-database, D10). Three.
 *
 *   1. `store.jobs()` returned the fake's whole job list, so every
 *      `toHaveLength(n)` was an absolute count. `listWindowScan()` on the real
 *      adapter selects EVERY conversation in the database with all of its
 *      messages — it has no tenancy predicate at all — so `enqueueClosedWindows`
 *      really does consider every conversation the worktree holds. Each count is
 *      now scoped to the conversation the test created (design.md D9).
 *
 *   2. The fake's `seedConversation` took a `cadastro` snapshot object directly,
 *      so `emptySnapshot` / `fullSnapshot` were handed to the store rather than
 *      derived from rows. The adapter builds that snapshot by joining
 *      `conversation -> whatsappConnection.unitId`, then `customer` (by
 *      `conversation.customerId`, else by a `customerPhone.normalized` match
 *      inside the same unit), then the titular `vehicle`. The "full cadastro"
 *      case therefore now seeds a real customer, phone and vehicle, and the
 *      "empty" case simply omits them — which also means the case proves the
 *      unit-scoped join, not that the test can pass its own answer in.
 *
 *   3. `store.labels(conversationId)` had no adapter equivalent; the switch-off
 *      case asserted through a fake-only accessor. It now reads `shouldReply`
 *      off the real message rows, which is the column the drain writes and the
 *      inbox reads.
 *
 * A constraint the fake did not have also shows up here and is the reason the
 * in-flight case is worth keeping: a PARTIAL unique index,
 * `UNIQUE (conversation_id) WHERE status IN ('queued','running')`, enforces
 * one in-flight job per conversation in SQL. Prisma cannot express a partial
 * unique index, so it is absent from `schema.prisma` and from the generated
 * client, and the fake did not model it either. `enqueueClosedWindows`'s
 * `findInFlightJob` guard is therefore backed by the database, not only by the
 * application check — the migrated in-flight case now proves the guard runs
 * before the insert rather than merely that a count stayed at one.
 *
 * Axes
 *   A1 window closed vs open vs outbound-closed vs watermarked
 *   A2 in-flight job present vs absent
 *   A3 cadastro empty vs full
 *   A4 extract switch on vs off
 *   A5 enable after elapsed silence, no new inbound
 *
 * Outputs: O-queued, O-none, O-count 1; unlabeled inbound
 *
 * Sampled-cell
 *   silence 60s switch on          | A1 closed A4 on  | O-queued | zero jobs
 *   silence 60s switch off         | A4 off           | O-none unlabeled | queued or labeled
 *   two inbounds one job           | A1 closed        | O-count 1 | two jobs
 *   age 10s                        | A1 open          | O-none    | queued
 *   outbound after inbound         | A1 outbound      | O-none    | queued
 *   watermark = latest             | A1 watermarked   | O-none    | queued
 *   in-flight already queued       | A2 present       | O-count 1 | second job
 *   full cadastro + closed window  | A3 full          | O-queued  | skip
 *   enable after elapsed silence   | A5               | O-none    | queued
 *
 * Decision map (enqueue.ts)
 *   D0 !prefillExtractEnabled      T: off it; F: on its
 *   D1 closedWindow null           T: open/outbound/watermark its; F: silence
 *   D2 findInFlightJob             T: in-flight it; F: insert its
 *
 * Out of scope: drain/LLM (extract.test.ts); pure window BVA (window.test.ts);
 * HTTP PATCH watermark stamp (cadastro.prefill.test.ts).
 */
import { prisma, type PrismaClient } from "@select-lub/core/db";
import type { DbClient } from "../../../../kernel/db.js";
import {
  describeWithDatabase,
  runInTransactionOnTx,
  seedConnection,
  seedConversation,
  seedUnit,
  withTestTransaction,
} from "@select-lub/core/testing";
import { expect, it } from "vitest";
import { createDb } from "../../../../kernel/db.js";
import { enqueueClosedWindows, PREFILL_WINDOW_MS, resolveCadastro } from "../index.js";

const PHONE = "5511999999999";
const t0 = new Date("2026-08-31T12:00:00.000Z");

const db = () => prisma as PrismaClient;

/** One thread message to insert, relative to {@link t0}. */
type SeedMessage = {
  externalMessageId: string;
  direction: "inbound" | "outbound";
  offsetMs: number;
  messageType?: string;
  textBody?: string;
};

/**
 * An inbound text message at an offset from {@link t0}.
 *
 * @param offsetMs - Milliseconds after t0.
 * @param externalMessageId - Provider id, unique within the thread.
 * @returns The message to seed.
 */
function inboundAt(offsetMs: number, externalMessageId = "in-1"): SeedMessage {
  return { externalMessageId, direction: "inbound", offsetMs, textBody: "oi" };
}

/**
 * An outbound text message at an offset from {@link t0}.
 *
 * @param offsetMs - Milliseconds after t0.
 * @returns The message to seed.
 */
function outboundAt(offsetMs: number): SeedMessage {
  return { externalMessageId: "out-1", direction: "outbound", offsetMs, textBody: "ok" };
}

/**
 * Seeds a unit, connection and conversation with its thread, and builds a
 * module handle over the same transaction.
 *
 * @param tx - The test transaction.
 * @param input - Switch state, optional watermark, and the thread's messages.
 * @returns The unit, conversation and the handle over `tx`.
 */
async function setup(
  tx: DbClient,
  input: {
    prefillExtractEnabled: boolean;
    lastPrefillWindowClosedAt?: Date | null;
    messages?: readonly SeedMessage[];
  },
) {
  const unit = await seedUnit(tx);
  const connection = await seedConnection(tx, { unitId: unit.id });
  const conversation = await seedConversation(tx, {
    connectionId: connection.id,
    chatKey: PHONE,
  });
  await tx.conversation.update({
    where: { id: conversation.id },
    data: {
      prefillExtractEnabled: input.prefillExtractEnabled,
      lastPrefillWindowClosedAt: input.lastPrefillWindowClosedAt ?? null,
    },
  });
  for (const message of input.messages ?? []) {
    await tx.message.create({
      data: {
        conversationId: conversation.id,
        externalMessageId: message.externalMessageId,
        direction: message.direction,
        messageType: message.messageType ?? "text",
        textBody: message.textBody ?? null,
        providerTimestamp: new Date(t0.getTime() + message.offsetMs),
      },
    });
  }
  const handle = createDb(tx, runInTransactionOnTx(tx));
  return { unit, conversation, handle };
}

/**
 * Seeds a customer with the thread's phone and a fully-filled titular vehicle.
 *
 * @param tx - The test transaction.
 * @param unitId - Unit the customer belongs to.
 */
async function seedFullCadastro(tx: DbClient, unitId: string) {
  const customer = await tx.customer.create({
    data: {
      unitId,
      name: "Ana Silva",
      taxId: "12345678901",
      origin: "CRM",
      status: "ACTIVE",
      phones: { create: { raw: PHONE, normalized: PHONE, isPrimary: true } },
    },
  });
  await tx.vehicle.create({
    data: {
      customerId: customer.id,
      plate: "ABC1D23",
      make: "VW",
      model: "Gol",
      version: "1.0",
      year: 2018,
      odometerKm: 40_000,
      origin: "CRM",
    },
  });
}

/**
 * This conversation's prefill jobs. A delta, never the whole table.
 *
 * @param tx - The test transaction.
 * @param conversationId - The conversation to scope to.
 * @returns The job rows for that conversation.
 */
function jobsOf(tx: DbClient, conversationId: string) {
  return tx.cadastroPrefillJob.findMany({ where: { conversationId } });
}

describeWithDatabase("enqueueClosedWindows", () => {
  it("inserts a queued job when silence has closed the window", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversation, handle } = await setup(tx, {
        prefillExtractEnabled: true,
        messages: [inboundAt(0)],
      });
      expect(await jobsOf(tx, conversation.id)).toHaveLength(0); // precondition

      await enqueueClosedWindows(handle, new Date(t0.getTime() + PREFILL_WINDOW_MS));

      const jobs = await jobsOf(tx, conversation.id);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ status: "queued", dirty: false });
    }));

  it("does not insert a second job when one is already in flight", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversation, handle } = await setup(tx, {
        prefillExtractEnabled: true,
        messages: [inboundAt(0)],
      });
      const existing = await tx.cadastroPrefillJob.create({ data: { conversationId: conversation.id, status: "queued" } });

      await enqueueClosedWindows(handle, new Date(t0.getTime() + PREFILL_WINDOW_MS));

      const jobs = await jobsOf(tx, conversation.id);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.id).toBe(existing.id);
      expect(jobs[0]?.dirty).toBe(false);
    }));

  it("still enqueues when every v1 field is already filled", () =>
    withTestTransaction(db(), async (tx) => {
      const { unit, conversation, handle } = await setup(tx, {
        prefillExtractEnabled: true,
        messages: [inboundAt(0)],
      });
      await seedFullCadastro(tx, unit.id);
      // Precondition: the adapter really resolves the full cadastro through the
      // unit-scoped phone join, so "full" is a property of the rows.
      const snapshot = await resolveCadastro(tx, conversation.id);
      expect(snapshot?.name).toBe("Ana Silva");
      expect(snapshot?.odometerKm).toBe(40_000);

      await enqueueClosedWindows(handle, new Date(t0.getTime() + PREFILL_WINDOW_MS));

      expect(await jobsOf(tx, conversation.id)).toHaveLength(1);
    }));

  it("does not enqueue while the silence window is still open", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversation, handle } = await setup(tx, {
        prefillExtractEnabled: true,
        messages: [inboundAt(0)],
      });

      await enqueueClosedWindows(handle, new Date(t0.getTime() + 10_000));

      expect(await jobsOf(tx, conversation.id)).toHaveLength(0);
    }));

  it("does not enqueue when an outbound closed the window early", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversation, handle } = await setup(tx, {
        prefillExtractEnabled: true,
        messages: [inboundAt(0), outboundAt(30_000)],
      });

      await enqueueClosedWindows(handle, new Date(t0.getTime() + 30_000 + PREFILL_WINDOW_MS));

      expect(await jobsOf(tx, conversation.id)).toHaveLength(0);
    }));

  it("does not enqueue when the watermark already covers the latest inbound", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversation, handle } = await setup(tx, {
        prefillExtractEnabled: true,
        lastPrefillWindowClosedAt: t0,
        messages: [inboundAt(0)],
      });

      await enqueueClosedWindows(handle, new Date(t0.getTime() + PREFILL_WINDOW_MS));

      expect(await jobsOf(tx, conversation.id)).toHaveLength(0);
    }));

  it("enqueues one job covering two inbounds 20s apart after 60s silence", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversation, handle } = await setup(tx, {
        prefillExtractEnabled: true,
        messages: [inboundAt(0, "a"), inboundAt(20_000, "b")],
      });

      await enqueueClosedWindows(handle, new Date(t0.getTime() + 20_000 + PREFILL_WINDOW_MS));

      expect(await jobsOf(tx, conversation.id)).toHaveLength(1);
    }));

  it("does not enqueue or label when the switch is off after 60s silence", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversation, handle } = await setup(tx, {
        prefillExtractEnabled: false,
        messages: [inboundAt(0)],
      });

      await enqueueClosedWindows(handle, new Date(t0.getTime() + PREFILL_WINDOW_MS));

      expect(await jobsOf(tx, conversation.id)).toHaveLength(0);
      // Read off the real column the drain writes, not a fake-only accessor.
      const messages = await tx.message.findMany({
        where: { conversationId: conversation.id },
        select: { shouldReply: true },
      });
      expect(messages).toHaveLength(1);
      expect(messages.every((row) => row.shouldReply === null)).toBe(true);
    }));

  it("does not backfill elapsed silence when the switch turns on without a new inbound", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversation, handle } = await setup(tx, {
        prefillExtractEnabled: false,
        messages: [inboundAt(0)],
      });

      await enqueueClosedWindows(handle, new Date(t0.getTime() + PREFILL_WINDOW_MS));
      expect(await jobsOf(tx, conversation.id)).toHaveLength(0);

      // Turning the switch on stamps the watermark at that instant, which is
      // what stops the elapsed silence from being extracted retroactively.
      const enabledAt = new Date(t0.getTime() + PREFILL_WINDOW_MS);
      await tx.conversation.update({
        where: { id: conversation.id },
        data: { prefillExtractEnabled: true, lastPrefillWindowClosedAt: enabledAt },
      });

      await enqueueClosedWindows(handle, enabledAt);

      expect(await jobsOf(tx, conversation.id)).toHaveLength(0);
    }));
});

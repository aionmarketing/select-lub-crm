/**
 * Test design (testing-strategy) — prefill / drain-prefill, the snapshot read and
 * the suggestion row
 *
 * Module role: `module_prefill`. `resolveCadastro` reads customers' and
 * conversations' tables under `readableBy`; `completeWindow` writes the
 * suggestion and the job under `module_prefill`, and closes the window through
 * `conversations`' contract.
 *
 * Moved from `apps/worker/src/prefill/store.test.ts`, its five database cases,
 * assertions unchanged (its two pure `selectPlateSourcedKeys` cases are in
 * `internal/cadastro-snapshot.test.ts`).
 *
 * CHANGED SETUP, SAME ASSERTIONS. The store's standalone `upsertSuggestion` is
 * gone: the drain writes the suggestion inside `completeWindow`, one
 * transaction with the job's status and the window's close. The two row-shape
 * cases therefore drive `completeWindow` — the only writer of that row now —
 * and assert the same row; the window close is a side effect they do not check.
 * `insertQueuedJob` / `markJob` / `getSuggestionFields` are direct row writes
 * and reads, or this slice's `markJob`.
 *
 * FAKE-ONLY ASSERTIONS SURFACED (carried over)
 *   1. `plateSourcedKeys` is derived from real `VehicleFieldSync` rows, with
 *      deliberately wrong rows (a PLACA `odometerKm`, a CRM `model`) that must be
 *      excluded.
 *   2. The suggestion's `fields` is opaque Json; the case parses it with the
 *      API's `.strict()` `prefillFieldsSchema`, so a `{ value, confidence }`
 *      wrapper fails at the writer (PR #87).
 *   3. A partial unique index forbids two in-flight jobs per conversation, so
 *      the first job reaches a terminal status before the second is inserted.
 *
 * Axes: A1 origin; A2 key; A3 cadastro linkage — linked / none / no conversation;
 *   A4 suggestion write — fresh insert / upsert over an existing row
 */
import { prisma, type PrismaClient } from "@select-lub/core/db";
import { prefillFieldsSchema, type PrefillFields } from "../../contracts/http.js";
import { expect, it } from "vitest";
import { createDb, type DbClient } from "../../../../kernel/db.js";
import {
  describeWithDatabase,
  runInTransactionOnTx,
  seedConnection,
  seedConversation,
  seedUnit,
  withTestTransaction,
} from "@select-lub/core/testing";
import { completeWindow, markJob, resolveCadastro } from "../index.js";

const PHONE = "5511988887777";

const db = () => prisma as PrismaClient;

/** A unit, connection and conversation. */
async function setup(tx: DbClient) {
  const unit = await seedUnit(tx);
  const connection = await seedConnection(tx, { unitId: unit.id });
  const conversation = await seedConversation(tx, { connectionId: connection.id, chatKey: PHONE });
  return { unit, conversation };
}

/** A customer in a unit, its phone, and a titular vehicle with `fieldSyncs`. */
async function seedCadastro(
  tx: DbClient,
  unitId: string,
  fieldSyncs: readonly { fieldKey: string; origin: string }[] = [],
) {
  const customer = await tx.customer.create({
    data: {
      unitId,
      name: "Ana",
      taxId: null,
      origin: "CRM",
      status: "ACTIVE",
      phones: { create: { raw: PHONE, normalized: PHONE, isPrimary: true } },
    },
  });
  const vehicle = await tx.vehicle.create({
    data: {
      customerId: customer.id,
      plate: "ABC1D23",
      make: "VW",
      model: "Polo",
      version: "MPI",
      year: 2021,
      odometerKm: 41_000,
      origin: "CRM",
    },
  });
  if (fieldSyncs.length > 0) {
    await tx.vehicleFieldSync.createMany({ data: fieldSyncs.map((row) => ({ vehicleId: vehicle.id, ...row })) });
  }
  return { customerId: customer.id, vehicleId: vehicle.id };
}

/** Writes a suggestion the way the drain does, in its own `db.tx("prefill")`. */
function writeSuggestion(tx: DbClient, conversationId: string, jobId: string, fields: PrefillFields) {
  return createDb(tx, runInTransactionOnTx(tx)).tx("prefill", (t) =>
    completeWindow(t, {
      conversationId,
      jobId,
      fields,
      inboundIds: [],
      shouldReply: false,
      watermark: new Date("2026-08-31T12:00:00.000Z"),
    }),
  );
}

describeWithDatabase("resolveCadastro", () => {
  it("derives plateSourcedKeys from the titular vehicle's VehicleFieldSync rows", () =>
    withTestTransaction(db(), async (tx) => {
      const { unit, conversation } = await setup(tx);
      // Deliberately wrong rows alongside the right ones: odometerKm is PLACA
      // but not an allowed key, model is an allowed key but not PLACA.
      await seedCadastro(tx, unit.id, [
        { fieldKey: "year", origin: "PLACA" },
        { fieldKey: "make", origin: "PLACA" },
        { fieldKey: "odometerKm", origin: "PLACA" },
        { fieldKey: "model", origin: "CRM" },
      ]);

      const snapshot = await resolveCadastro(tx, conversation.id);

      expect(snapshot?.plateSourcedKeys).toEqual(["make", "year"]);
      // The snapshot is read from the real rows, not echoed from the test.
      expect(snapshot?.name).toBe("Ana");
      expect(snapshot?.plate).toBe("ABC1D23");
      expect(snapshot?.year).toBe(2021);
      expect(snapshot?.phoneNormalized).toBe(PHONE);
    }));

  it("returns an empty plateSourcedKeys list when no customer is linked", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversation } = await setup(tx);

      const snapshot = await resolveCadastro(tx, conversation.id);

      expect(snapshot?.customerId).toBeNull();
      expect(snapshot?.plateSourcedKeys).toEqual([]);
      expect(snapshot?.phoneNormalized).toBe(PHONE);
    }));

  it("returns null for a conversation that does not exist", () =>
    withTestTransaction(db(), async (tx) => {
      await setup(tx);

      expect(await resolveCadastro(tx, "no-such-conversation")).toBeNull();
    }));
});

describeWithDatabase("the suggestion row the drain writes", () => {
  it("persists fields the API's strict schema accepts, as plain values", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversation } = await setup(tx);
      const job = await tx.cadastroPrefillJob.create({ data: { conversationId: conversation.id, status: "running" } });

      await writeSuggestion(tx, conversation.id, job.id, {
        name: "Ana Souza",
        taxId: "12345678909",
        plate: "ABC1D23",
        make: "VW",
        model: "Polo",
        version: "MPI",
        year: 2021,
        odometerKm: 41_000,
      });

      const row = await tx.cadastroPrefillSuggestion.findUniqueOrThrow({ where: { conversationId: conversation.id } });
      // The column is opaque Json, so the database would have accepted a
      // { value, confidence } wrapper. The API would not: this is the schema it
      // serves the column through, and it is .strict(). See note 2 in the header.
      const parsed = prefillFieldsSchema.safeParse(row.fields);
      expect(parsed.success).toBe(true);
      expect(parsed.success && parsed.data).toEqual({
        name: "Ana Souza",
        taxId: "12345678909",
        plate: "ABC1D23",
        make: "VW",
        model: "Polo",
        version: "MPI",
        year: 2021,
        odometerKm: 41_000,
      });
      expect(row.jobId).toBe(job.id);
    }));

  it("replaces the stored fields on a second extraction for the same conversation", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversation } = await setup(tx);
      const first = await tx.cadastroPrefillJob.create({ data: { conversationId: conversation.id, status: "running" } });
      await writeSuggestion(tx, conversation.id, first.id, { name: "Ana" });
      const stored = await tx.cadastroPrefillSuggestion.findUniqueOrThrow({ where: { conversationId: conversation.id } });
      expect(stored.fields).toEqual({ name: "Ana" }); // precondition

      // The first job must reach a terminal status before another is enqueued:
      // a partial unique index forbids two in-flight jobs on one conversation.
      // See note 3 in the header. (completeWindow marked it succeeded already;
      // the explicit mark is kept from the old case.)
      await createDb(tx, runInTransactionOnTx(tx)).tx("prefill", (t) => markJob(t, first.id, "succeeded"));
      const second = await tx.cadastroPrefillJob.create({ data: { conversationId: conversation.id, status: "running" } });
      await writeSuggestion(tx, conversation.id, second.id, { name: "Ana Souza", year: 2021 });

      const row = await tx.cadastroPrefillSuggestion.findUniqueOrThrow({ where: { conversationId: conversation.id } });
      expect(prefillFieldsSchema.safeParse(row.fields).success).toBe(true);
      expect(row.fields).toEqual({ name: "Ana Souza", year: 2021 });
      expect(row.jobId).toBe(second.id);
      // One row per conversation, not one per extraction.
      expect(await tx.cadastroPrefillSuggestion.count({ where: { conversationId: conversation.id } })).toBe(1);
    }));
});

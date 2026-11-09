/**
 * Test design (testing-strategy) — prefill / drain-prefill
 *
 * Module role: `module_prefill` for the job, the suggestion and every read;
 * `conversations`' `closePrefillWindow` writes the `should_reply` labels and the
 * watermark under `module_conversations`, joined to the drain's transaction.
 *
 * Moved from `apps/worker/src/prefill/extract.test.ts`, all 17 cases (the
 * `it.each` counts two), assertions unchanged — the 7 that drive `drainPrefill`
 * here, the 10 on `extractFor` in `drain-prefill.extract.integration.test.ts`
 * (split for the 300-line limit; shared setup in `drain-prefill.fixture.ts`).
 * This header is the design for both. Its `runExtract(store,
 * conversationId, snapshot, generate)` is `extractFor(db, conversationId,
 * snapshot, generate)` now — the same shape, reading the pending suggestion
 * and recent text in a short `db.tx` that closes before the LLM call — and the
 * drain calls it too, so these cases run the drain's own path. Setup that went
 * through the old store port (`insertQueuedJob`, `upsertSuggestion`,
 * `markDirty`, `isDirty`, `resolveCadastro`) writes or reads the rows directly,
 * or calls this slice's own export.
 *
 * Setup: a unit, connection and conversation (switch ON) and its thread, inside
 * one rolling-back transaction per test. `generate` is injected in every case:
 * OpenAI is never called.
 *
 * Oracle: design.md Axis 2 (extract outputs) + Axis 3 (10 recent texts)
 * + assistive-prefill never-write / omit street.
 *
 * FAKE-ONLY ASSERTIONS SURFACED (carried over from the old file)
 *   1. Every read is of the real column, scoped to the conversation the test made.
 *   2. Axis 3 exercises the real `ORDER BY … DESC LIMIT 10`; the blank row is
 *      whitespace, not null, because `text_body IS NOT NULL` runs in SQL and the
 *      trim check after it.
 *   3. The pending-suggestion case creates a real job first:
 *      `cadastro_prefill_suggestion.job_id` is a foreign key.
 *   4. D2 (`!snapshot` → skip) is NOT REACHABLE on the real schema: a job cannot
 *      outlive its conversation, and `resolveCadastro` returns null fields, not
 *      null, for a conversation with no customer. Recorded, still uncovered.
 *   A partial unique index allows one in-flight job per conversation, which
 *   makes the "no second job after success" case stronger than the fake's.
 *
 * Axes
 *   Axis 2 — leaked street dropped; stored plate dropped; throw → failed; dirty
 *   after success → no requeue
 *   Axis 3 BVA n=9 / 10 / 11 text messages — 11 keeps only the 10 newest
 *
 * Decision map (drain-prefill + internal/extract)
 *   D1 claim empty               T: empty-claim it; F: skip/fail/success its
 *   D1b claim lost (CAS)         T: lost-claim it (the job left `queued` between
 *                                the read and the update); F: every claim it
 *   D2 !snapshot                 NOT REACHABLE, see note 4
 *   D3 window not closed         T: skip open-window; F: extract its
 *   D4 generate throw            T: failed it; F: success its
 *   D5 pickV1 street             T: dropped; F: plate kept
 *   D6 postFilter stored plate   T: dropped; F: new plate kept
 *   D8 listRecent limit 10       T: 11-message it; F: 9 and 10 its
 *   D9 listRecent trim !== ""    T: real msgs; F: blank-body it
 *   D10 defaultGenerate !key     T: unconfigured it; F: live OpenAI (out of scope)
 *
 * Out of scope: live OpenAI with a key set — CI must not call it.
 */
import { prisma, type DbClient, type PrismaClient } from "@select-lub/core/db";
import { expect, it } from "vitest";
import { describeWithDatabase, withTestTransaction } from "@select-lub/core/testing";
import { claimQueued, drainPrefill, PREFILL_WINDOW_MS, resolveCadastro } from "../index.js";
import {
  closedInbound,
  closedNow,
  PHONE,
  insertQueuedJob,
  jobsOf,
  labelOf,
  setup,
  suggestionOf,
  watermarkOf,
  windowStart,
} from "./drain-prefill.fixture.js";

const db = () => prisma as PrismaClient;

describeWithDatabase("drainPrefill", () => {
  it("returns null and changes nothing when the job left queued before the claim's update", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversation } = await setup(tx, [closedInbound()]);
      const job = await insertQueuedJob(tx, conversation.id);
      // The race, made deterministic: a concurrent drain claims and finishes the
      // job between claimQueued's read and its compare-and-set update.
      const racing = new Proxy(tx, {
        get(target, prop) {
          if (prop !== "cadastroPrefillJob") {
            return Reflect.get(target, prop);
          }
          const jobs = target.cadastroPrefillJob;
          return new Proxy(jobs, {
            get(delegate, method) {
              if (method !== "findFirst") {
                return Reflect.get(delegate, method);
              }
              return async (args: Parameters<typeof jobs.findFirst>[0]) => {
                const row = await delegate.findFirst(args);
                await delegate.update({ where: { id: job.id }, data: { status: "succeeded" } });
                return row;
              };
            },
          });
        },
      }) as DbClient;

      expect(await claimQueued(racing)).toBeNull();

      const jobs = await jobsOf(tx, conversation.id);
      expect(jobs).toHaveLength(1);
      // The winner's outcome stands: the loser did not flip it back to running.
      expect(jobs[0]?.status).toBe("succeeded");
    }));

  it("returns without calling generate when the claim is empty", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversation, handle } = await setup(tx);
      expect(await claimQueued(tx)).toBeNull(); // precondition: nothing queued
      let generateCalls = 0;

      await drainPrefill(
        handle,
        async () => {
          generateCalls += 1;
          return { shouldReply: false };
        },
        closedNow,
      );

      expect(generateCalls).toBe(0);
      expect(await jobsOf(tx, conversation.id)).toHaveLength(0);
    }));

  it("marks skipped when the window is no longer closed at drain time", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversation, handle } = await setup(tx, [closedInbound()]);
      const job = await insertQueuedJob(tx, conversation.id);
      let generateCalls = 0;

      // Drained at the window start: the 60s silence has not elapsed.
      await drainPrefill(
        handle,
        async () => {
          generateCalls += 1;
          throw new Error("must not run");
        },
        windowStart,
      );

      expect(generateCalls).toBe(0);
      const jobs = await jobsOf(tx, conversation.id);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.id).toBe(job.id);
      expect(jobs[0]?.status).toBe("skipped");
      expect(await watermarkOf(tx, conversation.id)).toBeNull();
    }));

  it("still extracts when every v1 field is already filled", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversation, handle } = await setup(tx, [closedInbound()]);
      await insertQueuedJob(tx, conversation.id);
      let generateCalls = 0;

      await drainPrefill(
        handle,
        async () => {
          generateCalls += 1;
          return { shouldReply: true };
        },
        closedNow,
      );

      expect(generateCalls).toBe(1);
      expect((await jobsOf(tx, conversation.id))[0]?.status).toBe("succeeded");
      expect(await labelOf(tx, conversation.id, "in-1")).toBe(true);
    }));

  it("marks the job failed, stamps the watermark, and does not upsert when generate throws", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversation, handle } = await setup(tx, [closedInbound()]);
      await insertQueuedJob(tx, conversation.id);

      await drainPrefill(
        handle,
        async () => {
          throw new Error("openai down");
        },
        closedNow,
      );

      const jobs = await jobsOf(tx, conversation.id);
      expect(jobs[0]?.status).toBe("failed");
      expect(jobs[0]?.lastError).toBe("openai_error");
      expect(await suggestionOf(tx, conversation.id)).toBeUndefined();
      // Stamped anyway, so the same window is not retried every poll.
      expect(await watermarkOf(tx, conversation.id)).toEqual(windowStart);
    }));

  it("labels only the window inbound ids and does not insert an outbox row", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversation, handle } = await setup(tx, [
        {
          externalMessageId: "old",
          direction: "inbound",
          textBody: "oi",
          providerTimestamp: new Date(windowStart.getTime() - 120_000),
        },
        {
          externalMessageId: "out",
          direction: "outbound",
          textBody: "ok",
          providerTimestamp: new Date(windowStart.getTime() - 60_000),
        },
        closedInbound("in-1"),
        closedInbound("in-2", "quanto custa?"),
      ]);
      await insertQueuedJob(tx, conversation.id);

      await drainPrefill(
        handle,
        async () => ({ plate: "ABC1D23", shouldReply: true }),
        new Date(windowStart.getTime() + PREFILL_WINDOW_MS),
      );

      // The inbound before the outbound is outside the window and stays unlabelled.
      expect(await labelOf(tx, conversation.id, "old")).toBeNull();
      expect(await labelOf(tx, conversation.id, "in-1")).toBe(true);
      expect(await labelOf(tx, conversation.id, "in-2")).toBe(true);
      expect(await suggestionOf(tx, conversation.id)).toEqual({ plate: "ABC1D23" });
      expect(await tx.outboxMessage.count({ where: { conversationId: conversation.id } })).toBe(0);
      const jobs = await jobsOf(tx, conversation.id);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.status).toBe("succeeded");
    }));

  it("does not insert a second job after success even when dirty is true", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversation, handle } = await setup(tx, [closedInbound()]);
      const job = await insertQueuedJob(tx, conversation.id);
      await tx.cadastroPrefillJob.update({ where: { id: job.id }, data: { dirty: true } });
      const marked = await tx.cadastroPrefillJob.findUniqueOrThrow({ where: { id: job.id } });
      expect(marked.dirty).toBe(true); // precondition

      await drainPrefill(handle, async () => ({ plate: "ABC1D23", shouldReply: false }), closedNow);

      const jobs = await jobsOf(tx, conversation.id);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.status).toBe("succeeded");
      expect(await suggestionOf(tx, conversation.id)).toEqual({ plate: "ABC1D23" });
    }));

  it("drops a plate-sourced make from the drained suggestion and keeps unmarked odometerKm", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversation, handle } = await setup(tx, [closedInbound()]);
      // The marked key must come from real VehicleFieldSync rows, because the
      // drain resolves the snapshot itself rather than being handed one.
      const unit = await tx.whatsAppConnection
        .findFirstOrThrow({
          where: { conversations: { some: { id: conversation.id } } },
          select: { unitId: true },
        })
        .then((row) => row.unitId);
      const customer = await tx.customer.create({
        data: {
          unitId: unit,
          name: "Ana",
          origin: "CRM",
          status: "ACTIVE",
          phones: { create: { raw: PHONE, normalized: PHONE, isPrimary: true } },
        },
      });
      const vehicle = await tx.vehicle.create({ data: { customerId: customer.id, make: "VW", origin: "CRM" } });
      await tx.vehicleFieldSync.create({ data: { vehicleId: vehicle.id, fieldKey: "make", origin: "PLACA" } });
      expect((await resolveCadastro(tx, conversation.id))?.plateSourcedKeys).toEqual(["make"]); // precondition
      await insertQueuedJob(tx, conversation.id);

      await drainPrefill(handle, async () => ({ make: "FIAT", odometerKm: 12_000, shouldReply: false }), closedNow);

      expect(await suggestionOf(tx, conversation.id)).toEqual({ odometerKm: 12_000 });
      expect((await jobsOf(tx, conversation.id))[0]?.status).toBe("succeeded");
    }));
});

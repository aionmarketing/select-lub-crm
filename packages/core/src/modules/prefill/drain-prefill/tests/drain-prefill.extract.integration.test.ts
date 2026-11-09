/**
 * Test design (testing-strategy) — prefill / drain-prefill, the extraction step
 * (`extractFor`: read the context in a short `db.tx`, then call the LLM outside it)
 *
 * Moved from `apps/worker/src/prefill/extract.test.ts`: 10 of its 17 cases (the
 * `it.each` counts two, so 11 runs), assertions unchanged. The other 7 drive
 * `drainPrefill` and are in `drain-prefill.integration.test.ts`, whose header
 * carries the file's full design (axes, decision map, fake-only notes); the
 * setup both share is `drain-prefill.fixture.ts`.
 *
 * `generate` is injected in every case: OpenAI is never called.
 *
 * Oracle: design.md Axis 2 (extract outputs) + Axis 3 (10 recent texts)
 * + assistive-prefill never-write / omit street.
 *
 * Decision map (the rows of the full map these cases cover)
 *   D5 pickV1 street             T: dropped; F: plate kept
 *   D6 postFilter stored plate   T: dropped; F: new plate kept
 *   D8 listRecent limit 10       T: 11-message it; F: 9 and 10 its
 *   D9 listRecent trim !== ""    T: real msgs; F: blank-body it
 *   D10 defaultGenerate !key     T: unconfigured it; F: live OpenAI (out of scope)
 */
import { prisma, type PrismaClient } from "@select-lub/core/db";
import { expect, it } from "vitest";
import { describeWithDatabase, withTestTransaction } from "@select-lub/core/testing";
import {
  defaultGeneratePrefillFields,
  extractFor,
  PREFILL_RECENT_TEXT_LIMIT,
  PREFILL_SYSTEM_PROMPT,
} from "../index.js";
import { insertQueuedJob, line, setup, snapshot } from "./drain-prefill.fixture.js";

const db = () => prisma as PrismaClient;

describeWithDatabase("extractFor", () => {
  it("drops a street key leaked by the model", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversation, handle } = await setup(tx);

      const { fields } = await extractFor(handle, conversation.id, snapshot(), async () => ({
        plate: "ABC1D23",
        street: "Rua das Oficinas",
        shouldReply: false,
      }));

      expect(fields).toEqual({ plate: "ABC1D23" });
      expect("street" in fields).toBe(false);
    }));

  it("lists plate-sourced keys as authoritative and still drops a marked make the model emitted", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversation, handle } = await setup(tx);
      const stored = snapshot({ make: "VW", name: "Ana" });

      const { prompt, fields } = await extractFor(
        handle,
        conversation.id,
        { ...stored, plateSourcedKeys: ["make"] },
        async () => ({ make: "FIAT", odometerKm: 12_000, shouldReply: false }),
      );

      expect(prompt).toContain("campos_autoritativos_da_placa");
      expect(prompt).toContain('"make"');
      expect(PREFILL_SYSTEM_PROMPT).toContain("campos_autoritativos_da_placa");
      expect(fields.make).toBeUndefined();
      expect(fields.odometerKm).toBe(12_000);
    }));

  it("drops a plate that is already stored on the titular vehicle", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversation, handle } = await setup(tx);
      const stored = snapshot({ plate: "ABC1D23", name: "Ana" });

      const { fields } = await extractFor(handle, conversation.id, stored, async () => ({
        plate: "ABC1D23",
        make: "VW",
        shouldReply: false,
      }));

      expect(fields).toEqual({ make: "VW" });
    }));

  it("puts only the 10 newest text messages in the prompt when 11 exist", () =>
    withTestTransaction(db(), async (tx) => {
      const messages = Array.from({ length: 11 }, (_, index) =>
        line(index, `2026-08-01T00:00:${String(index).padStart(2, "0")}.000Z`),
      );
      const { conversation, handle } = await setup(tx, messages);

      const { prompt } = await extractFor(handle, conversation.id, snapshot(), async (text) => {
        expect(text).not.toContain("msg-0\n");
        expect(text).toContain("msg-1");
        expect(text).toContain("msg-10");
        return { plate: "XYZ9A87", shouldReply: false };
      });

      // The LIMIT is in SQL: the read orders DESC, takes 10, then reverses.
      const promptLines = prompt.split("\n").filter((row) => /^(inbound|outbound): msg-/.test(row));
      expect(promptLines).toHaveLength(PREFILL_RECENT_TEXT_LIMIT);
      expect(promptLines).not.toContain("inbound: msg-0");
      expect(promptLines).toContain("outbound: msg-1");
      expect(promptLines).toContain("inbound: msg-10");
    }));

  it.each([
    { n: 9 }, // Axis 3 BVA edge−1
    { n: 10 }, // Axis 3 BVA edge
  ])("includes every text when there are $n messages (limit 10)", ({ n }) =>
    withTestTransaction(db(), async (tx) => {
      const messages = Array.from({ length: n }, (_, index) =>
        line(index, `2026-08-01T00:00:${String(index).padStart(2, "0")}.000Z`),
      );
      const { conversation, handle } = await setup(tx, messages);

      const { prompt } = await extractFor(handle, conversation.id, snapshot(), async () => ({
        plate: "XYZ9A87",
        shouldReply: false,
      }));

      const promptLines = prompt.split("\n").filter((row) => /^(inbound|outbound): msg-/.test(row));
      expect(promptLines).toHaveLength(n);
      expect(promptLines).toContain("inbound: msg-0");
      expect(promptLines.some((row) => row.endsWith(`msg-${n - 1}`))).toBe(true);
    }));

  it("omits a blank textBody from the prompt", () =>
    withTestTransaction(db(), async (tx) => {
      // Whitespace, not null: `text_body IS NOT NULL` runs in SQL, and the trim
      // check runs after it. See note 2 in the header.
      const { conversation, handle } = await setup(tx, [
        {
          externalMessageId: "blank",
          direction: "inbound",
          textBody: "   ",
          providerTimestamp: new Date("2026-08-01T00:00:00.000Z"),
        },
        line(1, "2026-08-01T00:00:01.000Z"),
      ]);

      const { prompt } = await extractFor(handle, conversation.id, snapshot(), async () => ({
        plate: "XYZ9A87",
        shouldReply: false,
      }));

      expect(prompt).toContain("msg-1");
      expect(prompt.split("\n").filter((row) => /^(inbound|outbound): /.test(row))).toEqual([
        "outbound: msg-1",
      ]);
    }));

  it("throws openai_unconfigured when OPENAI_API_KEY is unset", async () => {
    const previous = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    try {
      await expect(defaultGeneratePrefillFields("prompt")).rejects.toThrow("openai_unconfigured");
    } finally {
      if (previous !== undefined) {
        process.env.OPENAI_API_KEY = previous;
      }
    }
  });

  it("includes the current pending suggestion JSON in the prompt", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversation, handle } = await setup(tx);
      // A real job: cadastro_prefill_suggestion.job_id is a foreign key.
      const job = await insertQueuedJob(tx, conversation.id);
      await tx.cadastroPrefillSuggestion.create({
        data: { conversationId: conversation.id, jobId: job.id, fields: { plate: "PENDENT1" }, extractedAt: new Date() },
      });

      const { prompt } = await extractFor(handle, conversation.id, snapshot(), async (text) => {
        expect(text).toContain("PENDENT1");
        return { shouldReply: false };
      });

      expect(prompt).toContain("sugestao_pendente");
      expect(prompt).toContain("PENDENT1");
    }));

  it("keeps a name correction that differs from the stored value", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversation, handle } = await setup(tx);
      const stored = snapshot({ name: "Ana Silva" });

      const { fields } = await extractFor(handle, conversation.id, stored, async () => ({
        name: "Bruno Lima",
        shouldReply: true,
      }));

      expect(fields).toEqual({ name: "Bruno Lima" });
    }));

  it("throws shouldReply_invalid when the model omits shouldReply", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversation, handle } = await setup(tx);

      await expect(
        extractFor(handle, conversation.id, snapshot(), async () => ({ plate: "ABC1D23" })),
      ).rejects.toThrow("shouldReply_invalid");
    }));
});

/**
 * Test design (testing-strategy)
 *
 * SUT: the prefill retry end to end — `drainPrefill` failing a window,
 *   `retryPrefill` (the "Tentar de novo" route's write), and `drainPrefill`
 *   running the retry job — on the real database inside one rolling-back
 *   transaction per case, with a fake `generate` that records its prompt.
 *
 * Why here: it spans two slices (drain-prefill, retry-prefill), and a slice's
 *   tests may not import another slice; `test/` is outside the boundary rules.
 *
 * Oracle: assistive-prefill "Retry after failed extract", as delta 4 of
 *   apply-owner-rulings-2026-09-25 tightens it — the extraction runs again on
 *   the conversation's current messages (the same input when nothing new
 *   arrived), on success the suggestion is shown, and it is not skipped because
 *   the attendant replied or new messages arrived.
 *
 * A RETRY IS "EXTRACT NOW" (review of #168). It bypasses the window derivation;
 *   the window only decides when an extraction triggers on its own. It closes
 *   with the failed window's time through the forward-only CAS, and is skipped
 *   only once a newer window was extracted successfully.
 *
 * THE SAME INPUT. The prompt is built from the recent text messages with no
 *   window filter, so over an unchanged thread the retry's prompt equals the
 *   failed attempt's. The first case records both and asserts they are equal,
 *   and that their message lines are the thread's, in order.
 *
 * Cases
 *   1. fail, retry: identical prompts, suggestion shown.
 *   2. a failed job with no stamped window (pre-migration) retries through
 *      the watermark.
 *   3. the attendant replied after the failure: the retry still extracts, on
 *      the current messages, and the suggestion is shown. Mutation-checked by
 *      restoring the window derivation for a retry.
 *   4. a new inbound opened a window: the retry still extracts.
 *   5. a newer window closed but failed: the retry still runs.
 *   6. a newer window succeeded: the retry is moot and skipped.
 *   7. a retry when the latest job did not fail queues an ordinary job.
 */
import { prisma, type DbClient, type PrismaClient } from "@select-lub/core/db";
import { expect, it } from "vitest";
import { drainPrefill } from "../src/modules/prefill/drain-prefill/index.js";
import {
  jobsOf,
  setup,
  watermarkOf,
  type SeedMessage,
} from "../src/modules/prefill/drain-prefill/tests/drain-prefill.fixture.js";
import { PREFILL_WINDOW_MS } from "../src/modules/prefill/drain-prefill/index.js";
import { retryPrefill } from "../src/modules/prefill/retry-prefill/index.js";
import { getView } from "../src/modules/prefill/internal/suggestion.js";
import { describeWithDatabase, withTestTransaction } from "../src/testing/index.js";

const db = () => prisma as PrismaClient;

const t0 = new Date("2026-09-20T12:00:00.000Z");
const at = (seconds: number) => new Date(t0.getTime() + seconds * 1000);
/** out-1, then two inbound texts: the window is in-1 and in-2, latest at +20 s. */
const THREAD: SeedMessage[] = [
  { externalMessageId: "out-1", direction: "outbound", textBody: "out-1", providerTimestamp: at(0) },
  { externalMessageId: "in-1", direction: "inbound", textBody: "in-1", providerTimestamp: at(10) },
  { externalMessageId: "in-2", direction: "inbound", textBody: "in-2", providerTimestamp: at(20) },
];
const LATEST = at(20);
const CLOSED = new Date(LATEST.getTime() + PREFILL_WINDOW_MS + 1_000);

/** A generate that fails or answers, and records every prompt it is given. */
function recorder(fail: boolean, answer: Record<string, unknown> = { shouldReply: true }) {
  const prompts: string[] = [];
  const generate = async (prompt: string) => {
    prompts.push(prompt);
    if (fail) throw new Error("openai down");
    return answer;
  };
  return { prompts, generate };
}

/** The thread lines a prompt carries, in order. */
function threadLines(prompt: string) {
  return prompt.split("\n").filter((line) => /^(inbound|outbound): (in|out)-\d$/.test(line.trim()));
}

/** The retry route's write, under prefill's role as the route runs it. */
function retry(handle: Awaited<ReturnType<typeof setup>>["handle"], conversationId: string) {
  return handle.tx("prefill", (inner) => retryPrefill(inner, conversationId));
}

/** A failed extraction of THREAD's window, as the drain leaves it. */
async function failedOnce(tx: DbClient) {
  const { conversation, handle } = await setup(tx, THREAD);
  await tx.cadastroPrefillJob.create({ data: { conversationId: conversation.id, status: "queued" } });
  await drainPrefill(handle, recorder(true).generate, CLOSED);
  return { conversation, handle };
}

/** One more thread message, arriving after the failure. */
async function addMessage(tx: DbClient, conversationId: string, message: SeedMessage) {
  await tx.message.create({
    data: {
      conversationId,
      externalMessageId: message.externalMessageId,
      direction: message.direction,
      messageType: "text",
      textBody: message.textBody ?? null,
      providerTimestamp: message.providerTimestamp,
    },
  });
}

describeWithDatabase("prefill retry", () => {
  it("runs the failed window again with the same LLM input", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversation, handle } = await setup(tx, THREAD);
      await tx.cadastroPrefillJob.create({ data: { conversationId: conversation.id, status: "queued" } });
      const failing = recorder(true);
      await drainPrefill(handle, failing.generate, CLOSED);
      const [failed] = await jobsOf(tx, conversation.id);
      expect(failed?.status).toBe("failed"); // precondition
      expect(failed?.windowLatestInboundAt).toEqual(LATEST);
      expect(await watermarkOf(tx, conversation.id)).toEqual(LATEST); // the failure closed it

      await retry(handle, conversation.id);
      const succeeding = recorder(false, { shouldReply: true, model: "Corolla" });
      await drainPrefill(handle, succeeding.generate, CLOSED);

      const jobs = await jobsOf(tx, conversation.id);
      expect(jobs.map((job) => job.status)).toEqual(["failed", "succeeded"]);
      // On success the suggestion is shown: the view the rail reads is pending
      // with the extracted field, not the empty that hid the error before.
      const view = await handle.tx("prefill", (inner) => getView(inner, conversation.id));
      expect(view).toMatchObject({ status: "pending", fields: { model: "Corolla" } });
      expect(jobs[1]?.windowLatestInboundAt).toEqual(LATEST);
      expect(failing.prompts).toHaveLength(1);
      expect(succeeding.prompts).toHaveLength(1);
      // The same input: the whole prompt, and the thread's lines in order.
      expect(succeeding.prompts[0]).toBe(failing.prompts[0]);
      expect(threadLines(succeeding.prompts[0]!)).toEqual(["outbound: out-1", "inbound: in-1", "inbound: in-2"]);
      // The watermark never moved back.
      expect(await watermarkOf(tx, conversation.id)).toEqual(LATEST);
    }));

  it("retries a failure recorded before the window column through the conversation's watermark", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversation, handle } = await setup(tx, THREAD);
      await tx.cadastroPrefillJob.create({ data: { conversationId: conversation.id, status: "queued" } });
      await drainPrefill(handle, recorder(true).generate, CLOSED);
      const [failed] = await jobsOf(tx, conversation.id);
      // As a job failed before the migration: no window on it.
      await tx.cadastroPrefillJob.update({ where: { id: failed!.id }, data: { windowLatestInboundAt: null } });

      await retry(handle, conversation.id);
      const queued = (await jobsOf(tx, conversation.id))[1];
      expect(queued?.windowLatestInboundAt).toEqual(LATEST);
      const succeeding = recorder(false);
      await drainPrefill(handle, succeeding.generate, CLOSED);

      expect(succeeding.prompts).toHaveLength(1);
      expect((await jobsOf(tx, conversation.id)).map((job) => job.status)).toEqual(["failed", "succeeded"]);
    }));

  it("extracts on retry although the attendant replied after the failure", () =>
    withTestTransaction(db(), async (tx) => {
      // The commonest real case (review of #168): the attendant answers, then
      // presses "Tentar de novo". An outbound newer than the latest inbound
      // closes the window early, so a retry that derived the window skipped.
      // Mutation-checked: restoring the window derivation for a retry fails it.
      const { conversation, handle } = await failedOnce(tx);
      await addMessage(tx, conversation.id, {
        externalMessageId: "out-2",
        direction: "outbound",
        textBody: "out-2",
        providerTimestamp: at(200),
      });

      await retry(handle, conversation.id);
      const succeeding = recorder(false, { shouldReply: true, model: "Corolla" });
      await drainPrefill(handle, succeeding.generate, at(210));

      expect(succeeding.prompts).toHaveLength(1);
      // The current messages, the reply included.
      expect(threadLines(succeeding.prompts[0]!)).toEqual([
        "outbound: out-1",
        "inbound: in-1",
        "inbound: in-2",
        "outbound: out-2",
      ]);
      expect((await jobsOf(tx, conversation.id)).map((job) => job.status)).toEqual(["failed", "succeeded"]);
      const view = await handle.tx("prefill", (inner) => getView(inner, conversation.id));
      expect(view).toMatchObject({ status: "pending", fields: { model: "Corolla" } });
      // Closed with the failed window's time: never moved back, never past it.
      expect(await watermarkOf(tx, conversation.id)).toEqual(LATEST);
    }));

  it("extracts on retry although a new inbound has opened a window", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversation, handle } = await failedOnce(tx);
      await addMessage(tx, conversation.id, {
        externalMessageId: "in-3",
        direction: "inbound",
        textBody: "in-3",
        providerTimestamp: at(200),
      });

      await retry(handle, conversation.id);
      const succeeding = recorder(false);
      // 10 s after in-3: its own window is still open.
      await drainPrefill(handle, succeeding.generate, at(210));

      expect(succeeding.prompts).toHaveLength(1);
      expect((await jobsOf(tx, conversation.id)).map((job) => job.status)).toEqual(["failed", "succeeded"]);
    }));

  it("still runs a retry when a newer window closed but did not succeed", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversation, handle } = await setup(tx, THREAD);
      await tx.conversation.update({ where: { id: conversation.id }, data: { lastPrefillWindowClosedAt: at(300) } });
      await tx.cadastroPrefillJob.create({
        data: { conversationId: conversation.id, status: "failed", windowLatestInboundAt: at(300) },
      });
      await tx.cadastroPrefillJob.create({
        data: { conversationId: conversation.id, status: "queued", windowLatestInboundAt: LATEST },
      });
      const succeeding = recorder(false);

      await drainPrefill(handle, succeeding.generate, at(400));

      expect(succeeding.prompts).toHaveLength(1);
      // The forward-only close leaves the newer watermark where it was.
      expect(await watermarkOf(tx, conversation.id)).toEqual(at(300));
    }));

  it("skips a retry once a newer window has been extracted successfully", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversation, handle } = await setup(tx, THREAD);
      await tx.conversation.update({ where: { id: conversation.id }, data: { lastPrefillWindowClosedAt: at(300) } });
      await tx.cadastroPrefillJob.create({
        data: { conversationId: conversation.id, status: "succeeded", windowLatestInboundAt: at(300) },
      });
      await tx.cadastroPrefillJob.create({
        data: { conversationId: conversation.id, status: "queued", windowLatestInboundAt: LATEST },
      });
      const succeeding = recorder(false);

      await drainPrefill(handle, succeeding.generate, at(400));

      expect(succeeding.prompts).toHaveLength(0);
      expect((await jobsOf(tx, conversation.id)).map((job) => job.status)).toEqual(["succeeded", "skipped"]);
      expect(await watermarkOf(tx, conversation.id)).toEqual(at(300));
    }));

  it("queues an ordinary job when the latest job did not fail", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversation, handle } = await setup(tx, THREAD);
      await tx.cadastroPrefillJob.create({ data: { conversationId: conversation.id, status: "queued" } });
      await drainPrefill(handle, recorder(false).generate, CLOSED);

      await retry(handle, conversation.id);

      const jobs = await jobsOf(tx, conversation.id);
      expect(jobs.map((job) => job.status)).toEqual(["succeeded", "queued"]);
      expect(jobs[1]?.windowLatestInboundAt).toBeNull();
    }));
});

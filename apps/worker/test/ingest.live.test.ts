/**
 * Test design (testing-strategy)
 *
 * Setup: persistRawEvent + canonicalizeEvent against live Prisma when
 * DATABASE_URL is set. describe.skipIf(!live). Unique ids per run.
 *
 * Spec rule (conversation-phone-unique delta whatsapp-channel; main
 *   openspec/specs/channel/whatsapp-channel/spec.md still names uniqueness as
 *   (whatsapp_connection_id, external_message_id) until archive):
 *   Insert is idempotent on (conversation_id, external_message_id).
 *   Overlapping ingest. Hook after committed insert.
 *
 * Partitions (one numbered group = delivery patterns the spec treats the same):
 *
 *   P1 VALID   — same upsert posted 3 times → 1 conversation, 1 message,
 *                3 webhook_event rows
 *   P2 VALID   — two overlapping canonicalizes of one provider id →
 *                still 1 message, hook count ≤ 1
 *   P3 VALID   — DATABASE_URL missing: skipIf (not a failure)
 *   P4 VALID   — the ingest store's getEvent (createIngestStore): missing id → null;
 *                persisted id → row (not a replay of memory canonicalize)
 *
 * Output partitions:
 *   O1 — 1 conversation + 1 message (P1/P2)
 *   O2 — skip (P3)
 *   O3 — getEvent null vs found (P4)
 *
 * Limits: none. Replay count 3 means "more than once". 2 replays would
 * be the same duplicate-delivery group.
 *
 * Decisions (prisma.ts getEvent): D1 !row — missing vs found.
 *
 * Map from each `it` to a partition:
 *
 *   replays the same upsert three times as one conversation and one message
 *     — P1
 *   keeps a single message when two Prisma ingests of the same id run concurrently
 *     — P2
 *   returns null for a missing event id and the row after persist — P4
 *
 * Fails if: 3 conversation rows after 3 replays; hook running twice for
 * one provider id; getEvent(missing) is not null.
 *
 * Gate is DATABASE_URL (this file's live flag), not DATABASE_URL_TEST.
 * Not in this file: downloading media bytes; scanning a pairing QR;
 * replaying memory-store canonicalize cases on Prisma.
 * Coverage (conversation-chat-key-test-backfill 2.2): ingest/prisma.ts
 *   persist path here covers insertWebhookEvent / findConnectionByInstanceName /
 *   runConversationMessageTransaction / markEvent / getEvent.
 *   listConnections / updateConnectionState / listRetryableEvents /
 *   incrementAttemptCount belong to webhook-ingest-pipeline retry and
 *   reconcile-connection-state. `if (!conversation)` after upsert is
 *   infeasible (the unique lookup follows the INSERT). Outbound first/last
 *   ternary unsampled (this file posts inbound). CONNECTION_STATE_UPDATE_FIELD
 *   unused here.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { upsertPayload } from "@select-lub/core/testing";
import { kernel } from "@select-lub/core";
import { buildWorkerApp } from "../src/worker.js";
import { shouldRunLiveTests } from "@select-lub/core/db";
import { withConnectRetry } from "@select-lub/core/testing";
import {
  canonicalizeEvent,
  createIngestStore,
  type IngestStore as Persistence,
  persistRawEvent,
} from "@select-lub/core/modules/conversations";
import { messageReceived } from "@select-lub/core/modules/conversations/contracts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const envPath = resolve(repoRoot, ".env");
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

const live = shouldRunLiveTests();
const secret = "live-ingest-secret";
const instanceName = process.env.EVOLUTION_INSTANCE_NAME ?? "select-lub-poc";

describe.skipIf(!live)("live CRM Postgres ingest", () => {
  const runId = randomUUID();
  const replayId = `test-${runId}-replay`;
  const concurrentId = `test-${runId}-concurrent`;
  const digits = runId.replace(/\D/g, "").slice(0, 8).padEnd(8, "0");
  const remoteJid = `5511${digits}@s.whatsapp.net`;
  const externalIds = [replayId, concurrentId];
  const convergeJids: string[] = [];
  let prisma!: NonNullable<(typeof import("@select-lub/core/db"))["prisma"]>;
  let app!: Awaited<ReturnType<typeof buildWorkerApp>>;
  let hooks = 0;
  let offHooks: () => void = () => undefined;

  // WHY THIS COUNTER EXISTS. The webhook route answers BEFORE it finishes:
  // channel's `receive-webhook` stores the raw row, then
  // `await reply.code(200).send(...)`, and only then publishes the event whose
  // subscriber runs `canonicalizeEvent(...)`. So `app.inject()` resolves with the
  // canonicalization still in flight, and anything asserted straight after a
  // post is reading a table the work has not reached yet. The comment on the
  // convergence cases below records the same discovery; those cases avoided it
  // by driving the store directly, which left the one case that still posts —
  // the replay case — carrying the race. It failed on CI on 2026-09-18, on a
  // docs-only pull request (#122, run 35416015469), with
  // `message.count` reading 0 where 1 was expected.
  //
  // `markEvent` is the completion signal, not a sleep and not a poll:
  // `canonicalizeEvent` calls it exactly once on every terminal path it has
  // (processed, skipped, failed, failed_permanent), and a freshly persisted
  // event is always `received`, so its early return for a terminal status
  // cannot skip it. Counting `markEvent` therefore counts finished
  // canonicalizations exactly.
  //
  // Only posts through `app` are counted: every other case in this file builds
  // its own `createIngestStore(kernel.createDb(prisma))` and awaits `canonicalizeEvent` itself.
  //
  // MEASURED, because three green runs would not have shown whether the wait
  // does anything. A temporary probe read the message count and the counter
  // immediately before the wait, across three full-suite runs: the wait had to
  // block on ALL THREE — canonicalization was still in flight every time — and
  // on one of them the count read 0, which is the CI failure reproduced
  // locally. So this is load-bearing, not decorative, and removing it puts the
  // flake straight back.
  let settledEvents = 0;
  let notifySettled: (() => void) | undefined;

  /**
   * Wraps the ingest store so finished canonicalizations can be awaited.
   *
   * @param store - The real Prisma ingest store.
   * @returns The same store, counting terminal `markEvent` calls.
   */
  function countingCompletions(store: Persistence): Persistence {
    return {
      ...store,
      async markEvent(id, status) {
        await store.markEvent(id, status);
        settledEvents += 1;
        notifySettled?.();
      },
    };
  }

  /**
   * Resolves once at least `target` canonicalizations have reached a terminal
   * status. Bounded by the test's own timeout, so work that never finishes
   * fails the test rather than hanging it.
   *
   * @param target - The `settledEvents` value to wait for.
   */
  async function settledAtLeast(target: number): Promise<void> {
    while (settledEvents < target) {
      await new Promise<void>((resolve) => {
        notifySettled = resolve;
      });
    }
    notifySettled = undefined;
  }

  beforeAll(async () => {
    // Migrate and seed happen once for the whole project, in this Vitest
    // config's `globalSetup`. Doing it here raced the other live files on
    // Prisma's select-then-insert `upsert` — HANDOFF.md item 5.
    const db = await import("@select-lub/core/db");
    const client = db.prisma;
    if (!client) {
      throw new Error("expected PrismaClient when DATABASE_URL is set");
    }
    prisma = withConnectRetry(client);
    // The insert hook the old app took is the message-received event now; this
    // file counts it from here on, across the app path and the direct cases.
    offHooks = kernel.subscribe(messageReceived, () => {
      hooks += 1;
    });
    app = await buildWorkerApp({
      secret,
      db: kernel.createDb(prisma),
      store: countingCompletions(createIngestStore(kernel.createDb(prisma))),
      log: () => undefined,
    });
  }, 120_000);

  afterAll(async () => {
    offHooks();
    if (app) {
      await app.close();
    }
    if (!prisma) {
      return;
    }
    await prisma.message.deleteMany({ where: { externalMessageId: { in: externalIds } } });
    await prisma.webhookEvent.deleteMany({ where: { externalMessageId: { in: externalIds } } });
    await prisma.conversation.deleteMany({ where: { remoteJid } });
    if (convergeJids.length > 0) {
      await prisma.conversation.deleteMany({ where: { remoteJid: { in: convergeJids } } });
    }
  });

  async function post(payload: object) {
    return app.inject({
      method: "POST",
      url: "/webhooks/evolution",
      headers: { authorization: `Bearer ${secret}` },
      payload,
    });
  }

  it("replays the same upsert three times as one conversation and one message", async () => {
    const payload = upsertPayload({
      instance: instanceName,
      id: replayId,
      remoteJid,
    });
    const before = settledEvents;
    const responses = [await post(payload), await post(payload), await post(payload)];
    expect(responses.every((response) => response.statusCode === 200)).toBe(true);
    // The route answered before it finished; wait for all three to canonicalize.
    // This also keeps a late `onMessageInserted` from landing inside a later
    // case's `hooks` window, which is the second failure the convergence
    // comment below records.
    await settledAtLeast(before + 3);
    expect(await prisma.message.count({ where: { externalMessageId: replayId } })).toBe(1);
    expect(await prisma.conversation.count({ where: { remoteJid } })).toBe(1);
    expect(await prisma.webhookEvent.count({ where: { externalMessageId: replayId } })).toBe(3);
  });

  // Conversation identity is `(whatsapp_connection_id, chat_key)`, so once both
  // addressings resolve to the same key this holds by construction — no merge
  // step exists or is wanted. These two defend that property rather than create
  // it, and they run both arrival orders because "by construction" is exactly
  // the kind of claim that stops being true when someone adds a branch that
  // keys the first sighting differently from later ones.
  // Drives the store directly rather than posting to the app, for two reasons
  // learned by doing it the other way first. The HTTP handler returns 200 before
  // canonicalization has finished, so asserting straight after a post read an
  // empty table and then, on the next case, the previous case's late rows. And
  // the app's `onMessageInserted` increments the file-level `hooks` counter, so
  // a late increment from these tests landed inside the concurrency test's
  // before/after window and failed an assertion in a test they do not touch.
  it.each([
    { name: "plain first, then LID", lidFirst: false, ddd: "21" },
    { name: "LID first, then plain", lidFirst: true, ddd: "31" },
  ])("converges on one conversation — $name", async ({ lidFirst, ddd }) => {
    const store = createIngestStore(kernel.createDb(prisma));
    // Each case gets its own number: sharing one made the second case see the
    // first case's conversation and count its messages too.
    const convergeDigits = `55${ddd}${digits}`;
    const convergeJid = `${convergeDigits}@s.whatsapp.net`;
    const lidJid = `1${digits}9${ddd}@lid`;
    const plainId = `test-${runId}-conv-plain-${ddd}`;
    const lidId = `test-${runId}-conv-lid-${ddd}`;
    externalIds.push(plainId, lidId);
    convergeJids.push(convergeJid);

    const plain = upsertPayload({ instance: instanceName, id: plainId, remoteJid: convergeJid });
    const lid = upsertPayload({
      instance: instanceName,
      id: lidId,
      remoteJid: lidJid,
      remoteJidAlt: convergeJid,
    });

    for (const payload of lidFirst ? [lid, plain] : [plain, lid]) {
      const { id } = await persistRawEvent(store, payload);
      await canonicalizeEvent(store, id, () => undefined);
    }

    // One conversation, and it is keyed by the phone rather than by LID digits.
    const conversations = await prisma.conversation.findMany({ where: { chatKey: convergeDigits } });
    expect(conversations).toHaveLength(1);
    // Both messages landed on it, so neither addressing was silently dropped.
    expect(await prisma.message.count({ where: { conversationId: conversations[0]!.id } })).toBe(2);
    // The send address is the phone JID whichever order they arrived in.
    expect(conversations[0]!.remoteJid).toBe(convergeJid);
  });

  it("keeps a single message when two Prisma ingests of the same id run concurrently", async () => {
    const store = createIngestStore(kernel.createDb(prisma));
    const payload = upsertPayload({
      instance: instanceName,
      id: concurrentId,
      remoteJid,
    });
    const beforeHooks = hooks;
    await Promise.all(
      [1, 2].map(async () => {
        const { id } = await persistRawEvent(store, payload);
        await canonicalizeEvent(store, id);
      }),
    );
    expect(await prisma.message.count({ where: { externalMessageId: concurrentId } })).toBe(1);
    expect(hooks - beforeHooks).toBeLessThanOrEqual(1);
  });

  it("returns null for a missing event id and the row after persist", async () => {
    const store = createIngestStore(kernel.createDb(prisma));
    expect(await store.getEvent("00000000-0000-4000-8000-000000000000")).toBeNull();

    const lookupId = `test-${runId}-get-event`;
    const { id } = await persistRawEvent(
      store,
      upsertPayload({ instance: instanceName, id: lookupId, remoteJid }),
    );
    const found = await store.getEvent(id);
    expect(found?.id).toBe(id);
    expect(found?.externalMessageId).toBe(lookupId);
    expect(found?.status).toBe("received");
    await prisma.webhookEvent.deleteMany({ where: { id } });
  });
});

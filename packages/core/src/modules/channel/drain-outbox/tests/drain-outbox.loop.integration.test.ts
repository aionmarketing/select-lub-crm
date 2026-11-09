/**
 * Test design (testing-strategy)
 *
 * SUT: `drainOutbox` — the per-tick loop — and `job`, the same loop inside the
 *   kernel's job registry, on the real database in a rolling-back transaction,
 *   with a stubbed `EvolutionSend`. No real Evolution HTTP.
 *
 * Ran under module role: `channel` (every query is `db.tx("channel")`; asserted in
 *   drain-outbox.integration.test.ts).
 *
 * Moved from apps/worker/src/outbox/drain.test.ts (adopt-modular-vertical-slices
 * 3A), whose header is kept here in substance:
 *
 * NO STORE INTERFACE, AND NO AD-HOC STORE. The old file had already replaced a
 * memory store and a hand-written `OutboxDrain` with real rows. Now there is no
 * store object at all: the drain's four queries take the `Db` handle.
 *
 * FAKE-ONLY ASSERTIONS SURFACED EARLIER, STILL LOAD-BEARING.
 *   1. `claimQueued` has no tenancy predicate: it takes the OLDEST queued row in
 *      the whole table. Every read is by the row's own id, and the multi-row
 *      cases group by status within the test's own conversation.
 *   2. `updated_at` is `@updatedAt`, so Prisma overwrites it on any client-side
 *      update; ageing a row past the backoff is raw SQL (`ageBeyondBackoff`).
 *   3. The backoff compares against the DATABASE clock. Inside a transaction
 *      `NOW()` does not advance, so the age is written relative to it. A row that
 *      is silently never re-claimed would satisfy "not retried early" while
 *      proving nothing, which is why the exhaustion loops age between attempts.
 *   4. Every row in a test transaction shares one `created_at`, so the claim's
 *      `ORDER BY created_at` ties: lists are compared sorted, and the cap cases
 *      assert counts, not which rows drained.
 *
 * THE OVERLAP GUARD MOVED TO THE KERNEL. The old file drove `drainQueued`, whose
 * own `DrainState` flag skipped an overlapping call. Production never used that
 * guard — the worker's outbox timer called the unguarded loop behind a flag of
 * its own — and both are gone: the kernel's job registry keeps one tick of a job
 * in flight at a time. The two overlap cases therefore now drive the slice's
 * `job` through a real `createJobRegistry()`, with only `setInterval` faked, and
 * keep their assertions: an overlapping tick sends nothing extra, and two
 * separate registries do not share the flag.
 *
 * Behaviour this file used to pin that a previous change reversed, kept so a
 * reader comparing against an older revision is not left guessing:
 *   `outcome === "requeued"` no longer stops the tick; the backoff in
 *   `claimQueued` is the hot-loop guard now. The retry bound applies to every
 *   message type, so a text row reaches `failed` after OUTBOX_RETRY_MAX_ATTEMPTS.
 *
 * Oracle: whatsapp-channel outbox requirement (drain paragraph, per-tick cap) +
 *   outbox-failure-pacing.
 *
 * Axes: 3 overlap — idle vs overlapping tick vs separate registries; 4 queued
 *   count vs cap 50 (BVA 3, 50, 51); 5 requeued failure — single tick vs repeated
 *   ticks; disconnect rejections do not stop the tick.
 *
 * Outputs: O6 burst empty; O7 overlapping tick sends nothing extra; O8 leftover
 *   after cap; O9 one attempt per tick for a requeued failure; O10 blocked items
 *   do not stop the tick.
 */
import { expect, it, vi } from "vitest";
import { createJobRegistry, type Job } from "../../../../kernel/jobs.js";
import { describeWithDatabase, withTestTransaction } from "../../../../testing/index.js";
import {
  drainOnce,
  drainOutbox,
  job,
  OUTBOX_DRAIN_PER_TICK_CAP,
  OUTBOX_RETRY_MAX_ATTEMPTS,
  type DrainOutboxDeps,
} from "../index.js";
import {
  ageBeyondBackoff,
  countingEvolution,
  db,
  rowOf,
  rowsOf,
  seedQueuedItems,
  stubEvolution,
} from "./drain-outbox.fixture.js";

const EVERY_MS = 1_000;

/**
 * Registers the drain job on a fresh registry and records every tick's promise,
 * so a test can count ticks that actually ran and await them.
 */
function recordedRegistry(deps: DrainOutboxDeps) {
  const registry = createJobRegistry();
  const runs: Promise<void>[] = [];
  const real: Job = job({ ...deps, everyMs: EVERY_MS });
  registry.register({
    ...real,
    run: (signal) => {
      const run = real.run(signal);
      runs.push(run);
      return run;
    },
  });
  return { registry, runs };
}

/** A promise and the function that settles it. */
function gate() {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { hold, release };
}

describeWithDatabase("drain-outbox — the tick", () => {
  it("drains three queued items in one tick", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversationId, db: handle } = await seedQueuedItems(tx, 3);
      const { evolution, sent } = countingEvolution();

      await drainOutbox({ db: handle, evolution });

      expect(sent()).toBe(3);
      const rows = await rowsOf(tx, conversationId);
      expect(rows.filter((row) => row.status === "queued")).toHaveLength(0);
    }));

  it("skips a second tick while the first is still sending", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversationId, db: handle } = await seedQueuedItems(tx, 3);
      const { hold, release } = gate();
      let sent = 0;
      const evolution = stubEvolution({
        async sendText() {
          await hold;
          sent += 1;
          return { ok: true, externalMessageId: `out-${sent}`, providerTimestamp: new Date("2026-01-01T12:00:00.000Z") };
        },
      });
      const { registry, runs } = recordedRegistry({ db: handle, evolution });

      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const running = registry.start();
      try {
        vi.advanceTimersByTime(EVERY_MS); // first tick starts and holds in the send
        vi.advanceTimersByTime(EVERY_MS); // second tick fires while it is in flight
        release();
        await Promise.all(runs);
      } finally {
        await running.stop();
        vi.useRealTimers();
      }

      expect(runs).toHaveLength(1);
      expect(sent).toBe(3);
      const rows = await rowsOf(tx, conversationId);
      expect(rows.filter((row) => row.status === "queued")).toHaveLength(0);
    }));

  it("does not share the overlap guard between separate registries", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversationId, db: handle } = await seedQueuedItems(tx, 3);
      const { hold, release } = gate();
      let sentA = 0;
      const counterB = countingEvolution("out-b");
      const a = recordedRegistry({
        db: handle,
        evolution: stubEvolution({
          async sendText() {
            await hold;
            sentA += 1;
            return { ok: true, externalMessageId: `out-a-${sentA}`, providerTimestamp: new Date("2026-01-01T12:00:00.000Z") };
          },
        }),
      });
      const b = recordedRegistry({ db: handle, evolution: counterB.evolution });

      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const runningA = a.registry.start();
      const runningB = b.registry.start();
      try {
        vi.advanceTimersByTime(EVERY_MS); // one tick on each registry
        await Promise.all(b.runs);
        release();
        await Promise.all(a.runs);
      } finally {
        await runningA.stop();
        await runningB.stop();
        vi.useRealTimers();
      }

      expect(a.runs).toHaveLength(1);
      expect(b.runs).toHaveLength(1);
      expect(counterB.sent()).toBeGreaterThan(0);
      expect(sentA + counterB.sent()).toBe(3);
      const rows = await rowsOf(tx, conversationId);
      expect(rows.filter((row) => row.status === "queued")).toHaveLength(0);
    }));

  it("drains exactly the per-tick cap of 50 queued items", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversationId, db: handle } = await seedQueuedItems(tx, OUTBOX_DRAIN_PER_TICK_CAP);
      const { evolution, sent } = countingEvolution();

      await drainOutbox({ db: handle, evolution });

      expect(sent()).toBe(OUTBOX_DRAIN_PER_TICK_CAP);
      const rows = await rowsOf(tx, conversationId);
      expect(rows.filter((row) => row.status === "queued")).toHaveLength(0);
    }));

  it("leaves the 51st queued item for the next tick", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversationId, db: handle } = await seedQueuedItems(tx, OUTBOX_DRAIN_PER_TICK_CAP + 1);
      const { evolution, sent } = countingEvolution();

      await drainOutbox({ db: handle, evolution });

      expect(sent()).toBe(OUTBOX_DRAIN_PER_TICK_CAP);
      // Which row is left is arbitrary — every row in this transaction shares
      // one created_at, so the ORDER BY ties. The cap is the requirement.
      const rows = await rowsOf(tx, conversationId);
      expect(rows.filter((row) => row.status === "queued")).toHaveLength(1);
    }));

  it("keeps draining the rest of the queue after a retryable failure", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversationId, db: handle } = await seedQueuedItems(tx, 3);
      let attempts = 0;

      await drainOutbox({
        db: handle,
        evolution: stubEvolution({
          async sendText() {
            attempts += 1;
            return { ok: false, kind: "retryable", error: "network ECONNREFUSED" };
          },
        }),
      });

      // All three were attempted in the one tick. Under the old rule this was 1:
      // the first failure ended the tick and the other two waited, forever if the
      // first row could never succeed.
      expect(attempts).toBe(3);
      const rows = await rowsOf(tx, conversationId);
      expect(rows.filter((row) => row.status === "queued")).toHaveLength(3);
      // Sorted: no row order is promised, and all three tie on created_at.
      expect(rows.map((row) => row.attemptCount).sort()).toEqual([1, 1, 1]);
    }));

  it("does not retry a just-failed row until its backoff has elapsed", () =>
    withTestTransaction(db(), async (tx) => {
      const { ids, db: handle } = await seedQueuedItems(tx, 1);
      const id = ids[0]!;
      let attempts = 0;
      const evolution = stubEvolution({
        async sendText() {
          attempts += 1;
          return { ok: false, kind: "retryable", error: "network ECONNREFUSED" };
        },
      });

      await drainOutbox({ db: handle, evolution });
      await drainOutbox({ db: handle, evolution });
      await drainOutbox({ db: handle, evolution });

      // Three ticks, one attempt: the row is queued but not yet claimable.
      expect(attempts).toBe(1);
      expect((await rowOf(tx, id)).status).toBe("queued");
      expect((await rowOf(tx, id)).attemptCount).toBe(1);

      // Age it past the backoff and it becomes claimable again. Asserting the row
      // does get retried matters as much as asserting it waits: a claim that
      // simply never returned a failed row would satisfy the first half alone.
      await ageBeyondBackoff(tx, id);
      await drainOutbox({ db: handle, evolution });
      expect(attempts).toBe(2);
      expect((await rowOf(tx, id)).attemptCount).toBe(2);
    }));

  it("marks a text row failed once its attempts are exhausted, rather than retrying forever", () =>
    withTestTransaction(db(), async (tx) => {
      const { ids, db: handle } = await seedQueuedItems(tx, 1);
      const id = ids[0]!;
      const evolution = stubEvolution({
        async sendText() {
          return { ok: false, kind: "retryable", error: "network ECONNREFUSED" };
        },
      });

      // Drive it to the bound, ageing past the backoff between attempts the way
      // real time would.
      for (let i = 0; i < OUTBOX_RETRY_MAX_ATTEMPTS; i += 1) {
        await drainOnce({ db: handle, evolution });
        await ageBeyondBackoff(tx, id);
      }

      expect((await rowOf(tx, id)).status).toBe("failed");
      expect((await rowOf(tx, id)).attemptCount).toBe(OUTBOX_RETRY_MAX_ATTEMPTS);
      // And a failed row is never claimed again, whatever its age.
      await drainOnce({ db: handle, evolution });
      expect((await rowOf(tx, id)).attemptCount).toBe(OUTBOX_RETRY_MAX_ATTEMPTS);
    }));

  it("continues past blocked disconnect rejections in the same tick", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversationId, db: handle } = await seedQueuedItems(tx, 3);
      let attempts = 0;

      await drainOutbox({
        db: handle,
        evolution: stubEvolution({
          async sendText() {
            attempts += 1;
            return { ok: false, kind: "disconnected", error: "evolution 404" };
          },
        }),
      });

      expect(attempts).toBe(3);
      const rows = await rowsOf(tx, conversationId);
      expect(rows.filter((row) => row.status === "blocked")).toHaveLength(3);
      expect(rows.filter((row) => row.status === "queued")).toHaveLength(0);
    }));
});

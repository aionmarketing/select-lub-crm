/**
 * Test design (testing-strategy)
 *
 * Setup: `startWorker()` with the real Prisma stores on the worktree database
 * inside a rolling-back test transaction (`withTestTransaction`).
 * heartbeatMs / outboxPollMs ~20ms so `vi.waitFor` can observe timers without
 * wall-clock 1s/30s. The lifecycle, Omie-toggle and interval-delay cases need no
 * store at all and stay in a plain `describe`.
 *
 * Oracle: faster-outbox-drain whatsapp-channel delta — ingest retry stays on
 * the heartbeat; outbox drain uses the dedicated poll. whatsapp-history-backfill
 * — REST import runs once at start only when historyBackfill is true.
 *
 * FAKE-ONLY ASSERTIONS SURFACED (route-tests-on-real-database, D10). Five, and
 * the fifth is the one that took the file down: it is not an assertion at all but
 * production shutdown behaviour the fake made invisible.
 *
 *   1. Two cases would have WRITTEN demo-seeded rows on the real adapter, which
 *      is forbidden and would not have failed here — it would have failed
 *      somewhere else. `reconcileConnectionState` iterates every row
 *      `listConnections()` returns, and that query has no `where`, so a stub
 *      answering `{ ok: true }` for everything makes the worker UPDATE all five
 *      base connections inside this test's transaction. Another file's
 *      transaction wanting those rows deadlocks, and Postgres aborts one of
 *      them, surfacing as `25P02` from an unrelated statement
 *      (memory: never-write-demo-seeded-rows-in-tests). Every reconcile stub
 *      here therefore answers only for the instance name the test seeded and
 *      returns `{ ok: false }` for the rest, so the only row written is one the
 *      test created. The fake could not show this: its `listConnections()`
 *      returned exactly what the test had seeded.
 *
 *   2. `expect(findChats).toHaveBeenCalledTimes(1)` in the history cases counted
 *      calls across the whole connection list for the same reason. The rule
 *      being protected is "backfill runs ONCE, at start, not on the heartbeat",
 *      so the assertion now counts calls for THIS test's instance name, which is
 *      that rule stated in a form the adapter can satisfy.
 *
 *   3. `store.seedSeededHistoryMessage()` was a fake-only helper. The real gate
 *      is `countSeedOriginMessages()`, an unscoped `count` over `message` where
 *      `origin = 'SEED'`, so the case now inserts a real SEED-origin message.
 *      That cuts both ways. The gate is global by design — any seeded demo
 *      history forbids importing real history — so on a database `db:seed` has
 *      populated, the backfill genuinely does not run, and a case that needs it
 *      to RUN cannot pass there. That case used to assert
 *      `countSeedOriginMessages() === 0` as a precondition, which made it fail
 *      on every seeded worktree database (found in 3A, 2026-09-24). Scoping the
 *      precondition to the test's own rows would not help: the production gate
 *      would still see the seeded rows and skip. So that case pins the gate's
 *      INPUT instead, with the one-method override the failure-injection cases
 *      use (`countSeedOriginMessages` answers 0), because what it is about is
 *      "once at start, not on the heartbeat". The gate itself stays pinned by
 *      the seeded-history case, which inserts its own SEED row.
 *
 *   4. The stale-claim case ran a 20ms `setInterval` re-stamping the "young" row
 *      so it would not age past the timeout. That was needed only because the
 *      fake compared `Date.now()`. The adapter compares SQL `NOW()`, which
 *      inside a transaction is `transaction_timestamp()` and DOES NOT ADVANCE —
 *      so a row stamped at `NOW()` is zero seconds old for the whole test and
 *      the refresher is not just unnecessary but harmful (it would issue writes
 *      on the transaction concurrently with the worker's own queries). Removed;
 *      the stale row is stamped `NOW() - 10 seconds` and the young one `NOW()`,
 *      and both stay that way by construction
 *      (memory: sql-clock-beats-fake-timers).
 *
 *   5. `stop()` disconnects the SHARED Prisma client. worker.ts:239 ends with
 *      `void Promise.resolve(prisma?.$disconnect()).finally(() => exit(0))`,
 *      reaching for the module-level singleton whatever store it was handed. No
 *      test touched that singleton before, so disconnecting it cost nothing; here
 *      every test shares it, and the disconnect lands while the test's transaction
 *      is still open. The rollback then runs on a closed connection and the whole
 *      remainder of the file dies with "Engine is not yet connected", reported
 *      from lines that have nothing to do with the cause — thirteen failures from
 *      one line. Reconnecting between tests does not help, because the damage
 *      happens inside the previous test. `silenceWorkerDisconnect` below stubs the
 *      disconnect per test and explains why that is legitimate rather than a
 *      convenience: what these cases assert is that the timers stop and `exit(0)`
 *      is called, and in production the process is exiting anyway.
 *
 * RE-WIRED FOR THE JOB REGISTRY (adopt-modular-vertical-slices 3A). Every loop
 * is a kernel job now, and the outbox drain, the reclaim and the reconcile are
 * channel's, reached through a database handle instead of the old `OutboxDrain`
 * port. So the cases pass `db` where they passed `outbox`, and the four that
 * overrode a port method to hold, count or throw now do it on that handle
 * (`spyDb`). The in-flight cases (D6, D8, D15) now pin the REGISTRY's per-job
 * flag, which replaced each loop's own. Two behaviours changed and are stated
 * where they are pinned: the channel jobs need a handle, a store and an
 * Evolution client (the interval cases pass inert ones), and the scheduled due
 * tick is its own job, so D10 pins recover → dispatch → sync without a drain
 * between them. Assertions are unchanged.
 *
 * TWO SOURCES OF CONNECTIVITY, AND WHICH ONE EACH PATH READS. The worker keeps
 * them cleanly apart, and the fake had one flag standing for both:
 *   - the LIVE probe, `EvolutionConnectionState.getConnectionState`, read only by
 *     `reconcile.ts`;
 *   - the STORED column `whatsapp_connection.connection_state`, written by
 *     `ingest/prisma.ts` `updateConnectionState` and read for a decision only by
 *     scheduling's `run-due-tick` `dispatchDue` (queued vs blocked).
 * The reconcile cases here DRIVE the live probe and ASSERT the stored column, with
 * the stored column pinned to the opposite value first, so swapping the two
 * sources cannot pass by accident. The path that reads the stored column for a
 * decision is exercised where it lives, in scheduling's run-due-tick tests.
 *
 * Axes
 *   1. process lifecycle — running vs stop(SIGTERM)
 *   2. failed ingest — retry due vs not due
 *   3. queued outbox — present vs absent
 *   4. historyBackfill — true vs false (default) vs true+SEED present
 *   5. connectionState client — present vs absent; GET hang vs resolve
 *   6. omiePull — true vs false (default)
 *   6b. omieIncremental — true vs false vs not-configured; startup still `"full"`
 *   7. claimTimeoutMs — explicit / WORKER_OUTBOX_CLAIM_TIMEOUT_MS / default 180000
 *   8. reclaim — stale claimed vs young claimed / queued / confirmed
 *
 * Outputs: O1 exit 0; O2 ingest message after heartbeat; O3 outbox confirmed
 *   on outbox poll with the send stub's providerTimestamp on the canonical
 *   row (outbox-send-provider-timestamp); O4 ingest retry not run from
 *   outbox timer; O5 findChats once at start when flagged; O6 no REST when
 *   flag off; O7 start GET open writes CONNECTED; O8 heartbeat GET close
 *   writes DISCONNECTED; O9 in-flight skip does not issue a second GET;
 *   O10 reclaim interval from option/env/default; O11 stale claimed
 *   reclaimed then drained; O12 other rows untouched by reclaim.
 *
 * startWorker: D1 store present (heartbeat retry); D2 store+outbox+evolution
 *   (outbox timer drain); D3 stopping already true (second stop); D4
 *   store+history+historyBackfill (start job, not heartbeat); D5
 *   store+connectionState (start + heartbeat reconcile); D6 reclaim
 *   inFlight; D7 reclaim throw; D8 outbox-timer drainState; D9 outbox tick
 *   catch; D10 scheduled due/sync bracket; D11 missing port no-op; D12
 *   reconcile catch; D13 prefill timer and its catch; D14 ingest-retry catch;
 *   D15 omieIncremental inFlight; D16 the `"unknown"` arm of the catches.
 *
 * The decision-to-`it` map and the rationale for each added decision are
 * unchanged from the pre-migration revision; the reasoning did not depend on
 * which store backed them. Preserved verbatim:
 *
 *   D8  the outbox drain's overlap guard. It was the timer's own drainState;
 *       since 3A it is the kernel job registry's per-job flag around channel's
 *       drain-outbox job (the drain loop has no guard of its own). Oracle:
 *       whatsapp-channel "Overlapping tick does not double-claim".
 *   D9  the outbox tick catch. Oracle: documented intent on startWorker
 *       ("A second overlapping drain tick is skipped"; the loop is expected to
 *       survive a bad row). Asserts the message names the cause AND that a
 *       later tick still drains — a log alone would not show recovery.
 *   D10 `if (scheduled)` around runDueTick / syncScheduled, both outcomes.
 *       Ordering is asserted, not just the calls: scheduled-messages requires
 *       a due row to reach the same tick's drain, and the outcome sync to read
 *       what that drain recorded.
 *   D11 `!store || !outbox || !evolution` in the outbox timer, true outcome.
 *       Reached in production whenever DATABASE_URL is unset (index.ts:18-30).
 *   D12 the runReconcile catch. The reconcile PORT returns { ok: false } for a
 *       failed GET (whatsapp-channel "Failed GET leaves stored state", already
 *       sampled); this is the different path where the call THROWS.
 *   D13 the prefill timer body and its catch, both outcomes of `if
 *       (prefill)`. assistive-prefill runs on its own poll, not the
 *       outbox poll, and nothing exercised that timer.
 *   D14 the ingest-retry catch on the heartbeat. Keeps the heartbeat — and the
 *       reconcile that runs after it on the same tick — alive when the retry
 *       pass itself throws rather than failing an individual event.
 *   D15 omieIncrementalState.inFlight. The same in-flight rule as the reclaim
 *       pass, on a separate state object; a pull that outlasts its interval
 *       would otherwise overlap and duplicate import work.
 *   D16 the `"unknown"` arm of `error instanceof Error ? error.message :
 *       "unknown"`. Found by reading untaken branch ARMS rather than uncovered
 *       lines: every one of those lines is executed by the tests above, so the
 *       line report shows them green while one arm of each was never taken.
 *       Sampled once, on the outbox tick, by rejecting with a non-Error value.
 *       The same idiom at worker.ts 97 / 161 / 199 / 214 is left to that one
 *       proof rather than repeated four more times — identical expression,
 *       identical narrowing, no per-site behaviour. Named here rather than
 *       claimed as covered.
 *
 * The ordering cases (D10, D13) wrap the REAL adapter to record call order
 * rather than replacing it with a recorder, so the order asserted is the order
 * the production stores were driven in. The failure-injection cases override one
 * method on the real store, the same shape ingest-message's retry tests use.
 *
 * Out of scope: docker Evolution; pairing QR (PEND-CH-01).
 *   createIngestStore wiring (index.ts; ingest.live.test.ts); channel's queries
 *   are its own slices' (packages/core/src/modules/channel). The channel jobs are
 *   not registered without a handle, a store and Evolution (no observable).
 *   Claim-age BVA is channel's reclaim-stuck tests. The omie-pull and
 *   history-backfill REJECTION handlers (worker.ts 117-118, 132, 147-148)
 *   stay unsampled: each is a one-line log at the end of a fire-and-forget
 *   `void` chain, leaving no state to observe afterwards, and the jobs
 *   themselves are covered in core's erp/run-pull/tests and history.test.ts.
 *   Named here rather than left silent.
 */
import { prisma, type PrismaClient } from "@select-lub/core/db";
import type { DbClient } from "@select-lub/core/db";
import {
  describeWithDatabase,
  runInTransactionOnTx,
  seedConnection,
  seedUnit,
  withTestTransaction,
} from "@select-lub/core/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { upsertPayload } from "@select-lub/core/testing";
import { kernel } from "@select-lub/core";
import {
  createEvolutionConnectionState,
  type EvolutionConnectionState,
  type EvolutionConnectionStateResult,
  type EvolutionSend,
} from "@select-lub/core/modules/channel";
import { outboundSent } from "@select-lub/core/modules/channel/contracts";
import { createPrefillJob, type GeneratePrefillFields } from "@select-lub/core/modules/prefill";
import { createScheduledDue } from "@select-lub/core/modules/scheduling";
import { startWorker } from "../src/worker.js";
import {
  createIngestStore,
  type IngestStore as Persistence,
  persistRawEvent,
} from "@select-lub/core/modules/conversations";

const CHAT_KEY = "5511999999999";

const db = () => prisma as PrismaClient;

/**
 * The prefill job's LLM backend in these tests. Without it `createPrefillJob`
 * falls back to the real OpenAI call, which a drain would reach the moment the
 * database held a conversation with the switch on and a closed window — so no
 * seed can make a case here call a provider.
 */
const offlineGenerate: GeneratePrefillFields = async () => ({ shouldReply: false });

function captureIntervalDelays() {
  const delays: number[] = [];
  const spy = vi.spyOn(globalThis, "setInterval").mockImplementation((
    ((_callback: () => void, ms?: number) => {
      delays.push(Number(ms));
      return { unref() { return this; } } as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval
  ));
  return {
    delays,
    restore() {
      spy.mockRestore();
    },
  };
}

function stubEvolution(partial: Pick<EvolutionSend, "sendText"> & Partial<EvolutionSend>): EvolutionSend {
  const unusedSend = async () => ({ ok: false as const, kind: "refused" as const, error: "unused" });
  return {
    sendWhatsAppAudio: unusedSend,
    sendMedia: unusedSend,
    async getBase64FromMediaMessage() {
      return { ok: false, disconnected: false, error: "unused" };
    },
    ...partial,
  };
}

/**
 * The three ports the channel jobs need, inert, for the cases that only read which
 * intervals were registered. `setInterval` is captured in those cases, so no tick
 * ever runs and nothing here is ever called; they exist because the channel jobs
 * are registered only when a database handle, an ingest store and an Evolution
 * client are all present, as they are in production.
 */
function inertSendPorts() {
  return {
    db: {} as kernel.Db,
    store: {} as Persistence,
    evolution: stubEvolution({
      async sendText() {
        throw new Error("inert: no tick runs in this case");
      },
    }),
  };
}

/**
 * Channel's handle over `tx`, the one the composition root builds over Prisma.
 *
 * @param tx - The test transaction.
 * @returns The handle.
 */
function handleOf(tx: DbClient): kernel.Db {
  return kernel.createDb(tx, runInTransactionOnTx(tx));
}

/**
 * Channel's handle over `tx`, running `before` ahead of every `channel`
 * transaction — to hold it, count it or throw from it.
 *
 * It stands in for the old cases' overridden outbox port (`claimQueued`,
 * `reclaimAbandonedClaims`): the drain and the reclaim are channel slices now,
 * reached only through the database handle, so that is where the fault goes in.
 * Each case arranges that only the job it is about opens a `channel` transaction.
 *
 * @param tx - The test transaction.
 * @param before - Awaited before each `channel` transaction opens.
 * @returns The handle.
 */
function spyDb(tx: DbClient, before: () => Promise<void>): kernel.Db {
  const real = handleOf(tx);
  return {
    client: real.client,
    async tx<T>(module: kernel.ModuleName, fn: (inner: DbClient) => Promise<T>, run?: kernel.RunInTransaction) {
      if (module === "channel") {
        await before();
      }
      return real.tx(module, fn, run);
    },
  };
}

/**
 * Keeps `stop()` from closing the Prisma client this whole file shares.
 *
 * `startWorker`'s stop() ends with worker.ts:239,
 * `void Promise.resolve(prisma?.$disconnect()).finally(() => exit(0))`. It reaches
 * for the MODULE-LEVEL singleton whatever store it was handed, which is right in
 * production — the worker owns its process and should close the pool on shutdown.
 *
 * Under the harness it is not free. Every test here shares that client, and the
 * disconnect lands while the test's transaction is still open, so the rollback
 * `withTestTransaction` performs afterwards runs on a closed connection and the
 * whole rest of the file fails with "Engine is not yet connected" — from a line
 * that has nothing to do with the cause. Reconnecting in a `beforeEach` does not
 * help, because the damage is done inside the previous test, not between them.
 *
 * So the disconnect is neutralised for the duration of each test. What these tests
 * assert is that the timers stop and `exit(0)` is called; closing the pool is
 * incidental to that, and in production the process is exiting anyway. The stub is
 * restored after every test. See note 5 in the header.
 */
function silenceWorkerDisconnect() {
  beforeEach(() => {
    if (prisma) {
      vi.spyOn(prisma, "$disconnect").mockResolvedValue(undefined);
    }
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
}

/**
 * A reconcile client that answers for ONE instance and refuses every other.
 *
 * Refusing the rest is what keeps the worker from updating the base and demo
 * connection rows; see note 1 in the header.
 *
 * @param instanceName - The instance this client answers for.
 * @param answer - What to answer for that instance, evaluated per call so a test
 *   can change its mind between heartbeats.
 * @returns The client, with `getConnectionState` as a spy.
 */
function reconcileFor(instanceName: string, answer: () => EvolutionConnectionStateResult) {
  const getConnectionState = vi.fn(
    async (name: string): Promise<EvolutionConnectionStateResult> =>
      name === instanceName ? answer() : { ok: false },
  );
  return { client: { getConnectionState } satisfies EvolutionConnectionState, getConnectionState };
}

describe("worker lifecycle and toggles (no store)", () => {
  silenceWorkerDisconnect();

  it("stays running until stop, then exits 0", async () => {
    const logs: string[] = [];
    const exit = vi.fn();
    const { stop } = startWorker({
      heartbeatMs: 60_000,
      log: (message) => logs.push(message),
      exit,
    });

    expect(logs[0]).toBe("worker started");
    expect(exit).not.toHaveBeenCalled();

    stop("SIGTERM");
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(0);
    });
    expect(logs.some((line) => line.includes("SIGTERM"))).toBe(true);
  });

  it("logs ingest store skipped when started without a store", async () => {
    const logs: string[] = [];
    const exit = vi.fn();
    const { stop } = startWorker({
      heartbeatMs: 60_000,
      log: (message) => logs.push(message),
      exit,
    });

    expect(logs).toContain("ingest store skipped (DATABASE_URL unset)");
    stop("SIGTERM");
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(0);
    });
  });

  it("ignores a second stop after the first has begun", async () => {
    const logs: string[] = [];
    const exit = vi.fn();
    const { stop } = startWorker({
      heartbeatMs: 60_000,
      log: (message) => logs.push(message),
      exit,
    });

    stop("SIGTERM");
    stop("SIGINT");
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledTimes(1);
    });
    expect(exit).toHaveBeenCalledWith(0);
    expect(logs.filter((line) => line.includes("worker stopping"))).toHaveLength(1);
  });

  it("does not run an Omie pull on default start", async () => {
    const runOmiePull = vi.fn(async () => undefined);
    const fetchSpy = vi.fn();
    const previous = globalThis.fetch;
    globalThis.fetch = fetchSpy as typeof fetch;
    const exit = vi.fn();
    const { stop } = startWorker({
      heartbeatMs: 60_000,
      runOmiePull,
      log: () => undefined,
      exit,
    });

    expect(runOmiePull).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    globalThis.fetch = previous;
    stop("SIGTERM");
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(0);
    });
  });

  it("runs the injected Omie pull once when omiePull is true", async () => {
    const runOmiePull = vi.fn<(mode: "full" | "incremental", log?: (message: string) => void) => Promise<void>>(
      async () => undefined,
    );
    const logs: string[] = [];
    const exit = vi.fn();
    const { stop } = startWorker({
      heartbeatMs: 60_000,
      omiePull: true,
      runOmiePull,
      log: (message) => logs.push(message),
      exit,
    });

    await vi.waitFor(() => {
      expect(runOmiePull).toHaveBeenCalledTimes(1);
    });
    expect(runOmiePull).toHaveBeenCalledWith("full", expect.any(Function));
    // The worker's own log goes to the pull, so its warnings (the Omie match's
    // no-key skip) land where the worker's lines do (owner rulings, 2026-09-25).
    runOmiePull.mock.calls[0]?.[1]?.("omie_match_no_key customer=c-1");
    expect(logs).toContain("omie_match_no_key customer=c-1");
    expect(logs).toContain("omie pull start");
    stop("SIGTERM");
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(0);
    });
  });

  it("registers an incremental Omie poll and calls the job with incremental", async () => {
    const runOmiePull = vi.fn(async () => undefined);
    const callbacks: Array<{ ms: number; callback: () => void }> = [];
    const spy = vi.spyOn(globalThis, "setInterval").mockImplementation((
      ((callback: () => void, ms?: number) => {
        callbacks.push({ ms: Number(ms), callback });
        return { unref() { return this; } } as unknown as ReturnType<typeof setInterval>;
      }) as typeof setInterval
    ));
    const exit = vi.fn();
    try {
      const { stop } = startWorker({
        heartbeatMs: 60_000,
        outboxPollMs: 60_000,
        prefillPollMs: 60_000,
        omieIncremental: true,
        omieIncrementalMs: 77_000,
        runOmiePull,
        log: () => undefined,
        exit,
      });
      expect(callbacks.some((entry) => entry.ms === 77_000)).toBe(true);
      callbacks.find((entry) => entry.ms === 77_000)?.callback();
      await vi.waitFor(() => {
        expect(runOmiePull).toHaveBeenCalledWith("incremental", expect.any(Function));
      });
      stop("SIGTERM");
    } finally {
      spy.mockRestore();
    }
    // stop() waits for ticks in flight before it disconnects and exits; the
    // test must not end first, or the disconnect lands after afterEach has
    // removed its stub and reaches the client every test shares.
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(0);
    });
  });

  it("does not register an incremental Omie poll when the toggle is off", async () => {
    const runOmiePull = vi.fn(async () => undefined);
    const { delays, restore } = captureIntervalDelays();
    const exit = vi.fn();
    try {
      const { stop } = startWorker({
        heartbeatMs: 60_000,
        outboxPollMs: 60_000,
        prefillPollMs: 60_000,
        omieIncremental: false,
        omieIncrementalMs: 77_000,
        runOmiePull,
        log: () => undefined,
        exit,
      });
      expect(delays).not.toContain(77_000);
      expect(runOmiePull).not.toHaveBeenCalled();
      stop("SIGTERM");
    } finally {
      restore();
    }
    // stop() waits for ticks in flight before it disconnects and exits; the
    // test must not end first, or the disconnect lands after afterEach has
    // removed its stub and reaches the client every test shares.
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(0);
    });
  });

  it("does not register an incremental Omie poll when the toggle is not configured", async () => {
    const runOmiePull = vi.fn(async () => undefined);
    const previousPoll = process.env.WORKER_OMIE_POLL;
    const previousMs = process.env.WORKER_OMIE_POLL_MS;
    delete process.env.WORKER_OMIE_POLL;
    delete process.env.WORKER_OMIE_POLL_MS;
    const { delays, restore } = captureIntervalDelays();
    const exit = vi.fn();
    try {
      const { stop } = startWorker({
        heartbeatMs: 60_000,
        outboxPollMs: 60_000,
        prefillPollMs: 60_000,
        runOmiePull,
        log: () => undefined,
        exit,
      });
      expect(delays).not.toContain(3_600_000);
      stop("SIGTERM");
    } finally {
      restore();
      if (previousPoll === undefined) {
        delete process.env.WORKER_OMIE_POLL;
      } else {
        process.env.WORKER_OMIE_POLL = previousPoll;
      }
      if (previousMs === undefined) {
        delete process.env.WORKER_OMIE_POLL_MS;
      } else {
        process.env.WORKER_OMIE_POLL_MS = previousMs;
      }
    }
    // stop() waits for ticks in flight before it disconnects and exits; the
    // test must not end first, or the disconnect lands after afterEach has
    // removed its stub and reaches the client every test shares.
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(0);
    });
  });

  it("reads WORKER_OUTBOX_CLAIM_TIMEOUT_MS when claimTimeoutMs is omitted", async () => {
    const previous = process.env.WORKER_OUTBOX_CLAIM_TIMEOUT_MS;
    process.env.WORKER_OUTBOX_CLAIM_TIMEOUT_MS = "45000";
    const { delays, restore } = captureIntervalDelays();
    const exit = vi.fn();
    try {
      const { stop } = startWorker({
        heartbeatMs: 60_000,
        outboxPollMs: 60_000,
        prefillPollMs: 60_000,
        ...inertSendPorts(),
        log: () => undefined,
        exit,
      });
      expect(delays).toContain(45_000);
      stop("SIGTERM");
    } finally {
      restore();
      if (previous === undefined) {
        delete process.env.WORKER_OUTBOX_CLAIM_TIMEOUT_MS;
      } else {
        process.env.WORKER_OUTBOX_CLAIM_TIMEOUT_MS = previous;
      }
    }
    // stop() waits for ticks in flight before it disconnects and exits; the
    // test must not end first, or the disconnect lands after afterEach has
    // removed its stub and reaches the client every test shares.
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(0);
    });
  });

  it("uses an explicit claimTimeoutMs instead of the env value", async () => {
    const previous = process.env.WORKER_OUTBOX_CLAIM_TIMEOUT_MS;
    process.env.WORKER_OUTBOX_CLAIM_TIMEOUT_MS = "45000";
    const { delays, restore } = captureIntervalDelays();
    const exit = vi.fn();
    try {
      const { stop } = startWorker({
        heartbeatMs: 60_000,
        outboxPollMs: 60_000,
        prefillPollMs: 60_000,
        claimTimeoutMs: 12_000,
        ...inertSendPorts(),
        log: () => undefined,
        exit,
      });
      expect(delays).toContain(12_000);
      expect(delays).not.toContain(45_000);
      stop("SIGTERM");
    } finally {
      restore();
      if (previous === undefined) {
        delete process.env.WORKER_OUTBOX_CLAIM_TIMEOUT_MS;
      } else {
        process.env.WORKER_OUTBOX_CLAIM_TIMEOUT_MS = previous;
      }
    }
    // stop() waits for ticks in flight before it disconnects and exits; the
    // test must not end first, or the disconnect lands after afterEach has
    // removed its stub and reaches the client every test shares.
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(0);
    });
  });

  it("defaults the reclaim interval to 180000 ms", async () => {
    const previous = process.env.WORKER_OUTBOX_CLAIM_TIMEOUT_MS;
    delete process.env.WORKER_OUTBOX_CLAIM_TIMEOUT_MS;
    const { delays, restore } = captureIntervalDelays();
    const exit = vi.fn();
    try {
      const { stop } = startWorker({
        heartbeatMs: 60_000,
        outboxPollMs: 60_000,
        prefillPollMs: 60_000,
        ...inertSendPorts(),
        log: () => undefined,
        exit,
      });
      expect(delays).toContain(180_000);
      stop("SIGTERM");
    } finally {
      restore();
      if (previous === undefined) {
        delete process.env.WORKER_OUTBOX_CLAIM_TIMEOUT_MS;
      } else {
        process.env.WORKER_OUTBOX_CLAIM_TIMEOUT_MS = previous;
      }
    }
    // stop() waits for ticks in flight before it disconnects and exits; the
    // test must not end first, or the disconnect lands after afterEach has
    // removed its stub and reaches the client every test shares.
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(0);
    });
  });

  it("does not start a second incremental Omie pull while the first is in flight", async () => {
    // Same in-flight rule as the reclaim pass, on a separate state object. An
    // Omie pull can outlast its own interval, and overlapping full pulls would
    // duplicate import work against the same rows.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const runOmiePull = vi.fn(async () => {
      calls += 1;
      await held;
    });
    const callbacks: Array<{ ms: number; callback: () => void }> = [];
    const spy = vi.spyOn(globalThis, "setInterval").mockImplementation((
      ((callback: () => void, ms?: number) => {
        callbacks.push({ ms: Number(ms), callback });
        return { unref() { return this; } } as unknown as ReturnType<typeof setInterval>;
      }) as typeof setInterval
    ));
    const exit = vi.fn();
    try {
      const { stop } = startWorker({
        heartbeatMs: 60_000,
        outboxPollMs: 60_000,
        prefillPollMs: 60_000,
        omieIncremental: true,
        omieIncrementalMs: 77_000,
        runOmiePull,
        log: () => undefined,
        exit,
      });
      const tick = callbacks.find((entry) => entry.ms === 77_000)?.callback;
      tick?.();
      await vi.waitFor(() => {
        expect(calls).toBe(1);
      });
      tick?.();
      tick?.();
      expect(calls).toBe(1);

      release();
      stop("SIGTERM");
    } finally {
      spy.mockRestore();
    }
    // stop() waits for ticks in flight before it disconnects and exits; the
    // test must not end first, or the disconnect lands after afterEach has
    // removed its stub and reaches the client every test shares.
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(0);
    });
  });
});

describeWithDatabase("worker against the real stores", () => {
  silenceWorkerDisconnect();

  /**
   * Seeds a unit, a connection and one inbound message, and builds every real
   * store the worker takes on the same transaction.
   *
   * The instance name is generated per test, so nothing the worker writes can
   * reach a base or demo row.
   *
   * @param tx - The test transaction.
   * @returns The connection, the conversation id, and the stores.
   */
  async function setup(tx: DbClient) {
    const unit = await seedUnit(tx);
    const connection = await seedConnection(tx, { unitId: unit.id });
    const store = createIngestStore(kernel.createDb(tx, runInTransactionOnTx(tx)));
    await store.runConversationMessageTransaction({
      whatsappConnectionId: connection.id,
      remoteJid: `${CHAT_KEY}@s.whatsapp.net`,
      chatKey: CHAT_KEY,
      externalMessageId: "in-1",
      direction: "inbound",
      messageType: "text",
      textBody: "oi",
      providerTimestamp: new Date("2026-01-01T00:00:00.000Z"),
    });
    const conversation = await tx.conversation.findUniqueOrThrow({
      where: {
        whatsappConnectionId_chatKey: {
          whatsappConnectionId: connection.id,
          chatKey: CHAT_KEY,
        },
      },
      select: { id: true },
    });
    return {
      connection,
      conversationId: conversation.id,
      store,
      handle: handleOf(tx),
    };
  }

  /**
   * Inserts one outbox row.
   *
   * @param tx - The test transaction.
   * @param conversationId - Conversation the row belongs to.
   * @param textBody - Message body.
   * @param overrides - Status and claim stamp for reclaim cases.
   * @returns The new row's id.
   */
  async function enqueue(
    tx: DbClient,
    conversationId: string,
    textBody: string,
    overrides: { status?: string; claimedAt?: Date | null } = {},
  ): Promise<string> {
    const row = await tx.outboxMessage.create({
      data: {
        conversationId,
        messageType: "text",
        textBody,
        status: overrides.status ?? "queued",
        claimedAt: overrides.claimedAt ?? null,
      },
      select: { id: true },
    });
    return row.id;
  }

  /**
   * Reads the database's own clock, which inside a transaction is fixed.
   *
   * @param tx - The test transaction.
   * @returns The transaction timestamp.
   */
  async function databaseNow(tx: DbClient): Promise<Date> {
    const rows = await tx.$queryRaw<{ now: Date }[]>`SELECT NOW() AS now`;
    return rows[0]!.now;
  }

  /**
   * Reads one outbox row by id.
   *
   * @param tx - The test transaction.
   * @param id - The row id.
   * @returns The row.
   */
  function outboxRow(tx: DbClient, id: string) {
    return tx.outboxMessage.findUniqueOrThrow({ where: { id } });
  }

  /**
   * This connection's messages. A delta, never the whole table.
   *
   * @param tx - The test transaction.
   * @param connectionId - The connection to scope to.
   * @returns The message rows.
   */
  function messagesOf(tx: DbClient, connectionId: string) {
    return tx.message.findMany({
      where: { conversation: { whatsappConnectionId: connectionId } },
    });
  }

  /**
   * Reads one connection row by id.
   *
   * @param tx - The test transaction.
   * @param id - The connection id.
   * @returns The row.
   */
  function connectionRow(tx: DbClient, id: string) {
    return tx.whatsAppConnection.findUniqueOrThrow({ where: { id } });
  }

  it("finishes a send in flight at shutdown, thread insert included, before it exits", () =>
    withTestTransaction(db(), async (tx) => {
      // Shutdown order (3A-channel review, item 3). The drain publishes
      // outbound-sent and the worker's subscriber inserts the thread's message.
      // If stop() removed the subscribers while a send was still in flight, that
      // send would be confirmed with no message — main inserted it directly. So
      // stop() waits for the tick, then unsubscribes, then disconnects and exits.
      const { connection, conversationId, store } = await setup(tx);
      const id = await enqueue(tx, conversationId, "resposta");
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const sendText = vi.fn(async () => {
        await held;
        return {
          ok: true as const,
          externalMessageId: "out-at-shutdown",
          providerTimestamp: new Date("2026-01-01T12:00:00.000Z"),
        };
      });
      const exit = vi.fn();
      const { stop } = startWorker({
        heartbeatMs: 60_000,
        outboxPollMs: 20,
        db: handleOf(tx),
        store,
        evolution: stubEvolution({ sendText }),
        log: () => undefined,
        exit,
      });
      await vi.waitFor(() => {
        expect(sendText).toHaveBeenCalledTimes(1);
      });

      stop("SIGTERM");
      // Give the shutdown every chance to run ahead of the send.
      await new Promise((resolve) => setImmediate(resolve));
      expect(exit).not.toHaveBeenCalled();

      release();
      await vi.waitFor(() => {
        expect(exit).toHaveBeenCalledWith(0);
      });
      expect((await outboxRow(tx, id)).status).toBe("confirmed");
      const outbound = (await messagesOf(tx, connection.id)).filter(
        (row) => row.externalMessageId === "out-at-shutdown",
      );
      expect(outbound).toHaveLength(1);
    }));

  it("keeps retrying ingest while Evolution never answers the heartbeat's reconcile", () =>
    withTestTransaction(db(), async (tx) => {
      // The liveness regression this pins. Every loop is one registry job now,
      // one tick at a time, and the heartbeat's tick is retry THEN reconcile. A
      // reconcile lookup that never answered would hold that tick — and with it
      // every later retry pass — until Node's fetch gave up (300 s). The lookup is
      // bounded (EVOLUTION_CONNECTION_STATE_TIMEOUT_MS; 50 ms here), and a timed-out
      // lookup is a failed one: `{ ok: false }`, stored state untouched.
      //
      // Built so only the bound can pass it. The start-up reconcile runs OUTSIDE
      // the registry, so a hang there proves nothing: Evolution answers at once
      // (a 500, so no row is ever written) until start-up is over, and only then
      // stops answering. The failed event is created AFTER a heartbeat tick is
      // already stuck in a lookup, so its retry needs a LATER tick — which runs
      // only if the stuck one ends. Mutation-checked: dropping the signal from
      // the adapter fails this case.
      const { connection, store } = await setup(tx);
      let hang = false;
      let hungLookups = 0;
      const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
        if (!hang) {
          return Promise.resolve({ ok: false, status: 500, json: async () => ({}) });
        }
        hungLookups += 1;
        return new Promise<never>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        });
      });
      const connectionState = createEvolutionConnectionState({
        baseUrl: "http://evolution.invalid",
        apiKey: "k",
        fetchImpl,
        timeoutMs: 50,
      });
      const logs: string[] = [];
      const exit = vi.fn();
      const { stop } = startWorker({
        heartbeatMs: 20,
        db: handleOf(tx),
        store,
        connectionState,
        log: (message) => logs.push(message),
        exit,
      });

      // Start-up is over once two heartbeats have run their reconcile.
      await vi.waitFor(() => {
        expect(logs.filter((line) => line === "heartbeat").length).toBeGreaterThanOrEqual(2);
      });
      hang = true;
      await vi.waitFor(() => {
        expect(hungLookups).toBeGreaterThanOrEqual(1);
      });
      const { id } = await persistRawEvent(
        store,
        upsertPayload({ instance: connection.instanceName, id: "RETRY-WHILE-HUNG" }),
      );
      await store.markEvent(id, "failed");

      await vi.waitFor(
        async () => {
          const ids = (await messagesOf(tx, connection.id)).map((row) => row.externalMessageId);
          expect(ids).toContain("RETRY-WHILE-HUNG");
        },
        { timeout: 10_000, interval: 50 },
      );
      // And the reconcile kept running too: lookups were abandoned and retried.
      expect(hungLookups).toBeGreaterThan(1);
      expect(
        (await tx.whatsAppConnection.findUniqueOrThrow({ where: { id: connection.id } })).connectionState,
      ).toBe("CONNECTED"); // untouched: seedConnection's state, never overwritten

      stop("SIGTERM");
      await vi.waitFor(() => {
        expect(exit).toHaveBeenCalledWith(0);
      });
    }));

  it("retries a failed ingest on heartbeat", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, store } = await setup(tx);
      const { id } = await persistRawEvent(
        store,
        upsertPayload({ instance: connection.instanceName, id: "RETRY-ME" }),
      );
      await store.markEvent(id, "failed");
      const exit = vi.fn();
      const { stop } = startWorker({
        heartbeatMs: 20,
        db: handleOf(tx),
        store,
        log: () => undefined,
        exit,
      });

      await vi.waitFor(async () => {
        const ids = (await messagesOf(tx, connection.id)).map((row) => row.externalMessageId);
        expect(ids).toContain("RETRY-ME");
      });

      stop("SIGTERM");
      await vi.waitFor(() => {
        expect(exit).toHaveBeenCalledWith(0);
      });
    }));

  it("drains a queued outbox item on the outbox poll", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, conversationId, store } = await setup(tx);
      const id = await enqueue(tx, conversationId, "resposta");
      const sendText = vi.fn(async () => ({
        ok: true as const,
        externalMessageId: "out-hb",
        providerTimestamp: new Date("2026-01-01T12:00:00.000Z"),
      }));
      const logs: string[] = [];
      const exit = vi.fn();
      const { stop } = startWorker({
        heartbeatMs: 60_000,
        outboxPollMs: 20,
        db: handleOf(tx),
        store,
        evolution: stubEvolution({ sendText }),
        log: (message) => logs.push(message),
        exit,
      });

      // Wait for the drain to FINISH, not for the row to read confirmed: the
      // confirm now commits before outbound-sent is published (owner rulings,
      // 2026-09-25), so a confirmed row can precede its thread message. The
      // drain logs this line after the publish returns.
      await vi.waitFor(() => {
        expect(logs).toContain(`outbox confirmed ${id}`);
      });
      expect((await outboxRow(tx, id)).status).toBe("confirmed");
      const outbound = (await messagesOf(tx, connection.id)).filter(
        (row) => row.direction === "outbound",
      );
      expect(outbound).toHaveLength(1);
      expect(outbound[0]?.providerTimestamp).toEqual(new Date("2026-01-01T12:00:00.000Z"));

      stop("SIGTERM");
      await vi.waitFor(() => {
        expect(exit).toHaveBeenCalledWith(0);
      });
    }));

  it("inserts the sent message under its own role while another channel job holds the transaction", () =>
    withTestTransaction(db(), async (tx) => {
      // The intermittent 25P02 4B's root run hit (4A): `permission denied for
      // table message` on the outbound-sent subscriber's INSERT. That insert was a
      // raw write on the shared transaction, not a `db.tx`, so the kernel did not
      // queue it, and it could land while another job's `db.tx("channel")` had
      // SET LOCAL ROLE module_channel on the same transaction. Since 4A it is a
      // `db.tx("conversations")`: queued behind the other job, then run under its
      // own role.
      //
      // Deterministic rather than lucky: the "other job" is opened by a
      // subscriber registered AHEAD of the worker's, on the same outbound-sent
      // event, and is not awaited — so it is mid-transaction exactly when the
      // worker's subscriber runs, and it holds that for 100 ms. Postgres refuses
      // a `message` write under module_channel, so the insert landing is the
      // proof it did not run inside the other job's window.
      const { connection, conversationId, store } = await setup(tx);
      const id = await enqueue(tx, conversationId, "resposta");
      const other = handleOf(tx);
      let otherJob: Promise<void> | null = null;
      let otherJobRan = false;
      const offOther = kernel.subscribe(outboundSent, () => {
        otherJob = other.tx("channel", async (inner) => {
          otherJobRan = true;
          await inner.whatsAppConnection.findUniqueOrThrow({ where: { id: connection.id } });
          await new Promise((resolve) => setTimeout(resolve, 100));
        });
      });
      const logs: string[] = [];
      const sendText = vi.fn(async () => ({
        ok: true as const,
        externalMessageId: "out-while-held",
        providerTimestamp: new Date("2026-01-01T12:00:00.000Z"),
      }));
      const exit = vi.fn();
      const { stop } = startWorker({
        heartbeatMs: 60_000,
        outboxPollMs: 20,
        db: handleOf(tx),
        store,
        evolution: stubEvolution({ sendText }),
        log: (message) => logs.push(message),
        exit,
      });
      try {
        // Wait for the drain to FINISH, not for the row to read confirmed: the
        // confirm now commits before outbound-sent is published (owner rulings,
        // 2026-09-25), so a confirmed row can precede its thread message.
        await vi.waitFor(() => {
          expect(logs).toContain(`outbox confirmed ${id}`);
        });
        expect((await outboxRow(tx, id)).status).toBe("confirmed");
        await otherJob;
        // Precondition: the other job really was open around the insert.
        expect(otherJobRan).toBe(true);
        const outbound = (await messagesOf(tx, connection.id)).filter(
          (row) => row.externalMessageId === "out-while-held",
        );
        expect(outbound).toHaveLength(1);
        expect(logs.filter((line) => /permission denied|error/i.test(line))).toEqual([]);
      } finally {
        offOther();
        stop("SIGTERM");
        await vi.waitFor(() => {
          expect(exit).toHaveBeenCalledWith(0);
        });
      }
    }));

  it("claims a queued item on the outbox poll without running ingest retry", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, conversationId, store } = await setup(tx);
      const outboxId = await enqueue(tx, conversationId, "resposta");
      const { id: eventId } = await persistRawEvent(
        store,
        upsertPayload({ instance: connection.instanceName, id: "retry-later" }),
      );
      await store.markEvent(eventId, "failed");
      const sendText = vi.fn(async () => ({
        ok: true as const,
        externalMessageId: "out-poll",
        providerTimestamp: new Date("2026-01-01T12:00:00.000Z"),
      }));
      const exit = vi.fn();
      const { stop } = startWorker({
        heartbeatMs: 60_000,
        outboxPollMs: 20,
        db: handleOf(tx),
        store,
        evolution: stubEvolution({ sendText }),
        log: () => undefined,
        exit,
      });

      await vi.waitFor(async () => {
        expect((await outboxRow(tx, outboxId)).status).toBe("confirmed");
      });
      // The heartbeat is 60s away, so the failed event is still untouched.
      const ids = (await messagesOf(tx, connection.id)).map((row) => row.externalMessageId);
      expect(ids).not.toContain("retry-later");
      expect((await store.getEvent(eventId))?.status).toBe("failed");

      stop("SIGTERM");
      await vi.waitFor(() => {
        expect(exit).toHaveBeenCalledWith(0);
      });
    }));

  it("runs history backfill once at start when flagged, not on heartbeat", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, store: real } = await setup(tx);
      // The seed gate is a global count, and a db:seed-ed database always has
      // SEED rows; this case is about WHEN the backfill runs, not the gate, so
      // the gate's input is pinned. See note 3.
      const store = { ...real, countSeedOriginMessages: async () => 0 };
      const findChats = vi.fn<(instance: string) => Promise<{ remoteJid: string }[]>>(
        async () => [],
      );
      const findMessagesPage = vi.fn(async () => ({ records: [] as unknown[], hasMore: false }));
      const logs: string[] = [];
      const exit = vi.fn();
      const { stop } = startWorker({
        heartbeatMs: 20,
        db: handleOf(tx),
        store,
        historyBackfill: true,
        history: { findChats, findMessagesPage },
        log: (message) => logs.push(message),
        exit,
      });

      const callsForMine = () =>
        findChats.mock.calls.filter(([name]) => name === connection.instanceName).length;
      await vi.waitFor(() => {
        expect(callsForMine()).toBe(1);
      });
      await vi.waitFor(() => {
        expect(logs.filter((line) => line === "heartbeat").length).toBeGreaterThanOrEqual(2);
      });
      // Two heartbeats later it is still one: backfill runs at start only.
      expect(callsForMine()).toBe(1);
      expect(findMessagesPage).not.toHaveBeenCalled();

      stop("SIGTERM");
      await vi.waitFor(() => {
        expect(exit).toHaveBeenCalledWith(0);
      });
    }));

  it("does not request Evolution history without the backfill flag", () =>
    withTestTransaction(db(), async (tx) => {
      const { store } = await setup(tx);
      const findChats = vi.fn<(instance: string) => Promise<{ remoteJid: string }[]>>(
        async () => [],
      );
      const findMessagesPage = vi.fn(async () => ({ records: [] as unknown[], hasMore: false }));
      const logs: string[] = [];
      const exit = vi.fn();
      const { stop } = startWorker({
        heartbeatMs: 20,
        db: handleOf(tx),
        store,
        history: { findChats, findMessagesPage },
        log: (message) => logs.push(message),
        exit,
      });

      await vi.waitFor(() => {
        expect(logs.filter((line) => line === "heartbeat").length).toBeGreaterThanOrEqual(1);
      });
      expect(findChats).not.toHaveBeenCalled();
      expect(findMessagesPage).not.toHaveBeenCalled();

      stop("SIGTERM");
      await vi.waitFor(() => {
        expect(exit).toHaveBeenCalledWith(0);
      });
    }));

  it("does not request Evolution history when seeded messages exist, even if flagged", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversationId, store } = await setup(tx);
      // A real SEED-origin row, not a fake-only helper. See note 3.
      await tx.message.create({
        data: {
          conversationId,
          externalMessageId: "seed:test:1",
          direction: "inbound",
          messageType: "text",
          textBody: "seeded",
          providerTimestamp: new Date("2026-01-01T00:00:00.000Z"),
          origin: "SEED",
        },
      });
      expect(await store.countSeedOriginMessages()).toBeGreaterThan(0); // precondition
      const findChats = vi.fn<(instance: string) => Promise<{ remoteJid: string }[]>>(
        async () => [],
      );
      const findMessagesPage = vi.fn(async () => ({ records: [] as unknown[], hasMore: false }));
      const logs: string[] = [];
      const exit = vi.fn();
      const { stop } = startWorker({
        heartbeatMs: 20,
        db: handleOf(tx),
        store,
        historyBackfill: true,
        history: { findChats, findMessagesPage },
        log: (message) => logs.push(message),
        exit,
      });

      await vi.waitFor(() => {
        expect(logs).toContain("history backfill skipped: seeded history exists");
      });
      expect(findChats).not.toHaveBeenCalled();
      expect(findMessagesPage).not.toHaveBeenCalled();
      expect(logs).not.toContain("history backfill start");

      stop("SIGTERM");
      await vi.waitFor(() => {
        expect(exit).toHaveBeenCalledWith(0);
      });
    }));

  it("writes CONNECTED from REST open at start without a connection webhook", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, store } = await setup(tx);
      await tx.whatsAppConnection.update({
        where: { id: connection.id },
        data: { connectionState: "DISCONNECTED" },
      });
      const { client, getConnectionState } = reconcileFor(connection.instanceName, () => ({
        ok: true,
        evolutionState: "CONNECTED",
      }));
      const exit = vi.fn();
      const { stop } = startWorker({
        heartbeatMs: 60_000,
        db: handleOf(tx),
        store,
        connectionState: client,
        log: () => undefined,
        exit,
      });

      await vi.waitFor(async () => {
        expect((await connectionRow(tx, connection.id)).connectionState).toBe("CONNECTED");
      });
      expect(
        await tx.webhookEvent.count({ where: { whatsappConnectionId: connection.id } }),
      ).toBe(0);
      expect(getConnectionState).toHaveBeenCalledWith(connection.instanceName);

      stop("SIGTERM");
      await vi.waitFor(() => {
        expect(exit).toHaveBeenCalledWith(0);
      });
    }));

  it("writes DISCONNECTED from REST close on a heartbeat tick", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, store } = await setup(tx);
      // The stored column starts at the OPPOSITE value. `seedConnection` defaults
      // to CONNECTED, so without this the first wait below would pass on the
      // row's initial state and prove nothing: `allowClose` could flip before
      // reconcile had ever run, and the DISCONNECTED assertion would still pass
      // while the CONNECTED->DISCONNECTED transition it claims went untested.
      // Both waits are now transitions only reconcile can cause.
      await tx.whatsAppConnection.update({
        where: { id: connection.id },
        data: { connectionState: "DISCONNECTED" },
      });
      let allowClose = false;
      const { client } = reconcileFor(connection.instanceName, () =>
        allowClose
          ? { ok: true, evolutionState: "DISCONNECTED" }
          : { ok: true, evolutionState: "CONNECTED" },
      );
      const exit = vi.fn();
      const { stop } = startWorker({
        heartbeatMs: 20,
        db: handleOf(tx),
        store,
        connectionState: client,
        log: () => undefined,
        exit,
      });

      await vi.waitFor(async () => {
        expect((await connectionRow(tx, connection.id)).connectionState).toBe("CONNECTED");
      });
      allowClose = true;
      await vi.waitFor(async () => {
        expect((await connectionRow(tx, connection.id)).connectionState).toBe("DISCONNECTED");
      });

      stop("SIGTERM");
      await vi.waitFor(() => {
        expect(exit).toHaveBeenCalledWith(0);
      });
    }));

  it("does not issue a second GET while the first reconcile is still in flight", () =>
    withTestTransaction(db(), async (tx) => {
      const { store } = await setup(tx);
      let resolveFirst: (value: EvolutionConnectionStateResult) => void = () => undefined;
      const first = new Promise<EvolutionConnectionStateResult>((resolve) => {
        resolveFirst = resolve;
      });
      let seen = 0;
      // The FIRST call hangs, whichever connection it is for; every later call
      // refuses, so releasing the hang cannot write a base row.
      const getConnectionState = vi.fn((): Promise<EvolutionConnectionStateResult> => {
        seen += 1;
        return seen === 1 ? first : Promise.resolve({ ok: false });
      });
      const logs: string[] = [];
      const exit = vi.fn();
      const { stop } = startWorker({
        heartbeatMs: 20,
        db: handleOf(tx),
        store,
        connectionState: { getConnectionState } as unknown as EvolutionConnectionState,
        log: (message) => logs.push(message),
        exit,
      });

      await vi.waitFor(() => {
        expect(getConnectionState).toHaveBeenCalledTimes(1);
      });
      await vi.waitFor(() => {
        expect(logs.filter((line) => line === "heartbeat").length).toBeGreaterThanOrEqual(2);
      });
      // Several heartbeats have fired and the first GET is still outstanding.
      expect(getConnectionState).toHaveBeenCalledTimes(1);

      resolveFirst({ ok: false });
      stop("SIGTERM");
      await vi.waitFor(() => {
        expect(exit).toHaveBeenCalledWith(0);
      });
    }));

  // hold-unknown-outcome-sends: a stale claim was left by a drain that stopped
  // mid-send, so it may have reached the customer. It is failed, never resent.
  it("fails a stale claimed row as an unknown outcome and never sends it, without touching other rows", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversationId, store } = await setup(tx);
      const now = await databaseNow(tx);
      // Inside a transaction NOW() is frozen, so these ages never drift and the
      // old 20ms re-stamping interval is unnecessary. See note 4 in the header.
      const stale = await enqueue(tx, conversationId, "stale", {
        status: "claimed",
        claimedAt: new Date(now.getTime() - 10_000),
      });
      const young = await enqueue(tx, conversationId, "young", {
        status: "claimed",
        claimedAt: now,
      });
      const queued = await enqueue(tx, conversationId, "queued");
      const confirmed = await enqueue(tx, conversationId, "done", { status: "confirmed" });
      const sentTexts: string[] = [];
      const sendText = vi.fn(async (input: { text: string }) => {
        sentTexts.push(input.text);
        return {
          ok: true as const,
          externalMessageId: `out-${input.text}`,
          providerTimestamp: new Date("2026-01-01T12:00:00.000Z"),
        };
      });
      const exit = vi.fn();
      const { stop } = startWorker({
        heartbeatMs: 60_000,
        outboxPollMs: 40,
        claimTimeoutMs: 80,
        db: handleOf(tx),
        store,
        evolution: stubEvolution({ sendText }),
        log: () => undefined,
        exit,
      });

      await vi.waitFor(async () => {
        expect(await outboxRow(tx, stale)).toMatchObject({ status: "failed", lastError: "send_outcome_unknown", claimedAt: null });
      });
      await vi.waitFor(async () => {
        expect((await outboxRow(tx, queued)).status).toBe("confirmed");
      });
      expect(sentTexts).not.toContain("stale");
      expect(sentTexts).not.toContain("young");
      expect(sentTexts).not.toContain("done");
      expect((await outboxRow(tx, young)).status).toBe("claimed");
      expect((await outboxRow(tx, confirmed)).status).toBe("confirmed");
      expect(["queued", "confirmed"]).toContain((await outboxRow(tx, queued)).status);

      stop("SIGTERM");
      await vi.waitFor(() => {
        expect(exit).toHaveBeenCalledWith(0);
      });
    }));

  it("does not start a second reclaim while the first is still in flight", () =>
    withTestTransaction(db(), async (tx) => {
      const { store } = await setup(tx);
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let calls = 0;
      // Only the reclaim opens a channel transaction here: the drain's poll is a
      // minute away and there is no reconcile client.
      const heldDb = spyDb(tx, async () => {
        calls += 1;
        await held;
      });
      const logs: string[] = [];
      const exit = vi.fn();
      const { stop } = startWorker({
        heartbeatMs: 20,
        outboxPollMs: 60_000,
        claimTimeoutMs: 20,
        db: heldDb,
        store,
        evolution: stubEvolution({
          async sendText() {
            throw new Error("no send in this case");
          },
        }),
        log: (message) => logs.push(message),
        exit,
      });

      await vi.waitFor(() => {
        expect(calls).toBe(1);
      });
      await vi.waitFor(() => {
        expect(logs.filter((line) => line === "heartbeat").length).toBeGreaterThanOrEqual(2);
      });
      expect(calls).toBe(1);

      release();
      stop("SIGTERM");
      await vi.waitFor(() => {
        expect(exit).toHaveBeenCalledWith(0);
      });
    }));

  it("skips an outbox tick that fires while the previous drain is still in flight", () =>
    withTestTransaction(db(), async (tx) => {
      // whatsapp-channel, "Overlapping tick does not double-claim": a tick firing
      // while the previous tick's drain loop is still dispatching claims nothing,
      // and every queued item is dispatched exactly once. The guard is the kernel
      // job registry's per-job flag around channel's drain-outbox job; the drain
      // loop has none of its own (channel's loop tests pin the registry directly).
      // Removing it double-sends a customer's reply.
      const { connection, conversationId, store } = await setup(tx);
      const id = await enqueue(tx, conversationId, "resposta");
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const sendText = vi.fn(async () => {
        await held;
        return {
          ok: true as const,
          externalMessageId: "out-once",
          providerTimestamp: new Date("2026-01-01T12:00:00.000Z"),
        };
      });
      const logs: string[] = [];
      const exit = vi.fn();
      const { stop } = startWorker({
        heartbeatMs: 20,
        outboxPollMs: 20,
        db: handleOf(tx),
        store,
        evolution: stubEvolution({ sendText }),
        log: (message) => logs.push(message),
        exit,
      });

      // The first tick is now parked inside sendText. Let several more fire.
      await vi.waitFor(() => {
        expect(sendText).toHaveBeenCalledTimes(1);
      });
      await vi.waitFor(() => {
        expect(logs.filter((line) => line === "heartbeat").length).toBeGreaterThanOrEqual(2);
      });
      expect(sendText).toHaveBeenCalledTimes(1);

      release();
      // Wait for the drain to FINISH, not for the row to read confirmed: the
      // confirm now commits before outbound-sent is published (owner rulings,
      // 2026-09-25), so a confirmed row can precede its thread message. The
      // drain logs this line after the publish returns.
      await vi.waitFor(() => {
        expect(logs).toContain(`outbox confirmed ${id}`);
      });
      expect((await outboxRow(tx, id)).status).toBe("confirmed");
      expect(
        (await messagesOf(tx, connection.id)).filter((row) => row.direction === "outbound"),
      ).toHaveLength(1);

      stop("SIGTERM");
      await vi.waitFor(() => {
        expect(exit).toHaveBeenCalledWith(0);
      });
    }));

  it("logs a throwing outbox tick and keeps draining on the next one", () =>
    withTestTransaction(db(), async (tx) => {
      // The catch around the outbox tick is the difference between one bad row
      // and a silent worker: an escaping rejection would leave drainState.inFlight
      // stuck true (the finally still runs, but an unhandled rejection in a timer
      // callback is not recoverable state anyone can see), and nothing would say
      // why sends stopped. Assert both halves — the message names the failure,
      // and a later tick still drains.
      const { conversationId, store } = await setup(tx);
      const id = await enqueue(tx, conversationId, "resposta");
      let failures = 0;
      // The first channel transaction is the drain's claim: nothing else here
      // opens one before it (no reconcile client, reclaim five minutes away).
      const flakyDb = spyDb(tx, async () => {
        if (failures === 0) {
          failures += 1;
          throw new Error("claim boom");
        }
      });
      const sendText = vi.fn(async () => ({
        ok: true as const,
        externalMessageId: "out-after-throw",
        providerTimestamp: new Date("2026-01-01T12:00:00.000Z"),
      }));
      const logs: string[] = [];
      const exit = vi.fn();
      const { stop } = startWorker({
        heartbeatMs: 60_000,
        outboxPollMs: 20,
        db: flakyDb,
        store,
        evolution: stubEvolution({ sendText }),
        log: (message) => logs.push(message),
        exit,
      });

      await vi.waitFor(() => {
        expect(logs.some((line) => line.includes("outbox failed claim boom"))).toBe(true);
      });
      await vi.waitFor(async () => {
        expect((await outboxRow(tx, id)).status).toBe("confirmed");
      });

      stop("SIGTERM");
      await vi.waitFor(() => {
        expect(exit).toHaveBeenCalledWith(0);
      });
    }));

  it("logs a throwing ingest retry and keeps the heartbeat alive", () =>
    withTestTransaction(db(), async (tx) => {
      // whatsapp-channel's bounded-retry requirement exists so a poison event
      // stops after max attempts rather than wedging the loop. If the retry pass
      // itself throws, that catch is what keeps the heartbeat — and the
      // connection reconcile that runs after it on the same tick — alive.
      const { store: real } = await setup(tx);
      const store = {
        ...real,
        async listRetryableEvents(): Promise<never> {
          throw new Error("retry boom");
        },
      };
      const logs: string[] = [];
      const exit = vi.fn();
      const { stop } = startWorker({
        heartbeatMs: 20,
        db: handleOf(tx),
        store,
        log: (message) => logs.push(message),
        exit,
      });

      await vi.waitFor(() => {
        expect(logs.some((line) => line.includes("retry failed retry boom"))).toBe(true);
      });
      await vi.waitFor(() => {
        expect(logs.filter((line) => line === "heartbeat").length).toBeGreaterThanOrEqual(2);
      });

      stop("SIGTERM");
      await vi.waitFor(() => {
        expect(exit).toHaveBeenCalledWith(0);
      });
    }));

  it("logs a non-Error rejection as unknown rather than crashing the tick", () =>
    withTestTransaction(db(), async (tx) => {
      // Every loop's catch narrows with `error instanceof Error ? error.message :
      // "unknown"`. The line report shows those lines as covered — the tests
      // above all throw real Errors — but the `"unknown"` arm was untaken on all
      // five, which only a branch-arm reading reveals. A promise can reject with
      // anything, and reading `.message` off a string would log `undefined`
      // instead of naming the loop that failed.
      const { store } = await setup(tx);
      const rejectingDb = spyDb(tx, async () => {
        throw "not an error object";
      });
      const logs: string[] = [];
      const exit = vi.fn();
      const { stop } = startWorker({
        heartbeatMs: 60_000,
        outboxPollMs: 20,
        db: rejectingDb,
        store,
        evolution: stubEvolution({
          async sendText() {
            throw new Error("unreachable");
          },
        }),
        log: (message) => logs.push(message),
        exit,
      });

      await vi.waitFor(() => {
        expect(logs).toContain("outbox failed unknown");
      });

      stop("SIGTERM");
      await vi.waitFor(() => {
        expect(exit).toHaveBeenCalledWith(0);
      });
    }));

  it("runs the scheduled due tick and outcome sync around each outbox drain", () =>
    withTestTransaction(db(), async (tx) => {
      // scheduled-messages rides the outbox poll: recoverStaleProcessing +
      // dispatchDue BEFORE the drain (so a due row has an outbox item to claim on
      // this same tick), and syncOutboxOutcomes AFTER it (so the schedule sees the
      // outcome the drain just recorded). Ordering is the assertion — running
      // sync first would report the previous tick's result and leave a due
      // schedule a full poll behind. The REAL adapter is wrapped rather than
      // replaced, so the order recorded is the order production is driven in.
      const { store } = await setup(tx);
      const realScheduled = createScheduledDue(handleOf(tx));
      const calls: string[] = [];
      const scheduled = {
        async recoverStaleProcessing(now: Date, staleMs: number) {
          calls.push("recover");
          return realScheduled.recoverStaleProcessing(now, staleMs);
        },
        async dispatchDue(now: Date) {
          calls.push("dispatch");
          return realScheduled.dispatchDue(now);
        },
        async syncOutboxOutcomes() {
          calls.push("sync");
          return realScheduled.syncOutboxOutcomes();
        },
      };
      const exit = vi.fn();
      const { stop } = startWorker({
        heartbeatMs: 60_000,
        outboxPollMs: 20,
        db: handleOf(tx),
        store,
        scheduled,
        evolution: stubEvolution({
          async sendText() {
            throw new Error("no queued item to send in this test");
          },
        }),
        log: () => undefined,
        exit,
      });

      await vi.waitFor(() => {
        expect(calls).toContain("sync");
      });
      expect(calls.slice(0, 3)).toEqual(["recover", "dispatch", "sync"]);

      stop("SIGTERM");
      await vi.waitFor(() => {
        expect(exit).toHaveBeenCalledWith(0);
      });
    }));

  it("does not claim on the outbox tick when a required port is missing", () =>
    withTestTransaction(db(), async (tx) => {
      // The degradation path: index.ts wires store/outbox/evolution to null when
      // DATABASE_URL is unset, so the timer still fires with ports absent. It must
      // no-op rather than throw once per second forever.
      const { store } = await setup(tx);
      // Counts every channel transaction: the drain's claim would be the first.
      const claimQueued = vi.fn(async () => undefined);
      const logs: string[] = [];
      const exit = vi.fn();
      const { stop } = startWorker({
        // A short heartbeat gives a POSITIVE signal that time has passed and
        // timers are firing, instead of sleeping and hoping.
        heartbeatMs: 20,
        outboxPollMs: 20,
        db: spyDb(tx, claimQueued),
        store,
        // evolution omitted: the third of the three required ports.
        log: (message) => logs.push(message),
        exit,
      });

      await vi.waitFor(() => {
        expect(logs.filter((line) => line === "heartbeat").length).toBeGreaterThanOrEqual(3);
      });
      expect(claimQueued).not.toHaveBeenCalled();
      expect(logs.some((line) => line.includes("outbox failed"))).toBe(false);

      stop("SIGTERM");
      await vi.waitFor(() => {
        expect(exit).toHaveBeenCalledWith(0);
      });
    }));

  it("logs when the connection-state reconcile throws and keeps the heartbeat alive", () =>
    withTestTransaction(db(), async (tx) => {
      // reconcileConnectionState is documented to absorb a failed GET and leave
      // the stored state alone, so its own port returns { ok: false } rather than
      // throwing. A THROW is the other path — the store rejecting, say — and it
      // must not kill the heartbeat, or ingest retry stops with it.
      const { store } = await setup(tx);
      const getConnectionState = vi.fn(async (): Promise<never> => {
        throw new Error("reconcile boom");
      });
      const logs: string[] = [];
      const exit = vi.fn();
      const { stop } = startWorker({
        heartbeatMs: 20,
        db: handleOf(tx),
        store,
        connectionState: { getConnectionState } as unknown as EvolutionConnectionState,
        log: (message) => logs.push(message),
        exit,
      });

      await vi.waitFor(() => {
        expect(logs.some((line) => line.includes("connection state reconcile failed"))).toBe(true);
      });
      expect(logs.some((line) => line.includes("reconcile boom"))).toBe(true);
      await vi.waitFor(() => {
        expect(logs.filter((line) => line === "heartbeat").length).toBeGreaterThanOrEqual(2);
      });

      stop("SIGTERM");
      await vi.waitFor(() => {
        expect(exit).toHaveBeenCalledWith(0);
      });
    }));

  it("runs the prefill enqueue then the drain on the prefill poll", () =>
    withTestTransaction(db(), async (tx) => {
      // assistive-prefill rides its own timer, not the outbox poll. Nothing
      // exercised that timer, so wiring it to the wrong interval — or dropping
      // the drain that follows the enqueue — failed no test. Order matters: the
      // drain must see the job the enqueue just created, on the same tick.
      const { store } = await setup(tx);
      // The prefill module's job port over this transaction (4C); the scan is
      // `enqueue`, the claim the first thing `drain` does.
      const realPrefill = createPrefillJob(handleOf(tx), offlineGenerate);
      const calls: string[] = [];
      const prefill = {
        async enqueue(now: Date) {
          calls.push("scan");
          return realPrefill.enqueue(now);
        },
        async drain() {
          calls.push("claim");
          return realPrefill.drain();
        },
      };
      const exit = vi.fn();
      const { stop } = startWorker({
        heartbeatMs: 60_000,
        outboxPollMs: 60_000,
        prefillPollMs: 20,
        db: handleOf(tx),
        store,
        prefill,
        log: () => undefined,
        exit,
      });

      await vi.waitFor(() => {
        expect(calls).toContain("claim");
      });
      expect(calls.slice(0, 2)).toEqual(["scan", "claim"]);

      stop("SIGTERM");
      await vi.waitFor(() => {
        expect(exit).toHaveBeenCalledWith(0);
      });
    }));

  it("logs a throwing prefill tick without stopping the loop", () =>
    withTestTransaction(db(), async (tx) => {
      const { store } = await setup(tx);
      const realPrefill = createPrefillJob(handleOf(tx), offlineGenerate);
      const prefill = {
        ...realPrefill,
        async enqueue(): Promise<never> {
          throw new Error("prefill boom");
        },
      };
      const logs: string[] = [];
      const exit = vi.fn();
      const { stop } = startWorker({
        heartbeatMs: 60_000,
        outboxPollMs: 60_000,
        prefillPollMs: 20,
        db: handleOf(tx),
        store,
        prefill,
        log: (message) => logs.push(message),
        exit,
      });

      await vi.waitFor(() => {
        expect(logs.some((line) => line.includes("prefill failed prefill boom"))).toBe(true);
      });

      stop("SIGTERM");
      await vi.waitFor(() => {
        expect(exit).toHaveBeenCalledWith(0);
      });
    }));

  it("logs when the reclaim pass throws", () =>
    withTestTransaction(db(), async (tx) => {
      const { store } = await setup(tx);
      // Only the reclaim opens a channel transaction: the drain's poll is a
      // minute away.
      const failingDb = spyDb(tx, async () => {
        throw new Error("reclaim boom");
      });
      const logs: string[] = [];
      const exit = vi.fn();
      const { stop } = startWorker({
        heartbeatMs: 60_000,
        outboxPollMs: 60_000,
        claimTimeoutMs: 20,
        db: failingDb,
        store,
        evolution: stubEvolution({
          async sendText() {
            throw new Error("no send in this case");
          },
        }),
        log: (message) => logs.push(message),
        exit,
      });

      await vi.waitFor(() => {
        expect(logs.some((line) => line.includes("outbox reclaim failed"))).toBe(true);
      });

      stop("SIGTERM");
      await vi.waitFor(() => {
        expect(exit).toHaveBeenCalledWith(0);
      });
    }));
});

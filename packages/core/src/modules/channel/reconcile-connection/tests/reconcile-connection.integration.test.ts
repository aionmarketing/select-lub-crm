/**
 * Test design (testing-strategy)
 *
 * Setup: `reconcileConnection(db, connectionState, clock?)` through the slice's entry
 * point, on the worktree database inside a rolling-back test transaction
 * (`withTestTransaction`), plus a stub `EvolutionConnectionState.getConnectionState`.
 * No HTTP, no worker timers.
 *
 * Ran under module role: `channel` (the list and each write run on
 * `db.tx("channel")`).
 *
 * Moved from apps/worker/src/ingest/reconcile.test.ts (adopt-modular-vertical-slices
 * 3A), all 5 cases, assertions unchanged. "The store" below now means the slice's
 * own two queries, which were the ingest store's `listConnections` and
 * `updateConnectionState` and read and write the same rows the same way.
 *
 * Spec (openspec/changes/reconcile-connection-state/specs/whatsapp-channel/spec.md):
 * REST open/connecting/close map to CONNECTED/CONNECTING/DISCONNECTED; failed
 * or unrecognized GET leaves stored state; reconcile writes no conversation,
 * message, or webhook-event row.
 *
 * FAKE-ONLY ASSERTION SURFACED (route-tests-on-real-database, D10).
 * The old file asserted `expect(getConnectionState).toHaveBeenCalledTimes(1)`.
 * That only held because the fake's `listConnections()` returned exactly the one
 * connection the test had seeded. The Prisma adapter's `listConnections()` has no
 * `where` at all — it returns every row in the table — so on the real adapter the
 * stub is called once per connection the worktree database holds (the pristine
 * base plus the demo seed's four, plus this test's own). The assertion is
 * corrected to the real behaviour: the stub is called for EVERY instance name this
 * test created, three of them, and for at least that many. That is the fact the old
 * assertion was reaching for — reconcile polls everything it lists — stated in a
 * form that is true of the adapter rather than of the fake, and true whether or not
 * the demo seed has been applied (it is applied by the ROOT vitest config's
 * globalSetup, so a run started from a package config sees none of it).
 *
 * Consequence for the stub, and why it matters beyond this file: because the unit
 * really does iterate every connection in the database, a stub answering
 * `{ ok: true }` for all of them would make reconcile UPDATE the shared base rows
 * inside this test's transaction, taking row locks that every other file running
 * in parallel against the same database would then wait on (design.md Risks, "a
 * long-running test holds row locks"). The stub therefore answers `{ ok: false }`
 * for every instance but this test's own, so the only row written is one this test
 * created.
 *
 * Axes
 *   1. GET result — ok open / ok close / ok false (failed or unrecognized)
 *   2. prior row — DISCONNECTED vs CONNECTED
 *
 * Decisions (reconcileConnection, formerly ingest/reconcile.ts)
 *   D1 result.ok         — write vs continue
 *   D2 evolutionState    — CONNECTED vs DISCONNECTED (connecting sampled via client)
 *   D3 other connections — listed and polled, not filtered out
 *
 *   it                                           | D1 | D2        | D3
 *   REST open writes CONNECTED, no inbox rows    | T  | CONNECTED | T
 *   REST close writes DISCONNECTED               | T  | DISCONN   | T
 *   failed GET leaves prior DISCONNECTED         | F  | -         | T
 *   unrecognized (ok false) leaves prior         | F  | -         | T
 *   polls every listed connection, not just one  | F  | -         | T
 *
 * Observation time (owner rulings, 2026-09-25): each answer is written as
 * observed just before its own probe, and only when newer than the stored
 * observation.
 *   D4 stored state_observed_at newer than the probe — kept vs written
 *   D5 the clock is read per connection, before that connection's probe
 *
 *   it                                                   | D4      | D5
 *   stamps state_observed_at with the probe's start      | written | -
 *   leaves a state observed after the probe started     | kept    | -
 *   reads the clock before each connection's own probe  | -       | T
 *
 * Counts are deltas, never absolutes (design.md D9): the conversation, message and
 * webhook-event assertions scope to rows reachable from this test's own
 * connection, because the database also holds the pristine base and the demo seed.
 *
 * Out of scope: live Evolution GET (internal/evolution.test.ts); the heartbeat
 * job that runs it (apps/worker/test/worker.test.ts).
 */
import { prisma, type PrismaClient } from "@select-lub/core/db";
import {
  describeWithDatabase,
  runInTransactionOnTx,
  seedConnection,
  seedUnit,
  withTestTransaction,
} from "../../../../testing/index.js";
import { expect, it, vi } from "vitest";
import { createDb } from "../../../../kernel/db.js";
import { reconcileConnection, type EvolutionConnectionStateResult } from "../index.js";

const db = () => prisma as PrismaClient;

/**
 * Answers `getConnectionState` for one instance name and refuses every other.
 *
 * Refusing the rest is deliberate; see the fake-only note in the header. It keeps
 * reconcile's writes inside this test's own rows while still letting the unit walk
 * the full connection list the adapter really returns.
 *
 * @param instanceName - The one instance this stub answers for.
 * @param result - What to answer for that instance.
 * @returns A spy usable as `EvolutionConnectionState.getConnectionState`.
 */
function stubFor(instanceName: string, result: EvolutionConnectionStateResult) {
  return vi.fn(
    async (name: string): Promise<EvolutionConnectionStateResult> =>
      name === instanceName ? result : { ok: false },
  );
}

describeWithDatabase("reconcile-connection", () => {
  it("writes CONNECTED from REST open without inbox or webhook rows", () =>
    withTestTransaction(db(), async (tx) => {
      const unit = await seedUnit(tx);
      const connection = await seedConnection(tx, {
        unitId: unit.id,
        connectionState: "DISCONNECTED",
      });
      const handle = createDb(tx, runInTransactionOnTx(tx));
      const getConnectionState = stubFor(connection.instanceName, {
        ok: true,
        evolutionState: "CONNECTED",
      });

      await reconcileConnection(handle, { getConnectionState }, () => new Date("2026-08-28T12:00:00.000Z"));

      const row = await tx.whatsAppConnection.findUniqueOrThrow({
        where: { id: connection.id },
      });
      expect(row.connectionState).toBe("CONNECTED");
      expect(row.lastConnectedAt).toEqual(new Date("2026-08-28T12:00:00.000Z"));
      expect(getConnectionState).toHaveBeenCalledWith(connection.instanceName);

      // Deltas, not absolutes: only rows reachable from this test's connection.
      expect(
        await tx.conversation.count({ where: { whatsappConnectionId: connection.id } }),
      ).toBe(0);
      expect(
        await tx.message.count({
          where: { conversation: { whatsappConnectionId: connection.id } },
        }),
      ).toBe(0);
      expect(
        await tx.webhookEvent.count({ where: { whatsappConnectionId: connection.id } }),
      ).toBe(0);
    }));

  it("writes DISCONNECTED from REST close", () =>
    withTestTransaction(db(), async (tx) => {
      const unit = await seedUnit(tx);
      const connection = await seedConnection(tx, {
        unitId: unit.id,
        connectionState: "CONNECTED",
      });
      const handle = createDb(tx, runInTransactionOnTx(tx));

      await reconcileConnection(handle, {
          getConnectionState: stubFor(connection.instanceName, {
            ok: true,
            evolutionState: "DISCONNECTED",
          }),
        }, () => new Date("2026-08-28T12:00:00.000Z"));

      const row = await tx.whatsAppConnection.findUniqueOrThrow({
        where: { id: connection.id },
      });
      expect(row.connectionState).toBe("DISCONNECTED");
      expect(row.lastDisconnectedAt).toEqual(new Date("2026-08-28T12:00:00.000Z"));
    }));

  it("leaves stored state when GET fails", () =>
    withTestTransaction(db(), async (tx) => {
      const unit = await seedUnit(tx);
      const connection = await seedConnection(tx, {
        unitId: unit.id,
        connectionState: "DISCONNECTED",
      });
      const handle = createDb(tx, runInTransactionOnTx(tx));
      const before = await tx.whatsAppConnection.findUniqueOrThrow({
        where: { id: connection.id },
      });
      expect(before.lastConnectedAt).toBeNull(); // precondition

      await reconcileConnection(handle, { getConnectionState: async () => ({ ok: false }) });

      const row = await tx.whatsAppConnection.findUniqueOrThrow({
        where: { id: connection.id },
      });
      expect(row.connectionState).toBe("DISCONNECTED");
      expect(row.lastConnectedAt).toBeNull();
    }));

  it("leaves stored state when the success body was unrecognized (ok false)", () =>
    withTestTransaction(db(), async (tx) => {
      const unit = await seedUnit(tx);
      const connection = await seedConnection(tx, {
        unitId: unit.id,
        connectionState: "CONNECTED",
      });
      const handle = createDb(tx, runInTransactionOnTx(tx));

      await reconcileConnection(handle, { getConnectionState: async () => ({ ok: false }) });

      const row = await tx.whatsAppConnection.findUniqueOrThrow({
        where: { id: connection.id },
      });
      expect(row.connectionState).toBe("CONNECTED");
    }));

  it("polls every connection the store lists, not only the one under test", () =>
    withTestTransaction(db(), async (tx) => {
      const unit = await seedUnit(tx);
      // Three of this test's own, so the assertion holds whatever else the
      // database contains. The demo seed is not a dependency: it is applied by
      // the ROOT vitest config's globalSetup, so a run started from a package
      // config sees an unseeded database, and a change to the seed must not be
      // able to move this number.
      const mine = await Promise.all([
        seedConnection(tx, { unitId: unit.id, connectionState: "DISCONNECTED" }),
        seedConnection(tx, { unitId: unit.id, connectionState: "DISCONNECTED" }),
        seedConnection(tx, { unitId: unit.id, connectionState: "DISCONNECTED" }),
      ]);
      const handle = createDb(tx, runInTransactionOnTx(tx));
      // Answers for no instance at all, so nothing is written; the spy still
      // records which names reconcile walked.
      const getConnectionState = stubFor("never-matches-any-connection", { ok: false });

      await reconcileConnection(handle, { getConnectionState });

      const polled = getConnectionState.mock.calls.map(([name]) => name);
      for (const connection of mine) {
        expect(polled).toContain(connection.instanceName);
      }
      // The fake returned only what the test seeded one row at a time, so the old
      // file could assert exactly one call. The adapter lists the whole table, so
      // this is at least the three created here and more on a seeded database.
      expect(polled.length).toBeGreaterThanOrEqual(mine.length);
    }));

  it("stamps state_observed_at with the instant before the probe", () =>
    withTestTransaction(db(), async (tx) => {
      const unit = await seedUnit(tx);
      const connection = await seedConnection(tx, { unitId: unit.id, connectionState: "DISCONNECTED" });
      const handle = createDb(tx, runInTransactionOnTx(tx));
      const probeStart = new Date("2026-08-28T12:00:00.000Z");

      await reconcileConnection(
        handle,
        { getConnectionState: stubFor(connection.instanceName, { ok: true, evolutionState: "CONNECTED" }) },
        () => probeStart,
      );

      const row = await tx.whatsAppConnection.findUniqueOrThrow({ where: { id: connection.id } });
      expect(row.connectionState).toBe("CONNECTED");
      expect(row.stateObservedAt).toEqual(probeStart);
    }));

  it("leaves a state observed after the probe started, and its stamps", () =>
    withTestTransaction(db(), async (tx) => {
      // A connection.update the CRM received while the probe was in flight is
      // newer information than the probe's answer.
      const unit = await seedUnit(tx);
      const connection = await seedConnection(tx, { unitId: unit.id, connectionState: "CONNECTED" });
      const received = new Date("2026-08-28T12:00:05.000Z");
      await tx.whatsAppConnection.update({
        where: { id: connection.id },
        data: { stateObservedAt: received, lastConnectedAt: received },
      });
      const handle = createDb(tx, runInTransactionOnTx(tx));

      await reconcileConnection(
        handle,
        { getConnectionState: stubFor(connection.instanceName, { ok: true, evolutionState: "DISCONNECTED" }) },
        () => new Date("2026-08-28T12:00:00.000Z"),
      );

      const row = await tx.whatsAppConnection.findUniqueOrThrow({ where: { id: connection.id } });
      expect(row.connectionState).toBe("CONNECTED");
      expect(row.stateObservedAt).toEqual(received);
      expect(row.lastDisconnectedAt).toBeNull();
    }));

  it("reads the clock before each connection's own probe", () =>
    withTestTransaction(db(), async (tx) => {
      const unit = await seedUnit(tx);
      const mine = await Promise.all([
        seedConnection(tx, { unitId: unit.id, connectionState: "DISCONNECTED" }),
        seedConnection(tx, { unitId: unit.id, connectionState: "DISCONNECTED" }),
      ]);
      const handle = createDb(tx, runInTransactionOnTx(tx));
      const events: string[] = [];
      let tick = 0;
      const clock = () => {
        tick += 1;
        events.push(`clock-${tick}`);
        return new Date(Date.UTC(2026, 7, 28, 12, 0, tick));
      };
      const names = new Set(mine.map((row) => row.instanceName));
      const getConnectionState = vi.fn(async (name: string): Promise<EvolutionConnectionStateResult> => {
        events.push(`probe-${tick}`);
        return names.has(name) ? { ok: true, evolutionState: "CONNECTED" } : { ok: false };
      });

      await reconcileConnection(handle, { getConnectionState }, clock);

      // Every probe is preceded by its own clock read, never by a shared one.
      expect(events.length).toBe(2 * getConnectionState.mock.calls.length);
      events.forEach((event, index) => {
        const n = Math.floor(index / 2) + 1;
        expect(event).toBe(index % 2 === 0 ? `clock-${n}` : `probe-${n}`);
      });
      // Each of this test's rows carries its own probe's time, so they differ.
      const rows = await tx.whatsAppConnection.findMany({ where: { id: { in: mine.map((row) => row.id) } } });
      const stamps = rows.map((row) => row.stateObservedAt?.getTime());
      expect(new Set(stamps).size).toBe(2);
      expect(stamps.every((time) => time !== undefined && time > Date.UTC(2026, 7, 28, 12, 0, 0))).toBe(true);
    }));
});

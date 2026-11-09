/**
 * Test design (testing-strategy)
 *
 * SUT: `GET /channel/status` through the slice's `route`, on a slice app over
 *   the worktree database inside a rolling-back transaction.
 *
 * Ran under module role: `channel` (the read runs on `db.tx("channel")`).
 *
 * Moved from apps/api/src/conversations/prisma.test.ts (adopt-modular-vertical-slices
 * 3A): its two `channelStatus` cases, which ran over a hand-built fake
 * PrismaClient. Here they run on a real `whatsapp_connection` row, through the
 * route rather than a store method, because the store method is gone. The
 * route's cases behind the auth hook — the stored column moves the badge, and
 * the column and the live probe may disagree — stay in apps/api/src/conversations.test.ts.
 *
 * Oracle: conversas-inbox-completeness D1/D3 — the status reads the canonical
 *   `connectionState` column, and is DISCONNECTED when no connection row exists.
 *
 * Axes: A1 connection row for the configured instance — present (state X) /
 *   absent. Sampled with CONNECTING, a state the old default could not produce.
 */
import { randomUUID } from "node:crypto";
import { prisma, type PrismaClient } from "@select-lub/core/db";
import { expect, it } from "vitest";
import { createDb, type DbClient } from "../../../../kernel/db.js";
import { registerSlice } from "../../../../kernel/http.js";
import {
  buildSliceApp,
  describeWithDatabase,
  runInTransactionOnTx,
  seedConnection,
  seedUnit,
  withTestTransaction,
} from "../../../../testing/index.js";
import { route } from "../index.js";

const db = () => prisma as PrismaClient;

async function statusFor(tx: DbClient, instanceName: string) {
  const app = await buildSliceApp({
    db: createDb(tx, runInTransactionOnTx(tx)),
    plugin: (built) => registerSlice(built, "channel", "get-channel-status", route({ instanceName: () => instanceName })),
  });
  try {
    const response = await app.inject({ method: "GET", url: "/channel/status" });
    return { statusCode: response.statusCode, body: response.json() as unknown };
  } finally {
    await app.close();
  }
}

describeWithDatabase("GET /channel/status", () => {
  it("reads the configured connection row's state", () =>
    withTestTransaction(db(), async (tx) => {
      const unit = await seedUnit(tx);
      const connection = await seedConnection(tx, { unitId: unit.id, connectionState: "CONNECTING" });

      expect(await statusFor(tx, connection.instanceName)).toEqual({
        statusCode: 200,
        body: { state: "CONNECTING" },
      });
    }));

  it("returns DISCONNECTED when no connection row exists", () =>
    withTestTransaction(db(), async (tx) => {
      expect(await statusFor(tx, `absent-${randomUUID()}`)).toEqual({
        statusCode: 200,
        body: { state: "DISCONNECTED" },
      });
    }));
});

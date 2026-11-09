/**
 * Test design (testing-strategy)
 *
 * Setup: live Prisma when DATABASE_URL is set. This file creates its OWN unit,
 * connection and conversations with inbound times relative to now. Everything
 * is namespaced by a run id and deleted in teardown; nothing is truncated.
 *
 * Runs under module role: `module_reports` — `reportConversations` opens its
 * own transaction through `db.tx("reports", …)` on the committed client. The
 * fixture rows are committed by the login role, outside any module role.
 *
 * Moved from `apps/api/src/reports.seeded-period.live.test.ts`
 * (adopt-modular-vertical-slices 2C). Its one case is unchanged except that it
 * asks the slice's `reportConversations` instead of the deleted
 * `createPrismaReportsStore(prisma).summary`; the unanswered-quote port is a
 * recording stand-in, since this case asserts nothing about quotes. It stays a
 * live file, not a harness one: its point is a report over COMMITTED rows whose
 * times are relative to now.
 *
 * The unit leak stays fixed, and is now asserted rather than trusted (memory:
 * reports-live-tests-leak-a-unit-per-run). This file used to create its unit and
 * never delete it, so every run left one behind — 204 were found in one worktree
 * database. `afterAll` now asserts that the unit and the connection this run
 * created are gone after cleanup. It asserts on THIS run's rows rather than on a
 * database-wide `unit` count, because CI's coverage run executes other live
 * files in parallel and they commit units of their own; a global count would
 * move for reasons that are not this file's.
 *
 * Isolation: do not call `seedDemoDataset` from this file. That function upserts
 * global demo ids (`demo-cust-01`, prefill rows, users). CI runs this suite in
 * the same `selectlub_test` database as `demo-seed.live.test.ts`, in parallel;
 * two seeds writing those ids produced P2002 on `CadastroPrefillSuggestion` and
 * `user.email`. Seed date anchoring is asserted in `demo-seed.live.test.ts`.
 * This file only asks the report.
 *
 * Oracle: demo-seed — "Reports at their default period have data". Real
 * conversations are current by construction; a report of the last seven days
 * must count them, and a window long before them must not.
 *
 * Axes
 *   A1 period — the default window ending now vs a window long before the data
 *   A2 conversation recency — created relative to now, as real ones always are
 *
 * Outputs
 *   O1 the default window reports a non-zero new-conversation count
 *   O2 a window that predates every conversation reports zero
 *   O3 (teardown) no unit or connection of this run survives
 *
 * O2 is the resolution check. Without it O1 passes against a report that counts
 * every conversation regardless of period — which is indistinguishable from the
 * fix, because a report ignoring its own window also looks non-empty.
 *
 * Out of scope: aggregate branches (internal/*.test.ts) and unit scoping
 * (report-conversations.integration.test.ts). This file asserts one thing: the
 * default period is not empty when conversations are current.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { shouldRunLiveTests } from "@select-lub/core/db";
import { createDb } from "../../../../kernel/index.js";
import { withConnectRetry } from "../../../../testing/index.js";
import { reportConversations } from "../index.js";
import { recordingPorts } from "./report-app.fixture.js";

// tests -> report-conversations -> reports -> modules -> src -> core -> packages -> repo
const repoRoot = resolve(import.meta.dirname, "../../../../../../..");
const envPath = resolve(repoRoot, ".env");
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

const live = shouldRunLiveTests();

describe.skipIf(!live)("live reports at the seeded default period", () => {
  const runId = randomUUID().replace(/\D/g, "").slice(0, 6).padEnd(6, "0");
  let prisma!: NonNullable<(typeof import("@select-lub/core/db"))["prisma"]>;
  let unitId = "";
  let connectionId = "";
  const conversationIds: string[] = [];

  beforeAll(async () => {
    const db = await import("@select-lub/core/db");
    const client = db.prisma;
    if (!client) {
      throw new Error("expected PrismaClient when DATABASE_URL is set");
    }
    prisma = withConnectRetry(client);

    // This run's OWN unit and connection. Using the shared live instance would
    // put this file on the same rows reports.live.test.ts seeds and asserts, and
    // vitest runs files in parallel.
    const unit = await prisma.unit.create({ data: { name: `rpt-seed-${runId}` } });
    unitId = unit.id;
    const connection = await prisma.whatsAppConnection.create({
      data: {
        unitId,
        instanceName: `rpt-seed-conn-${runId}`,
        provider: "EVOLUTION_BAILEYS",
      },
    });
    connectionId = connection.id;

    // Recent conversations, positioned relative to NOW — the property real
    // conversations always have and the fixed anchor never did.
    for (let index = 0; index < 6; index += 1) {
      const inbound = new Date(Date.now() - (index + 1) * 6 * 60 * 60 * 1000);
      const created = await prisma.conversation.create({
        data: {
          whatsappConnectionId: connection.id,
          remoteJid: `5514${runId}${String(index).padStart(3, "0")}@s.whatsapp.net`,
          chatKey: `5514${runId}${String(index).padStart(3, "0")}`,
          startedAt: inbound,
          firstInboundAt: inbound,
          firstOutboundAt: new Date(inbound.getTime() + 30 * 60_000),
          lastMessageAt: inbound,
        },
      });
      conversationIds.push(created.id);
    }

  }, 300_000);

  // Deletes in dependency order — conversations, then the connection, then the
  // unit the connection pointed at — and then proves it: the unit was the one
  // row this file used to leave behind on every run.
  afterAll(async () => {
    if (conversationIds.length > 0) {
      await prisma.conversation.deleteMany({ where: { id: { in: conversationIds } } });
    }
    if (connectionId) {
      await prisma.whatsAppConnection.deleteMany({ where: { id: connectionId } });
    }
    if (unitId) {
      await prisma.unit.deleteMany({ where: { id: unitId } });
    }
    expect(await prisma.unit.count({ where: { name: `rpt-seed-${runId}` } })).toBe(0);
    expect(
      await prisma.whatsAppConnection.count({ where: { instanceName: `rpt-seed-conn-${runId}` } }),
    ).toBe(0);
  });

  it("reports data for the window the screen opens on, and none for one before it", async () => {
    const db = createDb(prisma);
    const { ports } = recordingPorts();
    const now = new Date();

    // O1. The default period Relatórios opens on: the last seven days.
    const current = await reportConversations(db, {
      unitId,
      query: {
        periodStart: new Date(now.getTime() - 7 * 86_400_000).toISOString(),
        periodEnd: now.toISOString(),
        granularity: "day",
      },
    }, ports);
    expect(current.newConversationCount).toBeGreaterThan(0);

    // O2. Resolution check: a window ending long before any conversation began
    // must report nothing. Without this, O1 would also pass against a report
    // that ignores its period entirely.
    const before = await reportConversations(db, {
      unitId,
      query: {
        periodStart: new Date(now.getTime() - 400 * 86_400_000).toISOString(),
        periodEnd: new Date(now.getTime() - 390 * 86_400_000).toISOString(),
        granularity: "day",
      },
    }, ports);
    expect(before.newConversationCount).toBe(0);
  }, 120_000);
});

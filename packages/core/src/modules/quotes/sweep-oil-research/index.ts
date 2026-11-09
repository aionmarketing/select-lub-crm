/**
 * Slice `quotes/sweep-oil-research`: the worker job that finds what to research
 * (background-oil-research D7, D9, D11).
 *
 * Every minute:
 *   1. **Heartbeat** on `oil_research_runner`, so a run of several minutes — which skips the
 *      runner's own ticks — never makes the worker look stopped.
 *   2. **Vehicles.** Every vehicle with all four identity fields whose `updated_at` falls after the
 *      watermark and at least the settle time ago is enqueued by its identity key, through the one
 *      enqueue: priority 1 when a vehicle carrying the key was created within 24 h (not merely updated),
 *      else 2 (the backfill). The first sweep, with no watermark, reads every vehicle. The
 *      watermark then advances to the settle bound.
 *   3. **Manual upgrades**: an identity with a verified reading read after its `sources_read_at`.
 *   4. **Manual waits** that have ended move on.
 *
 * It sees every writer of `vehicle` — the api routes, prefill's accepts, the ERP pull, the seeds —
 * with no change to the customers module; `vehicle` is readable by every module.
 */
import type { Db } from "../../../kernel/db.js";
import type { Job } from "../../../kernel/jobs.js";
import { identityKey, type IdentityFields } from "../internal/research/identity-key.js";
import { enqueueManualUpgrades, settleManualWaits } from "../internal/research/manual-wait.js";
import { enqueueResearch } from "../internal/research/research-store.js";
import { RUNNER_ROW_ID, writeRunnerHeartbeat } from "../internal/research/runner-row.js";
import type { OilResearchSettings } from "../internal/research/settings.js";

/** The job's name. */
export const SWEEP_OIL_RESEARCH_JOB = "quotes/sweep-oil-research";

/** A vehicle carrying a key this long after its last change counts as a new registration (D7, D8). */
export const REGISTRATION_WINDOW_MS = 24 * 60 * 60_000;

/** What the job is built on. */
export type SweepOilResearchDeps = {
  db: Db;
  settings: Pick<OilResearchSettings, "sweepMs" | "settleMs" | "dailyBudgetUsd">;
  /** Whether the model key is set, for the heartbeat. */
  keySet: () => boolean;
  /** Whether this worker can web-search right now, for the heartbeat (review of #188). */
  searchAvailable: () => boolean;
  now?: () => Date;
};

/** What one sweep did. */
export type SweepResult = { vehicles: number; enqueued: string[]; upgraded: string[]; waitsEnded: string[]; watermark: Date };

type SweptVehicle = IdentityFields & { createdAt: Date; updatedAt: Date };

/**
 * Runs one sweep.
 *
 * @param deps - The job's dependencies.
 */
export async function sweepOilResearch(deps: SweepOilResearchDeps): Promise<SweepResult> {
  const now = (deps.now ?? (() => new Date()))();
  const { db, settings } = deps;
  await db.tx("quotes", (tx) => writeRunnerHeartbeat(tx, { now, keySet: deps.keySet(), searchAvailable: deps.searchAvailable(), budgetUsd: settings.dailyBudgetUsd }));

  const upTo = new Date(now.getTime() - settings.settleMs);
  const recentSince = new Date(now.getTime() - REGISTRATION_WINDOW_MS);
  const { vehicles, watermark } = await db.tx("quotes", async (tx) => {
    const runner = await tx.oilResearchRunner.findUnique({ where: { id: RUNNER_ROW_ID }, select: { sweepWatermark: true } });
    const from = runner?.sweepWatermark ?? null;
    const rows: SweptVehicle[] = await tx.vehicle.findMany({
      where: {
        updatedAt: { ...(from ? { gt: from } : {}), lte: upTo },
        make: { not: null },
        model: { not: null },
        version: { not: null },
        year: { not: null },
      },
      select: { make: true, year: true, model: true, version: true, createdAt: true, updatedAt: true },
      orderBy: { updatedAt: "asc" },
    });
    return { vehicles: rows, watermark: from };
  });

  // One enqueue per key: the most recent vehicle decides the priority, and its spelling is stored.
  const byKey = new Map<string, { vehicle: SweptVehicle; recent: boolean }>();
  for (const vehicle of vehicles) {
    const key = identityKey(vehicle);
    if (key === null) continue;
    // Created, not merely updated (orchestrator ruling, review of #186): the ERP pull and prefill
    // bump updated_at on old cars, which would promote the backfill past its pace and cap.
    const recent = vehicle.createdAt >= recentSince;
    const seen = byKey.get(key);
    byKey.set(key, { vehicle: seen && !recent ? seen.vehicle : vehicle, recent: recent || (seen?.recent ?? false) });
  }
  const enqueued: string[] = [];
  for (const [key, { vehicle, recent }] of [...byKey].sort(([a], [b]) => a.localeCompare(b))) {
    const result = await db.tx("quotes", (tx) =>
      enqueueResearch(tx, { identity: vehicle, kind: "full", priority: recent ? 1 : 2, trigger: recent ? "registration" : "backfill" }, now),
    );
    if (result.status === "written") enqueued.push(key);
  }
  // Advance only forward: a sweep whose bound is behind the stored one (a clock step) keeps it.
  const next = watermark && watermark > upTo ? watermark : upTo;
  await db.tx("quotes", (tx) =>
    tx.oilResearchRunner.update({ where: { id: RUNNER_ROW_ID }, data: { sweepWatermark: next, updatedAt: now } }),
  );

  const upgraded = await db.tx("quotes", (tx) => enqueueManualUpgrades(tx, now));
  const waitsEnded = await db.tx("quotes", (tx) => settleManualWaits(tx, now));
  if (enqueued.length > 0 || upgraded.length > 0 || waitsEnded.length > 0) {
    console.info("oil-research-sweep", JSON.stringify({ vehicles: vehicles.length, enqueued: enqueued.length, upgraded: upgraded.length, waitsEnded: waitsEnded.length }));
  }
  return { vehicles: vehicles.length, enqueued, upgraded, waitsEnded, watermark: next };
}

/** @returns The registered job: `quotes/sweep-oil-research`, every `OIL_RESEARCH_SWEEP_MS`. */
export function job(deps: SweepOilResearchDeps): Job {
  return {
    name: SWEEP_OIL_RESEARCH_JOB,
    everyMs: deps.settings.sweepMs,
    run: async () => {
      await sweepOilResearch(deps);
    },
  };
}

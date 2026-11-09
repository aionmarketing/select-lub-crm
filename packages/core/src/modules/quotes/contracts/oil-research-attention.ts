/**
 * Who is waiting on an identity's background oil research, and whether research runs at all
 * (background-oil-research D6, D15, D18). The rules the quote path and the rail share, in the
 * module's public scope so `readActiveOilResearch` can apply them for customers; the runner's
 * internals re-export them (`internal/research/identity-key.ts`, `runner-row.ts`).
 *
 * - {@link identityKey}: `year|make|model|version` under the caches' own normalization.
 * - {@link researchUnderWay}: `queued`, `running` or `waiting_manual`. A Tecfil claim is not research.
 * - {@link researchAttended}: under way, and `running` under an unexpired lease, `waiting_manual`,
 *   or `queued` at priority 0.
 * - {@link researchStopped}: no runner row; `no_key`; an unexpired provider pause; or a heartbeat
 *   older than three minutes while no identity holds a live research or Tecfil lease. A budget
 *   pause is not `stopped`: it holds only the backfill.
 *
 * Nothing here writes, and nothing calls a provider.
 */
import { normalizeMotulName } from "../../../kernel/clients/motul/index.js";
import type { DbClient } from "../../../kernel/index.js";

/** The four fields of an identity, any of which may be missing. */
export type IdentityFields = {
  make?: string | null;
  year?: number | null;
  model?: string | null;
  version?: string | null;
};

/**
 * The identity key research is keyed by (D6): `<year>|<normalizeMotulName(make)>|<model>|<version>`,
 * the same normalization the caches match with, so two identities share a key exactly when the
 * caches would match them. Accents and case do not split an identity; `VW` and `Volkswagen` still
 * do. Plate extras (`displacementCc`, `fuel`) are not part of it.
 *
 * @returns The key, or `null` when the identity is incomplete: a blank make, model or version, or
 *   no year — the same rule a quote uses to call an identity complete.
 */
export function identityKey(identity: IdentityFields): string | null {
  const { make, year, model, version } = identity;
  if (year == null || !Number.isInteger(year) || !make?.trim() || !model?.trim() || !version?.trim()) {
    return null;
  }
  return [String(year), normalizeMotulName(make), normalizeMotulName(model), normalizeMotulName(version)].join("|");
}

/** The runner row's fixed id: there is one runner row. */
export const RUNNER_ROW_ID = "runner";

/** A runner not seen for this long, with no live lease, reads as stopped (three sweep intervals). */
export const RUNNER_STALE_MS = 3 * 60_000;

/** Why the runner is paused. `budget` holds only the backfill. */
export type RunnerPause = "no_key" | "provider" | "budget";

/** What the api and the runner read from `oil_research_runner`. */
export type RunnerStatus = {
  lastSeenAt: Date | null;
  keySet: boolean;
  /** Whether the runner could web-search at its last heartbeat (review of #188). */
  searchAvailable: boolean;
  day: string | null;
  daySpendUsd: number;
  budgetUsd: number | null;
  pausedReason: RunnerPause | null;
  pausedUntil: Date | null;
  sweepWatermark: Date | null;
};

/** Reads the runner row, or null when no runner ever wrote it. */
export async function readRunnerStatus(tx: DbClient): Promise<RunnerStatus | null> {
  const row = await tx.oilResearchRunner.findUnique({ where: { id: RUNNER_ROW_ID } });
  if (!row) return null;
  return {
    lastSeenAt: row.lastSeenAt,
    keySet: row.keySet,
    searchAvailable: row.searchAvailable,
    day: row.day,
    daySpendUsd: row.daySpendUsd.toNumber(),
    budgetUsd: row.budgetUsd?.toNumber() ?? null,
    pausedReason: (row.pausedReason as RunnerPause | null) ?? null,
    pausedUntil: row.pausedUntil,
    sweepWatermark: row.sweepWatermark,
  };
}

/**
 * D15's `stopped`. The api reads the row; it never recomputes with its own env.
 *
 * @param liveLease - Whether some identity is `running`, or has Tecfil `running`, under an unexpired lease.
 */
export function researchStopped(status: RunnerStatus | null, liveLease: boolean, now: Date): boolean {
  if (!status) return true;
  if (status.pausedReason === "no_key") return true;
  if (status.pausedReason === "provider" && (status.pausedUntil === null || status.pausedUntil > now)) return true;
  const stale = status.lastSeenAt === null || now.getTime() - status.lastSeenAt.getTime() > RUNNER_STALE_MS;
  return stale && !liveLease;
}

/**
 * Whether the runner can web-search now, as its last heartbeat recorded (orchestrator ruling,
 * review of #188): a runner row seen within {@link RUNNER_STALE_MS} that says so. A missing or
 * stale row cannot vouch for a search, so it says no.
 */
export function runnerCanSearch(status: RunnerStatus | null, now: Date): boolean {
  if (!status?.searchAvailable || status.lastSeenAt === null) return false;
  return now.getTime() - status.lastSeenAt.getTime() <= RUNNER_STALE_MS;
}

/** Whether some identity holds a live research or Tecfil lease. */
export async function hasLiveLease(tx: DbClient, now: Date): Promise<boolean> {
  const rows = await tx.$queryRaw<{ live: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM oil_research
      WHERE (state = 'running' AND lease_until > ${now}) OR (tecfil_state = 'running' AND tecfil_lease_until > ${now})) AS live`;
  return rows[0]?.live ?? false;
}

/** Whether research runs now: the runner row and the live leases, read once. */
export async function readResearchStopped(tx: DbClient, now: Date): Promise<boolean> {
  const [status, live] = await Promise.all([readRunnerStatus(tx), hasLiveLease(tx, now)]);
  return researchStopped(status, live, now);
}

/** The columns the two rules below read. */
export type AttentionRow = { state: string; priority: number; leaseUntil: Date | null };

/** Under way (D15): `queued`, `running` or `waiting_manual`. A Tecfil claim is not research. */
export function researchUnderWay(row: Pick<AttentionRow, "state"> | null): boolean {
  return row !== null && (row.state === "queued" || row.state === "running" || row.state === "waiting_manual");
}

/** Attended (D15): under way, and running under an unexpired lease, waiting for a manual, or queued at priority 0. */
export function researchAttended(row: AttentionRow | null, now: Date): boolean {
  if (!row) return false;
  if (row.state === "running") return row.leaseUntil !== null && row.leaseUntil > now;
  if (row.state === "waiting_manual") return true;
  return row.state === "queued" && row.priority === 0;
}

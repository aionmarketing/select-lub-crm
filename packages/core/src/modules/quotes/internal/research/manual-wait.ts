/**
 * The manual path's store reads and writes (background-oil-research D11). Each runs on a client
 * already inside `db.tx("quotes", …)`.
 *
 * - {@link queueIdentityManuals} and {@link manualStillToCome}: entering the wait. A stage-1
 *   `no_spec` queues that identity's manuals at once; it waits only while some reading of the
 *   identity is `pending` or `reading` on a URL whose ingestion was not refused or failed.
 * - {@link settleManualWaits}: leaving it, before each claim. A wait ends when no reading is
 *   still to come — each has verified, stated nothing or failed, or its manual was refused or
 *   failed at download — or when its deadline has passed.
 * - {@link enqueueManualUpgrades}: every identity with a verified reading read after its
 *   `sources_read_at` gets a `manual_resolve` through the one enqueue (trigger `manual_upgrade`,
 *   priority 1); a running identity receives it as its pending cycle.
 *
 * Readings are matched to a research row by the identity key, computed in SQL under the same
 * normalization (`identityKeySql`), so a reading queued under another spelling of the identity
 * still counts.
 */
import type { DbClient } from "@select-lub/core/db";
import { identityKeySql, manualsPerIdentity, queueManuals } from "../manuals/ingestion-store.js";
import type { ResearchIdentity } from "./enqueue.js";
import { enqueueResearch } from "./enqueue.js";
import { endManualWait } from "./release.js";

/** Queues the manuals D1 picks for one identity, from its recorded candidates. */
export async function queueIdentityManuals(tx: DbClient, identity: ResearchIdentity): Promise<number> {
  return queueManuals(tx, manualsPerIdentity(), identity);
}

/** Whether some reading of the identity is still to come: `pending` or `reading`, on a URL not refused or failed. */
export async function manualStillToCome(tx: DbClient, identityKey: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ waiting: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM oil_manual_reading AS r JOIN oil_manual_ingestion AS i ON i.url = r.url
      WHERE r.status IN ('pending', 'reading')
        AND i.state IN ('pending', 'ingesting', 'parsing', 'ingested')
        AND ${identityKeySql("r")} = ${identityKey}
    ) AS waiting`;
  return rows[0]?.waiting ?? false;
}

/**
 * Ends every wait whose readings have all ended or whose deadline has passed: `queued`, kind
 * `manual_resolve`, trigger `wait_ended`, at its cycle's priority and `requested_at` (D11).
 *
 * @returns The identity keys whose wait ended.
 */
export async function settleManualWaits(tx: DbClient, now: Date): Promise<string[]> {
  const rows = await tx.$queryRaw<{ id: string; identity_key: string }[]>`
    SELECT o.id, o.identity_key FROM oil_research AS o
    WHERE o.state = 'waiting_manual'
      AND (o.manual_wait_until <= ${now}
        OR NOT EXISTS (
          SELECT 1 FROM oil_manual_reading AS r JOIN oil_manual_ingestion AS i ON i.url = r.url
          WHERE r.status IN ('pending', 'reading')
            AND i.state IN ('pending', 'ingesting', 'parsing', 'ingested')
            AND ${identityKeySql("r")} = o.identity_key))
    ORDER BY o.priority, o.manual_wait_until, o.id`;
  const ended: string[] = [];
  for (const row of rows) {
    if (await endManualWait(tx, row.id, now)) ended.push(row.identity_key);
  }
  return ended;
}

/**
 * Enqueues a manual upgrade for every identity with a verified reading whose `read_at` is later
 * than its `sources_read_at` (D11). A queued or waiting identity will read it anyway, and an
 * abandoned one is not researched; the one enqueue decides what the others do, and writes
 * nothing when nothing changes, so a repeat sweep is silent.
 *
 * @returns The identity keys whose row the enqueue changed.
 */
export async function enqueueManualUpgrades(tx: DbClient, now: Date): Promise<string[]> {
  const rows = await tx.$queryRaw<{ make: string; year: number; model: string; version: string }[]>`
    WITH seen AS (
      -- What the identity has read up to: its sources_read_at; for a failed cycle — which keeps
      -- its old sources_read_at, since an outage is not an outcome — also the start of its last
      -- attempt, which loaded every reading verified before it. So a failed identity is not
      -- upgraded again for those (it cannot loop), and a reading verified during that last
      -- attempt still upgrades it.
      SELECT o.make, o.year, o.model, o.version, o.identity_key,
        GREATEST(o.sources_read_at, CASE WHEN o.state = 'failed' THEN (
          SELECT MAX(run.started_at) FROM oil_research_run AS run
          WHERE run.research_id = o.id AND run.path IN ('search', 'manual')) END) AS read_upto
      FROM oil_research AS o
      WHERE o.state NOT IN ('queued', 'waiting_manual', 'abandoned')
    )
    SELECT s.make, s.year, s.model, s.version FROM seen AS s
    WHERE s.read_upto IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM oil_manual_reading AS r
        WHERE r.status = 'verified' AND r.read_at > s.read_upto AND ${identityKeySql("r")} = s.identity_key)
    ORDER BY s.identity_key`;
  const changed: string[] = [];
  for (const row of rows) {
    const result = await enqueueResearch(tx, { identity: row, kind: "manual_resolve", priority: 1, trigger: "manual_upgrade" }, now);
    if (result.status === "written") changed.push(result.row.identityKey);
  }
  return changed;
}

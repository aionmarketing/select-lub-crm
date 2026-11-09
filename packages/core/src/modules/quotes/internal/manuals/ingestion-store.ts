/**
 * The ingestion job's reads and writes (ingest-harvested-manuals D1–D3). Each function runs on a
 * client already inside `db.tx("quotes", …)`; the download and the parse happen between them,
 * outside any transaction.
 *
 * - `queueManuals`: for every identity with recorded candidates, D1 picks the URLs it queues;
 *   each URL gets one `oil_manual_ingestion` row (shared by every identity that queues it) and
 *   the identity gets one `oil_manual_reading` row, pending. `oil_source_candidate` is only read.
 * - `claimNextManual`: the oldest URL that is due, leased so a worker that dies mid-read does
 *   not hold it forever — a claim sets `next_attempt_at` to the lease's end, and a row still
 *   `ingesting` or `parsing` after it is claimable again. The claim COUNTS the attempt, committed
 *   before anything is downloaded or parsed.
 * - `markParsing`: committed before the parse starts (second review of #180). A parse that takes
 *   the whole process down — a decompression bomb past every in-process limit — leaves the row
 *   `parsing` with its attempt counted; after `MANUAL_MAX_ATTEMPTS` the next claim marks it a
 *   definite `failed` instead of parsing it again, so a bad manual cannot crash-loop the worker
 *   across restarts.
 * - `recordManualRead` / `recordManualFailure`: the outcome. A definite refusal is terminal; a
 *   transient failure is retried with backoff, and is a definite `failed` after
 *   `MANUAL_MAX_ATTEMPTS`.
 *
 * States: `pending` → `ingesting` (claimed, downloading) → `parsing` → `ingested`; or `refused`
 * (a definite answer) or `failed` (out of attempts). `refused` and `failed` are terminal.
 *
 * **Every write after the claim is a compare-and-set on the claim it holds** (review of #181): it
 * changes the row only while the row is still in the state that claim left it in, with the
 * attempts that claim counted. A worker whose lease ran out, and whose URL was claimed again,
 * finds nothing to change and returns false — it lost the lease, and writes nothing more.
 */
import { Prisma, type DbClient } from "@select-lub/core/db";
import { motulIdentitiesMatch } from "../../../../kernel/clients/motul/index.js";
import { chooseManuals, type ManualIdentity } from "./select-candidates.js";

/**
 * SQL for the research identity key of a row with `make`, `year`, `model` and `version` columns
 * (background-oil-research D6): the same normalization as `identityKey` — NFD, marks dropped,
 * uppercase, only A–Z and 0–9 kept.
 *
 * @param alias - The row's alias in the query.
 */
export function identityKeySql(alias: string): Prisma.Sql {
  const part = (column: string) => Prisma.raw(`regexp_replace(upper(normalize(${alias}.${column}, NFD)), '[^A-Z0-9]', '', 'g')`);
  return Prisma.sql`(${Prisma.raw(`${alias}.year::text`)} || '|' || ${part("make")} || '|' || ${part("model")} || '|' || ${part("version")})`;
}

/**
 * The claim order a manual's reading takes from the research waiting on it (D11): the waiting
 * identity's priority, then its wait deadline; manuals no one waits on after them, first in,
 * first out. `r` is the reading.
 */
export const WAITING_PRIORITY_SQL = Prisma.sql`(SELECT MIN(o.priority) FROM oil_research AS o WHERE o.state = 'waiting_manual' AND o.identity_key = ${identityKeySql("r")})`;
export const WAITING_DEADLINE_SQL = Prisma.sql`(SELECT MIN(o.manual_wait_until) FROM oil_research AS o WHERE o.state = 'waiting_manual' AND o.identity_key = ${identityKeySql("r")})`;

/** Transient failures before a URL is given up (D2). */
export const MANUAL_MAX_ATTEMPTS = 3;

/** First retry after a transient failure; doubles with each attempt. */
export const MANUAL_RETRY_BASE_MS = 15 * 60_000;

/** How many manuals an identity may queue, when `MANUALS_PER_IDENTITY` is unset (Q3: N = 2). */
export const MANUALS_PER_IDENTITY_DEFAULT = 2;

/** @returns N from `MANUALS_PER_IDENTITY`, else its default. */
export function manualsPerIdentity(): number {
  const raw = Number(process.env.MANUALS_PER_IDENTITY);
  return Number.isInteger(raw) && raw > 0 ? raw : MANUALS_PER_IDENTITY_DEFAULT;
}

/**
 * Queues, for every identity with recorded candidates, the manuals D1 picks, up to `limit`
 * live ones per identity (a refused URL frees its place for the next best).
 *
 * @param only - One identity: its candidates only, under the caches' normalization — the research
 *   runner queues the manuals of the identity it just researched (background-oil-research D11).
 * @returns How many readings were queued.
 */
export async function queueManuals(tx: DbClient, limit: number, only?: ManualIdentity): Promise<number> {
  const all = await tx.oilSourceCandidate.findMany({
    ...(only ? { where: { year: only.year } } : {}),
    select: { make: true, year: true, model: true, version: true, url: true, label: true, classification: true, tier: true, foundAt: true },
  });
  const candidates = only ? all.filter((c) => motulIdentitiesMatch(c, only)) : all;
  const readings = await tx.oilManualReading.findMany({
    select: { url: true, make: true, year: true, model: true, version: true, ingestion: { select: { state: true } } },
  });
  const key = (i: ManualIdentity) => JSON.stringify([i.make, i.year, i.model, i.version]);
  const byIdentity = new Map<string, { identity: ManualIdentity; rows: typeof candidates }>();
  for (const c of candidates) {
    const k = key(c);
    const entry = byIdentity.get(k) ?? { identity: { make: c.make, year: c.year, model: c.model, version: c.version }, rows: [] };
    entry.rows.push(c);
    byIdentity.set(k, entry);
  }

  const newIngestions = new Set<string>();
  const newReadings: Prisma.OilManualReadingCreateManyInput[] = [];
  for (const [k, { identity, rows }] of byIdentity) {
    const mine = readings.filter((r) => key(r) === k);
    const queued = new Set(mine.map((r) => r.url));
    // A terminal URL frees its place for the next best.
    let live = mine.filter((r) => r.ingestion.state !== "refused" && r.ingestion.state !== "failed").length;
    for (const url of chooseManuals(rows, identity, Number.MAX_SAFE_INTEGER)) {
      if (live >= limit) break;
      if (queued.has(url)) continue;
      newIngestions.add(url);
      newReadings.push({ url, ...identity });
      live += 1;
    }
  }
  if (newReadings.length === 0) return 0;
  // skipDuplicates, not a caught P2002: a constraint violation would abort the transaction.
  await tx.oilManualIngestion.createMany({ data: [...newIngestions].map((url) => ({ url })), skipDuplicates: true });
  const created = await tx.oilManualReading.createMany({ data: newReadings, skipDuplicates: true });
  return created.count;
}

/**
 * Leases the oldest due URL — pending and past its retry time, or still `ingesting` or
 * `parsing` past its lease (a worker that died mid-read) — and counts the attempt.
 *
 * First, every abandoned row already out of attempts becomes a definite `failed`: a worker that
 * died while PARSING it may have been killed by it, and must not parse it again.
 *
 * @param now - The clock.
 * @param leaseMs - How long the claim holds: longer than a download.
 * @returns The URL and its attempts INCLUDING this one, or null when nothing is due.
 */
export async function claimNextManual(tx: DbClient, now: Date, leaseMs: number): Promise<{ url: string; attempts: number } | null> {
  await tx.$executeRaw`
    UPDATE oil_manual_ingestion
    SET state = 'failed', definite = true, next_attempt_at = NULL,
        reason = CASE WHEN state = 'parsing'
          THEN 'the parse never finished in ' || attempts || ' attempts (the worker died or hung while parsing)'
          ELSE 'gave up after ' || attempts || ' attempts (the worker died while downloading)' END
    WHERE state IN ('ingesting', 'parsing') AND next_attempt_at <= ${now} AND attempts >= ${MANUAL_MAX_ATTEMPTS}`;
  const leaseEnd = new Date(now.getTime() + leaseMs);
  // A MATERIALIZED CTE: `IN (SELECT … LIMIT n FOR UPDATE SKIP LOCKED)` can over-claim under a
  // generic plan.
  const rows = await tx.$queryRaw<{ url: string; attempts: number }[]>`
    WITH due AS MATERIALIZED (
      SELECT i.url FROM oil_manual_ingestion AS i
      WHERE ((i.state = 'pending' AND (i.next_attempt_at IS NULL OR i.next_attempt_at <= ${now}))
          OR (i.state IN ('ingesting', 'parsing') AND i.next_attempt_at <= ${now}))
        AND i.attempts < ${MANUAL_MAX_ATTEMPTS}
      -- The manual a waiting research needs first (D11): its priority, then its deadline.
      ORDER BY
        (SELECT MIN(${WAITING_PRIORITY_SQL}) FROM oil_manual_reading AS r WHERE r.url = i.url) NULLS LAST,
        (SELECT MIN(${WAITING_DEADLINE_SQL}) FROM oil_manual_reading AS r WHERE r.url = i.url) NULLS LAST,
        i.created_at, i.url
      LIMIT 1
      FOR UPDATE OF i SKIP LOCKED
    )
    UPDATE oil_manual_ingestion AS i
    SET state = 'ingesting', attempts = i.attempts + 1, next_attempt_at = ${leaseEnd}
    FROM due WHERE i.url = due.url
    RETURNING i.url, i.attempts`;
  return rows[0] ?? null;
}

/** A claim: the URL, and the attempts the claim counted, which identify it. */
export type ManualClaim = { url: string; attempts: number };

/**
 * Marks a claimed URL as being parsed, leased for the parse. Committed BEFORE the parse starts,
 * so a parse that takes the process down leaves a trace the next claim can read.
 *
 * @param leaseMs - How long the parse may hold it: longer than the parse timeout.
 * @returns False when the claim was lost: the row is no longer this claim's `ingesting`.
 */
export async function markParsing(tx: DbClient, claim: ManualClaim, now: Date, leaseMs: number): Promise<boolean> {
  const { count } = await tx.oilManualIngestion.updateMany({
    where: { url: claim.url, attempts: claim.attempts, state: "ingesting" },
    data: { state: "parsing", nextAttemptAt: new Date(now.getTime() + leaseMs) },
  });
  return count === 1;
}

/** What a successful read stores. */
export type ManualReadRecord = {
  sha256: string;
  bytes: number;
  pages: string[];
  fetchMs: number;
  parseMs: number;
};

/**
 * Marks a claimed URL ingested and stores its document and pages — the mark FIRST, in the same
 * transaction, so a claim that was lost stores nothing: no second document, no second page set.
 *
 * @returns The document's id, or null when the claim was lost.
 */
export async function recordManualRead(tx: DbClient, claim: ManualClaim, read: ManualReadRecord, now: Date): Promise<string | null> {
  const { count } = await tx.oilManualIngestion.updateMany({
    where: { url: claim.url, attempts: claim.attempts, state: "parsing" },
    data: { state: "ingested", reason: null, definite: false, nextAttemptAt: null },
  });
  if (count !== 1) return null;
  const document = await tx.oilManualDocument.create({
    data: { url: claim.url, sha256: read.sha256, bytes: read.bytes, pages: read.pages.length, fetchedAt: now, fetchMs: read.fetchMs, parseMs: read.parseMs },
    select: { id: true },
  });
  await tx.oilManualPage.createMany({
    // Postgres TEXT refuses NUL, and a PDF's text layer can carry it.
    data: read.pages.map((text, index) => ({ documentId: document.id, pageNumber: index + 1, text: text.replaceAll("\u0000", "") })),
  });
  return document.id;
}

/**
 * Records a failed read. A definite refusal is terminal. A transient one is retried after
 * `MANUAL_RETRY_BASE_MS × 2^(attempts − 1)`, and is a definite `failed` once it has had
 * `MANUAL_MAX_ATTEMPTS`.
 *
 * A failure can come while downloading (`ingesting`) or while parsing (`parsing`), so either
 * state is this claim's.
 *
 * @param claim - The claim, whose attempts include this one.
 * @returns False when the claim was lost, and nothing was written.
 */
export async function recordManualFailure(
  tx: DbClient,
  claim: ManualClaim,
  failure: { definite: boolean; reason: string },
  now: Date,
): Promise<boolean> {
  const { attempts } = claim;
  const data = failure.definite
    ? { state: "refused", definite: true, reason: failure.reason, nextAttemptAt: null }
    : attempts >= MANUAL_MAX_ATTEMPTS
      ? { state: "failed", definite: true, reason: `gave up after ${attempts} transient failures: ${failure.reason}`, nextAttemptAt: null }
      : { state: "pending", reason: failure.reason, nextAttemptAt: new Date(now.getTime() + MANUAL_RETRY_BASE_MS * 2 ** (attempts - 1)) };
  const { count } = await tx.oilManualIngestion.updateMany({
    where: { url: claim.url, attempts, state: { in: ["ingesting", "parsing"] } },
    data,
  });
  return count === 1;
}

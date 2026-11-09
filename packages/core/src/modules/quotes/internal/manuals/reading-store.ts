/**
 * The reading step's reads and writes (ingest-harvested-manuals D7). Each function runs on a
 * client already inside `db.tx("quotes", …)`; the passage selector and the extractor run between
 * them, outside any transaction.
 *
 * - `claimNextReading`: the oldest reading of an ingested manual that is due — `pending`; `failed`
 *   (a model failure) past its retry interval; or still `reading` past its lease — while it has
 *   attempts left. The claim sets `reading`, stamps `read_at` (the lease) and counts the attempt,
 *   which identifies it. First, a reading whose lease ran out with no attempts left becomes a
 *   definite `failed` (review of #182: retries bounded by a count, not by the queue's age).
 * - `loadReadingInput`: the latest stored document's pages, and who published it and what it is
 *   (the candidate's label and class, D6).
 * - `recordReading`: the outcome, as a compare-and-set on the claim — the same rule as
 *   ingestion's (review of #181): a reading claimed again meanwhile is not overwritten.
 *
 * Reading statuses: `pending` → `reading` → `verified` | `stated_nothing` | `failed`. A
 * `stated_nothing` reading is not read again (D7); a `failed` one is, until it has had
 * {@link MANUAL_READING_MAX_ATTEMPTS}.
 */
import { Prisma, type DbClient } from "@select-lub/core/db";
import { sourceClassificationSchema } from "../../../../shared/web/source-classification.js";
import { WAITING_DEADLINE_SQL, WAITING_PRIORITY_SQL } from "./ingestion-store.js";
import type { ManualPage } from "./locate-pages.js";
import type { ManualSourceMeta, ReadingOutcome } from "./read-for-identity.js";

/** A failed reading is retried after this long. */
export const MANUAL_READING_RETRY_MS = 6 * 60 * 60_000;

/** Attempts a reading gets; after them a failure is definite. */
export const MANUAL_READING_MAX_ATTEMPTS = 3;

/** A claimed reading: which one, for which identity, and the attempt that identifies the claim. */
export type ReadingClaim = {
  id: string;
  url: string;
  make: string;
  year: number;
  model: string;
  version: string;
  attempts: number;
  readAt: Date;
};

/**
 * Claims the oldest due reading of an ingested manual.
 *
 * Readings a waiting research needs come first (background-oil-research D11): by that research's
 * priority, then its wait deadline, then creation. Once the day's budget is reached
 * (`capped`, D13), only a reading an identity waits on at priority 0 or 1 is claimed.
 *
 * @param leaseMs - How long a claim holds: longer than a selector call plus an extraction.
 * @param options.capped - The day's research spend has reached the budget.
 * @returns The claim, or null when nothing is due.
 */
export async function claimNextReading(tx: DbClient, now: Date, leaseMs: number, options: { capped?: boolean } = {}): Promise<ReadingClaim | null> {
  const retryBefore = new Date(now.getTime() - MANUAL_READING_RETRY_MS);
  const leaseBefore = new Date(now.getTime() - leaseMs);
  // A lease that ran out on the last attempt: the reading is over.
  await tx.$executeRaw`
    UPDATE oil_manual_reading SET status = 'failed'
    WHERE status = 'reading' AND read_at <= ${leaseBefore} AND attempts >= ${MANUAL_READING_MAX_ATTEMPTS}`;
  // A MATERIALIZED CTE: `IN (SELECT … LIMIT n FOR UPDATE SKIP LOCKED)` can over-claim.
  const rows = await tx.$queryRaw<
    { id: string; url: string; make: string; year: number; model: string; version: string; attempts: number; read_at: Date }[]
  >`
    WITH due AS MATERIALIZED (
      SELECT r.id FROM oil_manual_reading AS r
      JOIN oil_manual_ingestion AS i ON i.url = r.url
      WHERE i.state = 'ingested'
        AND r.attempts < ${MANUAL_READING_MAX_ATTEMPTS}
        AND (r.status = 'pending'
          OR (r.status = 'failed' AND r.read_at <= ${retryBefore})
          OR (r.status = 'reading' AND r.read_at <= ${leaseBefore}))
        AND (NOT ${options.capped ?? false}::boolean OR COALESCE(${WAITING_PRIORITY_SQL}, 2) <= 1)
      ORDER BY ${WAITING_PRIORITY_SQL} NULLS LAST, ${WAITING_DEADLINE_SQL} NULLS LAST, r.created_at, r.id
      LIMIT 1
      FOR UPDATE OF r SKIP LOCKED
    )
    UPDATE oil_manual_reading AS r
    SET status = 'reading', read_at = ${now}, attempts = r.attempts + 1
    FROM due WHERE r.id = due.id
    RETURNING r.id, r.url, r.make, r.year, r.model, r.version, r.attempts, r.read_at`;
  const row = rows[0];
  return row
    ? { id: row.id, url: row.url, make: row.make, year: row.year, model: row.model, version: row.version, attempts: row.attempts, readAt: row.read_at }
    : null;
}

/** The file name, decoded: a document's name when the page gave it no label. */
function fileName(url: string): string {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? url;
    return decodeURIComponent(last);
  } catch {
    return url;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** What a reading needs: the document, its pages, and its source. */
export type ReadingInput = { documentId: string; pages: ManualPage[]; meta: ManualSourceMeta };

/**
 * Loads the latest stored document for a URL, its pages, and its source: the publisher, the
 * candidate's label (else the file name), and the candidate's class.
 *
 * @returns The input, or null when no document is stored or no candidate names a known class.
 */
export async function loadReadingInput(tx: DbClient, url: string): Promise<ReadingInput | null> {
  const document = await tx.oilManualDocument.findFirst({ where: { url }, orderBy: { fetchedAt: "desc" }, select: { id: true } });
  if (!document) return null;
  const candidate = await tx.oilSourceCandidate.findFirst({
    where: { url },
    orderBy: { foundAt: "asc" },
    select: { publisher: true, label: true, classification: true },
  });
  const sourceClass = sourceClassificationSchema.safeParse(candidate?.classification);
  if (!candidate || !sourceClass.success) return null;
  const pages = await tx.oilManualPage.findMany({
    where: { documentId: document.id },
    orderBy: { pageNumber: "asc" },
    select: { pageNumber: true, text: true },
  });
  const label = candidate.label?.trim();
  return {
    documentId: document.id,
    pages,
    meta: { publisher: candidate.publisher || hostOf(url), document: label ? label : fileName(url), sourceClass: sourceClass.data },
  };
}

/**
 * Records a reading's outcome, as a compare-and-set on the claim.
 *
 * @param documentId - The document read, or null when there was none to read.
 * @param readBy - The model that read it, for audit.
 * @returns False when the claim was lost, and nothing was written.
 */
export async function recordReading(
  tx: DbClient,
  claim: ReadingClaim,
  documentId: string | null,
  outcome: ReadingOutcome,
  readBy: string,
  now: Date,
): Promise<boolean> {
  const base = { status: outcome.status, documentId, readBy, readAt: now };
  const data =
    outcome.status === "failed"
      ? { ...base, spec: Prisma.DbNull, citedPage: null, excerpt: null }
      : {
          ...base,
          spec: outcome.spec === null ? Prisma.DbNull : (outcome.spec as unknown as Prisma.InputJsonValue),
          citedPage: outcome.citedPage,
          excerpt: outcome.excerpt,
        };
  const { count } = await tx.oilManualReading.updateMany({ where: { id: claim.id, status: "reading", attempts: claim.attempts }, data });
  return count === 1;
}

/**
 * Releases a claimed reading at shutdown (background-oil-research D19): back to `pending` with its
 * attempt refunded, as a compare-and-set on the claim, so a deploy mid-reading neither spends one
 * of its three attempts nor holds it `reading` for the whole lease.
 *
 * @returns False when the claim was lost, and nothing was written.
 */
export async function releaseReading(tx: DbClient, claim: ReadingClaim): Promise<boolean> {
  const { count } = await tx.oilManualReading.updateMany({
    where: { id: claim.id, status: "reading", attempts: claim.attempts },
    data: { status: "pending", attempts: { decrement: 1 } },
  });
  return count === 1;
}

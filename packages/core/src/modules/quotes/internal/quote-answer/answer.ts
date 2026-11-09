/**
 * The quote's answer for one vehicle (background-oil-research D7, D15, D16), shared by
 * `get-quote-options` and `refetch-oil-research`: the one enqueue, then a read of the caches and
 * the identity's research state. It calls no provider — not Motul, Tecfil, the web search or any
 * model — so it answers within the browser's request bound whatever the research costs.
 *
 * | Condition | Answer |
 * |---|---|
 * | make, year, model or version missing | `no_spec`, `incomplete_identity`, `missingFields`; nothing is written |
 * | a cache row, no research under way, a later conflict or clarification | that state, from its stored payload |
 * | a cache row, otherwise | what the latest row yields, with `refresh` while research is attended, else `newerAttempt` |
 * | no row (or a later conflict or clarification) and research under way | `researching` |
 * | no row, research resting | `no_spec` `no_source`, the clarification, the conflict, or `error` |
 *
 * One short transaction under the `quotes` role: the enqueue's writes and the reads commit
 * together, and no provider call is made inside it or out.
 */
import type { AttendantFill, QuoteOptionsResult, ResearchIdentityField } from "../../contracts/http.js";
import { identityKey, readResearchStopped, researchAttended, researchUnderWay } from "../../contracts/oil-research-attention.js";
import type { Vehicle } from "../../../customers/contracts/http.js";
import type { Db, DbClient } from "../../../../kernel/db.js";
import { FAILED_RERUN_AFTER_MS } from "../research/research-states.js";
import { enqueueResearch, rowsAhead, type EnqueueRequest, type ResearchIdentity } from "../research/research-store.js";
import { missTtlHours } from "../retrieval/sources.js";
import { createPrismaAttendantFillStore } from "../store/attendant-fill.js";
import { createPrismaOilQuoteStore } from "../store/prisma.js";
import {
  conflictHasCards,
  conflictNeedsVolume,
  laterStandoffOf,
  newerAttemptOf,
  researchTiming,
  restingAnswer,
  type ConflictContext,
  type ResearchView,
} from "./research-view.js";
import { shownRowResult, storedFilters } from "./shown-row.js";

/** What asked: a quote opened, or "Buscar novamente" (D16). */
export type QuoteRequest = "open" | "refetch";

/** The fields a research needs, in the order the dialog names them (D17). */
const IDENTITY_FIELDS: readonly ResearchIdentityField[] = ["make", "model", "version", "year"];

/** The identity fields the vehicle lacks, in D17's order; empty when it is complete. */
export function missingIdentityFields(vehicle: Pick<Vehicle, "make" | "model" | "version" | "year">): ResearchIdentityField[] {
  return IDENTITY_FIELDS.filter((field) => (field === "year" ? vehicle.year == null : !vehicle[field]?.trim()));
}

/** The one enqueue's request for this caller (D7): a quote-open at 0, or a refetch at 0. */
function enqueueRequest(identity: ResearchIdentity, request: QuoteRequest): EnqueueRequest {
  return request === "refetch"
    ? { identity, kind: "refetch", priority: 0, trigger: "refetch" }
    : { identity, kind: "full", priority: 0, trigger: "quote_open" };
}

const RESEARCH_VIEW = {
  state: true, kind: true, priority: true, leaseUntil: true, queuedAt: true, cycleQueuedAt: true, requestedAt: true, startedAt: true,
  dueAt: true, finishedAt: true, expectedMinS: true, expectedMaxS: true, outcome: true, outcomePayload: true, tecfilState: true,
  tecfilUnmatchedField: true, id: true, enginePickEngine: true,
} as const;

/**
 * @param db - The database handle; everything runs in one `db.tx("quotes", …)`.
 * @param vehicle - The vehicle, already scoped to the caller's unit.
 * @param request - A quote-open or a refetch; both enqueue at priority 0 through the one enqueue.
 * @param now - The server's clock, sent back as the contract's `now`.
 */
export async function answerQuote(db: Db, vehicle: Vehicle, request: QuoteRequest, now: Date = new Date()): Promise<QuoteOptionsResult> {
  const missingFields = missingIdentityFields(vehicle);
  if (missingFields.length > 0) {
    return { status: "no_spec", reason: "incomplete_identity", missingFields };
  }
  const identity = identityOf(vehicle);
  return db.tx("quotes", async (tx) => {
    await enqueueResearch(tx, enqueueRequest(identity, request), now, rerunPolicy());
    return readQuoteAnswer(tx, identity, now);
  });
}

/** The vehicle's complete identity, trimmed; the caller has checked {@link missingIdentityFields}. */
export function identityOf(vehicle: Pick<Vehicle, "make" | "model" | "version" | "year">): ResearchIdentity {
  return { make: vehicle.make!.trim(), year: vehicle.year!, model: vehicle.model!.trim(), version: vehicle.version!.trim() };
}

/** D10's re-run policy, from the api's own miss window. */
export function rerunPolicy() {
  return { missTtlMs: missTtlHours() * 3_600_000, failedRerunAfterMs: FAILED_RERUN_AFTER_MS };
}

/**
 * The quote's answer for a complete identity, read after the caller's enqueue in the same
 * transaction (D15). Reads only: the caches, the research row, the runner row, the catalog and —
 * only while the shown row has no usable liters — the identity's latest attendant volume (D24).
 *
 * @param tx - A client inside `db.tx("quotes", …)`.
 */
export async function readQuoteAnswer(tx: DbClient, identity: ResearchIdentity, now: Date): Promise<QuoteOptionsResult> {
  const store = createPrismaOilQuoteStore(tx);
  const [row, cached, stopped] = await Promise.all([
    tx.oilResearch.findUnique({ where: { identityKey: identityKey(identity)! }, select: RESEARCH_VIEW }),
    store.latestCompatibility(identity),
    readResearchStopped(tx, now),
  ]);
  const view: ResearchView | null = row;
  const underWay = researchUnderWay(view);
  const timing = async () => {
    const ahead = row && row.state === "queued" ? await rowsAhead(tx, row, now) : 0;
    return researchTiming(row!, stopped, ahead, now);
  };
  // The stored attendant volume, as the contract carries it; read only where no cited volume exists.
  const keptVolume = async (): Promise<AttendantFill | null> => {
    const fill = await createPrismaAttendantFillStore(tx).latest(identity);
    return fill ? { liters: fill.liters, recordedBy: fill.recordedBy, recordedAt: fill.recordedAt.toISOString() } : null;
  };
  // The catalog and the filters: what the shown row's cards, and a conflict's cards, are priced from;
  // and, for a conflict no source stated a usable volume for, the kept volume (orchestrator, 2026-10-01).
  const context = async (): Promise<ConflictContext> => {
    const [catalog, fitment, attendantFill] = await Promise.all([
      store.listCatalog(),
      store.latestTecfilCompatibility(identity),
      conflictNeedsVolume(view) ? keptVolume() : null,
    ]);
    const tecfil = { researchState: view?.state ?? null, state: view?.tecfilState ?? null, unmatchedField: view?.tecfilUnmatchedField ?? null };
    return { catalog, filters: () => storedFilters(fitment, tecfil, stopped, catalog), attendantFill };
  };
  const priced = cached || conflictHasCards(view) ? await context() : null;

  const standoff = cached ? laterStandoffOf(view, cached.consultedAt, priced) : null;
  if (!cached || standoff) {
    if (underWay) return { status: "researching", ...(await timing()) };
    return standoff ?? restingAnswer(view, priced);
  }

  // A cited volume wins: the stored attendant volume is read only when the row has no usable liters.
  const attendantFill = cached.fillLiters == null || cached.fillKind == null ? await keptVolume() : null;
  const shown = shownRowResult(cached, priced!.catalog, priced!.filters, attendantFill);
  if (researchAttended(view, now)) return { ...shown, refresh: await timing() };
  const newer = newerAttemptOf(view, cached.consultedAt);
  return newer ? { ...shown, newerAttempt: newer } : shown;
}

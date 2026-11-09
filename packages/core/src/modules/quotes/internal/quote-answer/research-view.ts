/**
 * D15's reading of an identity's research row, pure: no database, no clock beyond the `now` it is
 * handed. What the quote answers with the row and the runner's state already read.
 *
 * - {@link researchTiming}: the `researching` fields and an options result's `refresh`: the stored
 *   anchor and estimate (never recomputed on a read, D14), the queue position, the path, the pause.
 * - {@link researchPause}: `stopped` first, then `retrying` only while `retryAt` is in the future,
 *   else null. No budget reason: the budget holds only the backfill (D13, D15).
 * - {@link newerAttemptOf}, {@link laterStandoffOf}: a research after the shown row that ended
 *   with no source or failed, or with a conflict or a clarification.
 * - {@link restingAnswer}: the answer for an identity with no cache row and no research under way.
 */
import type { AttendantFill, NewerAttempt, QuoteFilters, QuoteOptionsResult, ResearchPause, ResearchTiming } from "../../contracts/http.js";
import { ENGINE_PICK_EXPECTED_MINUTES } from "../../contracts/http.js";
import { filterCompatibleCatalogItems } from "../catalog/match.js";
import { DEFAULT_RUN_RANGES, expectedMinutes, storedEstimate, type EstimatePath } from "../research/estimate.js";
import type { ConflictCardData } from "../research/outcome.js";
import type { CatalogRow } from "../store/store.js";

/** The research row's columns the quote reads. */
export type ResearchView = {
  state: string;
  kind: string;
  priority: number;
  leaseUntil: Date | null;
  queuedAt: Date;
  cycleQueuedAt: Date;
  requestedAt: Date | null;
  startedAt: Date | null;
  dueAt: Date | null;
  finishedAt: Date | null;
  expectedMinS: number | null;
  expectedMaxS: number | null;
  outcome: string | null;
  outcomePayload: unknown;
  tecfilState: string | null;
  tecfilUnmatchedField: string | null;
  /** The engine an `engine_pick` cycle re-reads for (D24); null otherwise. */
  enginePickEngine: string | null;
};

/**
 * The path a row shows (D14, D24): an `engine_pick` cycle's re-read; a wait or a `manual_resolve`
 * on `manual`; anything else on `search`.
 */
function pathOf(row: ResearchView): EstimatePath | "engine_pick" {
  if (row.kind === "engine_pick" && row.state !== "waiting_manual") return "engine_pick";
  return row.state === "waiting_manual" || row.kind === "manual_resolve" ? "manual" : "search";
}

/** D15's pause, in its order: `stopped`, then a retry still in the future, else none. */
export function researchPause(row: ResearchView, stopped: boolean, now: Date): ResearchPause | null {
  if (stopped) return { reason: "stopped" };
  if (row.state === "queued" && row.dueAt !== null && row.dueAt > now) {
    return { reason: "retrying", retryAt: row.dueAt.toISOString() };
  }
  return null;
}

/**
 * The timing of a research under way.
 *
 * The anchor is `requested_at`, which every attended cycle carries (set at the enqueue, or at the
 * claim when still null). A row with none — a running backfill cycle claimed before PR 3 stored
 * it — falls back to its start, then its cycle. The estimate is the stored one; a row that has
 * none yet reads the path's default range from its anchor, the value the next stored moment
 * would start from.
 *
 * @param queuePosition - The rows ahead in claim order, counting a run in progress; 0 unless queued.
 */
export function researchTiming(row: ResearchView, stopped: boolean, queuePosition: number, now: Date): ResearchTiming {
  const anchor = row.requestedAt ?? row.startedAt ?? row.cycleQueuedAt;
  const path = pathOf(row);
  const common = {
    requestedAt: anchor.toISOString(),
    now: now.toISOString(),
    queuePosition: row.state === "queued" ? queuePosition : 0,
    paused: researchPause(row, stopped, now),
  };
  if (path === "engine_pick") {
    // One extraction on stored text: a fixed 1–2 minutes, never a sample's range (D14, D24).
    return { ...common, expectedMinutes: { ...ENGINE_PICK_EXPECTED_MINUTES }, path, engine: row.enginePickEngine ?? "" };
  }
  const stored =
    row.expectedMinS !== null && row.expectedMaxS !== null
      ? { minS: row.expectedMinS, maxS: row.expectedMaxS }
      : storedEstimate((now.getTime() - anchor.getTime()) / 1000, 0, DEFAULT_RUN_RANGES[path]);
  return { ...common, expectedMinutes: expectedMinutes(stored), path };
}

/** Whether the row's last recorded outcome came after the shown cache row. */
function after(row: ResearchView, consultedAt: string): boolean {
  return row.finishedAt !== null && row.finishedAt.getTime() > new Date(consultedAt).getTime();
}

/** A research after the shown row that ended with no citable source or failed. */
export function newerAttemptOf(row: ResearchView | null, consultedAt: string): NewerAttempt | null {
  if (!row || (row.outcome !== "no_spec" && row.outcome !== "failed") || !after(row, consultedAt)) return null;
  return { outcome: row.outcome, finishedAt: row.finishedAt!.toISOString() };
}

/** The answers that stand on the sources that were read, from a row's recorded payload. */
type Standoff = Extract<QuoteOptionsResult, { status: "needs_clarification" | "conflicting_sources" }>;

/**
 * What a conflict's cards are priced from: the catalog, the filters as the identity's Tecfil state
 * gives them, and — for a conflict no source stated a usable volume for — the identity's stored
 * attendant volume, read only then.
 */
export type ConflictContext = { catalog: CatalogRow[]; filters: () => QuoteFilters; attendantFill: AttendantFill | null };

/** Whether a row's recorded conflict carries card data with no usable volume: its cards are priced from a typed or kept one. */
export function conflictNeedsVolume(row: Pick<ResearchView, "outcome" | "outcomePayload"> | null): boolean {
  if (row?.outcome !== "conflicting_sources") return false;
  const card = cardDataOf((row.outcomePayload ?? {}) as Record<string, unknown>);
  return card !== null && card.volume === null;
}

type ConflictAnswer = Extract<Standoff, { status: "conflicting_sources" }>;

/** Whether a stored payload's card data is in the shape research writes (D24 F1); anything else is the old shape. */
function cardDataOf(body: Record<string, unknown>): ConflictCardData | null {
  const card = body.card as ConflictCardData | undefined;
  if (!card || !Array.isArray(card.viscosityGrades) || card.viscosityGrades.length === 0 || !Array.isArray(card.gradeSources)) return null;
  const volume = card.volume as ConflictCardData["volume"] | undefined;
  // No source stated a usable volume: the attendant types it (orchestrator, 2026-10-01).
  if (volume === null) return card;
  if (volume?.kind === "agreed" && typeof volume.fillLiters === "number" && volume.source) return card;
  if (volume?.kind === "choices" && Array.isArray(volume.choices) && volume.choices.length >= 2) return card;
  return null;
}

const norm = (value: string) => value.trim().toLowerCase();

/**
 * A recorded conflict in the contract's shape. With its card data (D24 F1) it carries every stocked
 * oil of any disputed grade as a card, each citing the highest-authority source that lists its
 * grade; the filters; and the agreed volume, `volumeChoices` (highest authority first), or — no
 * source having stated a usable volume — none, or the kept `attendantFill` that prices it. Old-shape,
 * or with no context to price from, it carries `conflicts` only.
 */
function conflictAnswer(body: Record<string, unknown>, context: ConflictContext | null): ConflictAnswer {
  const conflicts = (body.conflicts ?? []) as ConflictAnswer["conflicts"];
  const card = context ? cardDataOf(body) : null;
  if (!card || !context) return { status: "conflicting_sources", conflicts };
  const sourceOf = (grade: string) => card.gradeSources.find((source) => norm(source.grade) === norm(grade));
  const options = filterCompatibleCatalogItems(context.catalog, { viscosityGrades: card.viscosityGrades }).flatMap((item) => {
    const source = sourceOf(item.lubricant.viscosity);
    if (!source) return [];
    const { grade, ...gradeSource } = source;
    void grade;
    return [{ ...item, gradeSource }];
  });
  const volume =
    card.volume === null
      ? context.attendantFill
        ? { attendantFill: context.attendantFill }
        : {}
      : card.volume.kind === "agreed"
        ? { fillLiters: card.volume.fillLiters, fillKind: card.volume.fillKind, fillCondition: card.volume.fillCondition, litersSource: card.volume.source }
        : { volumeChoices: card.volume.choices };
  return {
    status: "conflicting_sources",
    conflicts,
    viscosityGrades: card.viscosityGrades,
    classification: card.classification,
    gradeSources: card.gradeSources,
    options,
    filters: context.filters(),
    ...volume,
  };
}

/** Whether a row's recorded conflict carries card data (D24 F1): it is then claimed for Tecfil (D12). */
export function conflictHasCards(row: Pick<ResearchView, "outcome" | "outcomePayload"> | null): boolean {
  return row?.outcome === "conflicting_sources" && cardDataOf((row.outcomePayload ?? {}) as Record<string, unknown>) !== null;
}

/** The recorded clarification or conflict, in the contract's shape. */
function standoffOf(outcome: string | null, payload: unknown, context: ConflictContext | null): Standoff | null {
  const body = (payload ?? {}) as Record<string, unknown>;
  if (outcome === "needs_clarification") {
    return {
      status: "needs_clarification",
      coverage: body.coverage === "mismatch" ? "mismatch" : "several",
      options: Array.isArray(body.options) ? (body.options as string[]) : [],
    };
  }
  if (outcome === "conflicting_sources") return conflictAnswer(body, context);
  return null;
}

/** A research after the shown row that ended with a conflict or a clarification: never silently outvoted. */
export function laterStandoffOf(row: ResearchView | null, consultedAt: string, context: ConflictContext | null = null): Standoff | null {
  if (!row || !after(row, consultedAt)) return null;
  return standoffOf(row.outcome, row.outcomePayload, context);
}

/**
 * The recorded outcome of an identity with no cache row and no research under way (D15's last
 * row): no citable source, the clarification, the conflict, or `error` for a failure. A row in
 * any other state, or none, is "no source": nothing the quote could show was ever verified.
 *
 * @param context - What a conflict with card data is priced from; without it a conflict carries no cards.
 */
export function restingAnswer(row: ResearchView | null, context: ConflictContext | null = null): QuoteOptionsResult {
  if (row?.state === "failed") return { status: "error" };
  if (row?.state === "needs_clarification" || row?.state === "conflicting_sources") {
    const standoff = standoffOf(row.state, row.outcomePayload, context);
    if (standoff) return standoff;
  }
  return { status: "no_spec", reason: "no_source" };
}

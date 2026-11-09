/**
 * D10's mapping from what the pipeline returned to what research records — pure, no database,
 * no clock beyond the `now` it is handed.
 *
 * | Pipeline result | Recorded as |
 * |---|---|
 * | `verified`, complete or not | `verified`; the run records `incomplete` |
 * | `needs_clarification` / `conflicting_sources`, complete | that state, with its payload |
 * | `no_spec`, complete | `no_spec` (or the manual wait, decided by the caller); `searched: false` when the web did not run |
 * | a miss, a clarification or a conflict with `incomplete`; `unavailable` | transient; on the last attempt a clarification or a conflict stands, anything else is `failed` |
 */
import type { MotulCompatibility } from "../../contracts/http.js";
import { citedSource } from "../cited-source.js";
import type { SourceClassification } from "../../../../shared/web/source-classification.js";
import type { ConflictCards } from "../pipeline/conflicts.js";
import type { ClarifiedPassage, OilSpecResult, SourceCitation } from "../pipeline/oil-spec.js";
import type { ResearchIdentity } from "./enqueue.js";

/**
 * A passage kept for an engine pick (D24, orchestrator 2026-09-30): its publisher, document, page,
 * URL, tier, class and the excerpt read. Stored on a clarification's payload and copied onto the
 * `engine_pick` row.
 */
export type StoredPassage = {
  publisher: string;
  document: string;
  page: string;
  url: string | null;
  tier: number | null;
  classification: SourceClassification | null;
  excerpt: string;
};

/**
 * The payload a clarification is recorded with (D10): the coverage, the engines named (none, one
 * or several), and from PR 5 the passages it read, for an engine pick (D24). A clarification
 * recorded before PR 5 has no `passages`: its pick runs a full research (G1).
 */
export type ClarificationPayload = { coverage: "several" | "mismatch"; options: string[]; passages?: StoredPassage[] };

/** A disputed grade's or volume's source, as a conflict's card cites it (D24 F3). */
export type ConflictSource = {
  sourcePublisher: string;
  sourceDocument: string;
  sourcePage: string;
  sourceAuthority: number | null;
  sourceUrl: string | null;
  sourceClassification: SourceClassification | null;
};

/**
 * What a conflict's cards need (D24 F1, F2), recorded with it: the grades each with its source,
 * the classification, and the agreed volume, each source's volume, or — when no source stated a
 * usable one — null, so the attendant picks the grade and types the volume, as on `no_capacity`
 * (orchestrator, 2026-10-01: these states need a way out too).
 */
export type ConflictCardData = {
  viscosityGrades: string[];
  classification: string;
  gradeSources: (ConflictSource & { grade: string })[];
  volume:
    | { kind: "agreed"; fillLiters: number; fillKind: "em_servico" | "unlabeled"; fillCondition: "with_filter" | "unlabeled"; source: ConflictSource }
    | { kind: "choices"; choices: { liters: number; fillCondition: "with_filter" | "unlabeled"; source: ConflictSource }[] }
    | null;
};

/**
 * The payload a conflict is recorded with: the conflicts exactly as the contract carries them,
 * and from PR 5 its card data (D24 F1). A payload without `card` is the old shape, shown without cards.
 */
export type ConflictPayload = { conflicts: ConflictEntry[]; card?: ConflictCardData };

type ConflictEntry = {
  field: "viscosityGrades" | "fillLiters";
  values: { value: string; sourcePublisher: string; sourceDocument: string; sourcePage: string; sourceAuthority: number | null }[];
};

/** What the runner does with a pipeline result, before the manual wait and the last-attempt rule. */
export type MappedOutcome =
  | { kind: "verified"; cacheRow: Omit<MotulCompatibility, "id">; incomplete: boolean }
  | { kind: "no_spec"; searched: boolean }
  | { kind: "needs_clarification"; payload: ClarificationPayload }
  | { kind: "conflicting_sources"; payload: ConflictPayload }
  | { kind: "transient"; fallback?: { outcome: "needs_clarification" | "conflicting_sources"; payload: unknown } };

/** The verified spec as its cache row, written with the research row's own spelling (D6). */
export function cacheRowFrom(identity: ResearchIdentity, spec: Extract<OilSpecResult, { status: "verified" }>, now: Date): Omit<MotulCompatibility, "id"> {
  return {
    make: identity.make,
    year: identity.year,
    model: identity.model,
    version: identity.version,
    viscosityGrades: spec.viscosityGrades,
    viscosity: spec.viscosityGrades[0]!,
    classification: spec.classification,
    fillLiters: spec.fillLiters,
    fillKind: spec.fillKind,
    // The capacity type (ingest-harvested-manuals D5): of the priced liters, or, with none, of the
    // volume a source gave that a change does not use, kept so the quote can name it.
    fillCondition: spec.fillCondition ?? spec.unusableFill?.condition ?? null,
    unusableFillLiters: spec.unusableFill?.liters ?? null,
    consultedAt: now.toISOString(),
    rawPayload: null,
    ...citedSource(spec.citation),
    gradeSources: spec.gradeCitations.map(({ grade, citation }) => ({ grade, ...citedSource(citation) })),
    litersSource: spec.litersCitation ? citedSource(spec.litersCitation) : null,
  };
}

/** A citation as a conflict's card cites it. */
function conflictSource(citation: SourceCitation): ConflictSource {
  return {
    sourcePublisher: citation.publisher,
    sourceDocument: citation.document,
    sourcePage: citation.page,
    sourceAuthority: citation.authority ?? null,
    sourceUrl: citation.url ?? null,
    sourceClassification: citation.classification ?? null,
  };
}

/** The card data a conflict is recorded with; its `volume` is null when no source stated a usable one. */
function cardData(cards: ConflictCards | undefined): ConflictCardData | null {
  if (!cards) return null;
  const volume: ConflictCardData["volume"] =
    cards.volume === null
      ? null
      : cards.volume.kind === "agreed"
      ? { kind: "agreed", fillLiters: cards.volume.fillLiters, fillKind: cards.volume.fillKind, fillCondition: cards.volume.fillCondition, source: conflictSource(cards.volume.citation) }
      : { kind: "choices", choices: cards.volume.choices.map((choice) => ({ liters: choice.liters, fillCondition: choice.fillCondition, source: conflictSource(choice.citation) })) };
  return {
    viscosityGrades: cards.viscosityGrades,
    classification: cards.classification,
    gradeSources: cards.gradeCitations.map(({ grade, citation }) => ({ grade, ...conflictSource(citation) })),
    volume,
  };
}

/** A clarification's passages as its payload keeps them (D24). */
function storedPassages(passages: ClarifiedPassage[] | undefined): StoredPassage[] {
  return (passages ?? []).map((passage) => ({
    publisher: passage.publisher,
    document: passage.document,
    page: passage.page,
    url: passage.url ?? null,
    tier: passage.authority ?? null,
    classification: passage.classification ?? null,
    excerpt: passage.excerpt,
  }));
}

/** The clarification in its recorded shape, with its passages when it read any. */
export function clarificationPayload(result: Extract<OilSpecResult, { status: "needs_clarification" }>): ClarificationPayload {
  const passages = storedPassages(result.passages);
  return { coverage: result.coverage, options: result.options, ...(passages.length > 0 ? { passages } : {}) };
}

/** The conflicts in the contract's shape, highest authority first as the pipeline ordered them, and the card data. */
export function conflictPayload(result: Extract<OilSpecResult, { status: "conflicting_sources" }>): ConflictPayload {
  const card = cardData(result.cards);
  return {
    ...(card ? { card } : {}),
    conflicts: result.conflicts.map((conflict) => ({
      field: conflict.field,
      values: conflict.values.map((entry) => ({
        value: entry.value,
        sourcePublisher: entry.citation.publisher,
        sourceDocument: entry.citation.document,
        sourcePage: entry.citation.page,
        sourceAuthority: entry.citation.authority ?? null,
      })),
    })),
  };
}

/**
 * @param result - What `resolveOilSpec` returned.
 * @param identity - The research row's identity, whose spelling the cache row takes.
 * @param now - When the run records.
 */
export function mapPipelineResult(result: OilSpecResult, identity: ResearchIdentity, now: Date): MappedOutcome {
  const incomplete = result.incomplete === true;
  switch (result.status) {
    case "verified":
      return { kind: "verified", cacheRow: cacheRowFrom(identity, result, now), incomplete };
    case "needs_clarification": {
      const payload = clarificationPayload(result);
      return incomplete ? { kind: "transient", fallback: { outcome: "needs_clarification", payload } } : { kind: "needs_clarification", payload };
    }
    case "conflicting_sources": {
      const payload = conflictPayload(result);
      return incomplete ? { kind: "transient", fallback: { outcome: "conflicting_sources", payload } } : { kind: "conflicting_sources", payload };
    }
    case "no_spec":
      return incomplete ? { kind: "transient" } : { kind: "no_spec", searched: result.webNotSearched !== true };
    case "unavailable":
      return { kind: "transient" };
  }
}

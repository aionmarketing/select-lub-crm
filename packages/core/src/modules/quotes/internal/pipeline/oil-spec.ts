/**
 * Grounded oil-spec pipeline: retrieve a citable source, extract the SAE grades and the
 * service-fill liters from *that source*, then validate deterministically
 * (oil-quote-liters-pricing D10, D11, D12).
 *
 * The rule the whole module exists to enforce: a viscosity grade or a litre figure may only
 * reach a quote card if some retrieved, cited document said it. Nothing here falls back to a
 * model's pretrained memory, and nothing here picks which oil the workshop should sell —
 * catalog matching happens afterwards, on SAE equality.
 */
import { pickDryFillLiters, pickEngineFillLiters, type FlatRecommendation } from "../../../../kernel/clients/motul/index.js";
import type { FillCondition, FillKind, PricedFillCondition, UnusableFillCondition } from "../../contracts/http.js";
import { normalizeSaeGrade } from "../../contracts/http.catalog.js";
import type { SourceClassification } from "../../../../shared/web/source-classification.js";
import type { VehicleIdentity } from "../store/store.js";
import type { PassageSelector } from "./passage-selector.js";
import { authorityRank, clarifiedPassage, conflictCardsFrom, detectConflicts, verifiedFrom, withinCandidates, type Candidate, type ClarifiedPassage, type ConflictCards } from "./conflicts.js";
export type { ClarifiedPassage } from "./conflicts.js";
import { fillConditionOf, motulFill, validatedFill } from "./fill-condition.js";

export { detectConflicts, withinCandidates } from "./conflicts.js";

/** A source's tier in the prompt.md hierarchy: 1 is a manufacturer manual, 5 an aftermarket catalog. */
export type SourceAuthority = 1 | 2 | 3 | 4 | 5;

/** Where a retrieved document came from, carried onto the cache row and the dialog caption. */
export type SourceCitation = {
  publisher: string;
  document: string;
  page: string;
  /** The searching model's document class, when this source came from the web adapter. */
  classification?: SourceClassification;
  /** The passage read, kept for web sources whose page may change or disappear. */
  excerpt?: string;
  /** Tier in the source hierarchy. Optional only so fakes written before it stay valid. */
  authority?: SourceAuthority;
  /** Where the passage was read from. */
  url?: string;
};

/**
 * One retrieved source the extractor may read.
 *
 * `text` is prose from a manual or application guide and needs the model. `motul_flatten`
 * is an already-structured Oil Advisor payload, which this repo parses deterministically —
 * no model call, and therefore no chance of a hallucinated volume.
 */
export type RetrievedSource = SourceCitation & {
  /**
   * False when this source, whatever its tier, must not spare the paid web search: a stored
   * manual reading whose passage covered several engines is offered so the quote asks which,
   * but the web may find a single-engine source (review of #182). Absent means it may.
   */
  sparesWebSearch?: false;
  content:
    | { kind: "text"; text: string }
    | { kind: "motul_flatten"; recommendation: FlatRecommendation }
    /**
     * A reading already extracted from a stored manual (ingest-harvested-manuals D7): the quote
     * validates it like any other source but calls no model for it. `text` is the passage it
     * was read from, for an escalation read.
     */
    | { kind: "stored_spec"; spec: ExtractedOilSpec; text: string };
};

/**
 * What the adapter layer found. `needs_clarification` is a real outcome, not an error: two
 * engines matching the same identity must reach the attendant, never be silently narrowed
 * to the first one.
 */
export type RetrieveResult =
  | {
      status: "found";
      sources: RetrievedSource[];
      manualCandidates?: ManualCandidate[];
      /**
       * Set only when the web was searched: how many of `sources` it contributed, whether the
       * search completed with every admitted page read, and when it ran (the gate's clock).
       * A complete search whose pages all read cleanly and verified nothing is remembered as a
       * miss (owner, 2026-09-25; review of #176).
       */
      webSearch?: { sources: number; complete: boolean; searchedAt: string };
      /** Admitted URLs the web adapter did not read (a failure or the budget). See `webSearch`. */
      unreadAdmitted?: number;
      /**
       * Some source could not be read: a local adapter answered `unavailable`, or the web
       * search was left incomplete (background-oil-research D10). Research retries it.
       */
      incomplete?: true;
      /** The web adapter did not search at all (disabled, or no key). */ notSearched?: true;
    }
  | { status: "needs_clarification"; options: string[] }
  | {
      status: "none";
      manualCandidates?: ManualCandidate[];
      unreadAdmitted?: number;
      /** The web adapter did not search at all (disabled, or no key): never a miss. `incomplete`: see `found`'s. */
      notSearched?: true; incomplete?: true;
    }
  | {
      status: "unavailable";
      /**
       * Documents the web found while another adapter (Motul) was down: an outage must not
       * discard a lead already paid for (oil-research-web-retrieval D4).
       */
      manualCandidates?: ManualCandidate[];
    };

/**
 * A document an adapter found and deliberately did not open.
 *
 * Today that means a PDF — usually the manufacturer's own manual, the top of the hierarchy.
 * Reading it needs page-faithful extraction and storage, which is GitHub #77; recording it
 * here means the search's best find is logged rather than silently dropped, and #77 has real
 * production data about what it will be ingesting.
 *
 * Server-side only: this rides on the internal retrieval result and the log, never on the
 * quote-options HTTP contract, because nothing downstream can act on it yet.
 */
export type ManualCandidate = {
  url: string;
  publisher: string;
  classification: SourceClassification;
  tier: 1 | 2 | 3 | 4 | 5;
  /**
   * The page this document was linked from, when it was not itself a search result.
   *
   * A manufacturer's manuals page is a gateway — no oil spec in its prose, the documents in
   * its links. Such a document inherits the linking page's classification and tier, which is
   * only sound because harvesting is restricted to the same origin: a PDF served by the
   * publisher whose page the model classified is that publisher's document. #77 needs to know
   * which candidates came in this way, because they were never classified individually.
   */
  discoveredVia?: string;
  /** The label the linking page gave the document, e.g. "Manual Novo Polo 2021" (D8). */
  label?: string | null;
  /** Why the document survived the per-page cap; null when there was no cap to survive. */
  selectionReason?: string | null;
};

/**
 * Asks the configured adapters for citable sources on one vehicle identity.
 *
 * Implementations MUST NOT run an unrestricted web search per quote (D10 step 3).
 */
export type AuthoritativeSourceRetriever = (
  identity: VehicleIdentity,
  options?: RetrieveOptions,
) => Promise<RetrieveResult>;

/** Per-request knobs a retriever may honour. */
export type RetrieveOptions = {
  /**
   * Search even when a recent search for this identity found nothing.
   *
   * True only when the attendant explicitly asked to fetch again: they are telling us the
   * world may have changed, and the remembered miss is exactly what would stop us looking.
   */
  forceWebSearch?: boolean;
};

/**
 * How well the retrieved passage covers the engine of the car being quoted.
 *
 * A *refusal* signal, never a selection one: `several` and `mismatch` stop the quote, and
 * nothing here ever picks an engine or fills one in.
 *
 * **What it reliably catches:** a passage that visibly lists more than one engine. Measured
 * against GLM-5.3-Flash on a three-engine HR-V table, it answered `several` and named all
 * three verbatim.
 *
 * **What it does NOT catch, by construction:** a passage about one engine that is the wrong
 * engine for the car — the CarroRac `1.5i-VTEC` row handed to a `Honda HR-V 2021 EX CVT`
 * quote still came back `one`. Deciding that `EX CVT` means the 1.8 in Brazil requires
 * knowing Honda's trim table, and a model that answers it is answering from pretrained
 * memory, which this whole module forbids. That resolution belongs in a deterministic
 * variant-to-engine table (GitHub #76), exactly as `prompt.md` prescribes. Do not read this
 * signal as protection against a mis-identified vehicle.
 */
export type EngineCoverage = "one" | "several" | "mismatch" | "unknown";

/** Facts an extractor may report, plus its judgement of whether the passage fits the car. */
export type ExtractedOilSpec = {
  viscosityGrades: string[];
  classification: string;
  fillLiters: number | null;
  fillKind: FillKind | null;
  /**
   * What `fillLiters` is (D5): with the filter, without it, dry, or unlabeled. Absent on an
   * extractor that predates it: read from `fillKind` (`em_servico` is `with_filter`).
   */
  fillCondition?: FillCondition | null;
  /**
   * After validation: a volume the source gave that a change does not use (without the filter,
   * or dry), kept for the record and the attendant's message, never priced. `fillCondition`
   * then says which.
   */
  unusableFillLiters?: number | null;
  /**
   * Whether the passage describes this vehicle's engine. `unknown` on an extractor that
   * does not report it, which is treated as "do not block" so older fakes keep working.
   */
  engineCoverage?: EngineCoverage;
  /** The engine(s) the passage names, verbatim, for the Portuguese clarification message. */
  enginesNamed?: string[];
};

/**
 * Reads {@link ExtractedOilSpec} out of one retrieved source.
 *
 * Receives the identity alongside the source for ONE purpose: so it can report whether the
 * passage covers one engine or several (`engineCoverage`). It may not use the identity to
 * supply a grade or a volume — those come from the passage or not at all.
 *
 * Note that passing the identity weakens a guarantee that used to be structural: the
 * extractor could not answer from memory because it did not know which car was being
 * quoted. That is now an instruction rather than an impossibility. The compensating
 * controls are the validator, which only ever reads extracted fields, and the tests that
 * assert a memory-only answer is rejected.
 *
 * @returns The extracted facts, or `null` when the source does not state them.
 */
export type OilSpecExtractor = (
  source: RetrievedSource,
  identity: VehicleIdentity,
) => Promise<ExtractedOilSpec | null | ExtractionFailed>;

/**
 * The extractor could not read the passage — no key, a timeout, a provider error, a reply it
 * could not parse twice. Distinct from `null`, which means it read the passage and the
 * passage stated nothing: only that may be remembered as a miss (review of #176, 2026-09-25).
 */
export const EXTRACTION_FAILED = { status: "extraction_failed" } as const;

/** See {@link EXTRACTION_FAILED}. */
export type ExtractionFailed = typeof EXTRACTION_FAILED;

/** Whether an extractor's answer is {@link EXTRACTION_FAILED}. */
export function isExtractionFailed(value: ExtractedOilSpec | null | ExtractionFailed): value is ExtractionFailed {
  return value != null && "status" in value && value.status === EXTRACTION_FAILED.status;
}

/** A spec that survived retrieval, extraction, and validation. Safe to price a card with. */
export type VerifiedOilSpec = {
  viscosityGrades: string[];
  classification: string;
  fillLiters: number | null;
  fillKind: FillKind | null;
  /** What `fillLiters` is: with the filter, or the single unlabeled volume; null with no liters. */
  fillCondition: PricedFillCondition | null;
  /**
   * When no source gave a volume a change uses: the one a source did give, without the filter
   * or dry, so the attendant is told why there is no price (D5). Null otherwise.
   */
  unusableFill: { liters: number; condition: UnusableFillCondition } | null;
  /** The primary source: the highest authority among those that agreed. */
  citation: SourceCitation;
  /**
   * Each grade with the source it is cited to: the highest-authority source that LISTS it,
   * never one that does not (owner, 2026-09-25; D11). In `viscosityGrades` order.
   */
  gradeCitations: { grade: string; citation: SourceCitation }[];
  /** The source that stated the liters, or null when no liters were verified. */
  litersCitation: SourceCitation | null;
  /** Dry fill when the source stated one. Recorded for audit; never a multiplier. */
  dryFillLiters: number | null;
  /** True when sources disagreed and the escalation read settled it within their values. */
  settledByEscalation?: true;
};

/**
 * Why no verified spec came back. Each maps to a distinct Portuguese state in the dialog.
 *
 * `unavailable` (every adapter was down) is kept apart from `no_spec` (adapters answered,
 * the car simply is not covered) because only the first one may offer the attendant the
 * previous cache row.
 */
export type OilSpecMiss =
  | { status: "no_spec" }
  | { status: "unavailable" }
  /** `passages`: what an engine pick re-reads (D24); absent when none was read (Motul's "needs"). */
  | { status: "needs_clarification"; coverage: ClarificationCoverage; options: string[]; passages?: ClarifiedPassage[] }
  /** `cards`: what the conflict's cards need (D24 F1). */
  | { status: "conflicting_sources"; conflicts: SourceConflict[]; cards?: ConflictCards };

/**
 * Why a clarification is asked (background-oil-research D10): the source names several engines
 * (`several`; Motul's "more than one engine matches" maps here too), or describes another one
 * (`mismatch`). The engines it named may be none, one or several.
 */
export type ClarificationCoverage = "several" | "mismatch";

/** One source's answer for a disputed field, kept next to where it came from. */
export type ConflictValue = {
  /** Grades joined by ", " or the litre figure as text; the dialog formats by field. */
  value: string;
  citation: SourceCitation;
};

/**
 * Two or more validated sources disagreeing on one field (prompt.md "Conflict handling").
 * Values are ordered highest authority first, so a UI that shows the first one is showing
 * the preferred one — while still showing the rest, which is the whole point.
 */
export type SourceConflict = {
  field: "viscosityGrades" | "fillLiters";
  values: ConflictValue[];
};

/** What the escalation model is given: every disputed passage, the car, and the dispute. */
export type EscalationInput = {
  sources: RetrievedSource[];
  identity: VehicleIdentity;
  conflicts: SourceConflict[];
};

/**
 * One stronger read over all conflicting passages together (prompt.md "Model routing":
 * escalate once, then return `conflicting_sources`; do not guess).
 *
 * Its answer is not trusted on its own: {@link resolveOilSpec} accepts it only when every
 * grade and the volume are values some source already stated. It can settle which passage
 * applies; it cannot introduce a number.
 */
export type OilSpecEscalator = (input: EscalationInput) => Promise<ExtractedOilSpec | null | EscalationFailed>;

/**
 * The escalation read failed — an error, a timeout, a reply that is not one — as opposed to the
 * model declining (`null`). A failure leaves a conflict unsettled that could have been settled,
 * so research retries it as an outage (background-oil-research D10); until then the quote shows
 * the conflict, as for a decline.
 */
export const ESCALATION_FAILED = { status: "escalation_failed" } as const;

/** See {@link ESCALATION_FAILED}. */
export type EscalationFailed = typeof ESCALATION_FAILED;

/** Whether an escalator's answer is {@link ESCALATION_FAILED}. */
export function isEscalationFailed(value: ExtractedOilSpec | null | EscalationFailed): value is EscalationFailed {
  return value != null && "status" in value && value.status === ESCALATION_FAILED.status;
}

/** Outcome of {@link resolveOilSpec}. */
export type OilSpecResult = (({ status: "verified" } & VerifiedOilSpec) | OilSpecMiss) & {
  /**
   * The documents retrieval found and did not read, whatever the outcome: a `no_spec` quote
   * still records what it found (D9). The caller persists them; nothing reaches the HTTP
   * contract.
   */
  manualCandidates?: ManualCandidate[];
  /**
   * Set when the web search contributed sources, every admitted page was read, every
   * extraction ran, and none stated a usable spec — the quote is `no_spec` after a search that
   * read pages with nothing in them. The caller remembers it like an empty search, at the
   * gate's `searchedAt` (oil-spec-web-search "A miss is not searched again within a window";
   * owner, 2026-09-25). A failure anywhere — a page not read, an extraction that did not run —
   * leaves it unset: a failure is not evidence of absence (review of #176).
   */
  webFoundUnverified?: { searchedAt: string };
  /**
   * Set when an escalation failed — as opposed to declining — so a conflict stands that could
   * have been settled. The quote still shows the conflict; background research (PR 3) reads it
   * as an incomplete run to retry (background-oil-research D10).
   */
  escalationFailed?: true;
  /**
   * Some source could not be read or settled (background-oil-research D10): an extraction that
   * failed or was cut by a limit, an escalation that failed, a web search left incomplete, or a
   * local adapter that answered `unavailable`. Research reads a miss, a clarification or a
   * conflict that carries it as an outage to retry, never as a resting outcome; a verified spec
   * that carries it is kept.
   */
  incomplete?: true;
  /** The web search did not run because it is disabled or has no key (D10): never a miss. */
  webNotSearched?: true;
};

/** Ports the pipeline runs on, injected so tests never touch the network or a model. */
export type OilSpecPorts = {
  retrieve: AuthoritativeSourceRetriever;
  extract: OilSpecExtractor;
  /**
   * Narrows a text source to the passage about this vehicle before extraction. Absent means
   * the extractor reads the whole capped page — what shipped before the selector existed,
   * and what a failing selector falls back to.
   */
  selectPassage?: PassageSelector;
  /** Absent means "no escalation tier": a conflict goes straight to the attendant. */
  escalate?: OilSpecEscalator;
};

/** Widest plausible crankcase service fill, in liters. Beyond this the figure is not a car. */
export const MAX_PLAUSIBLE_FILL_LITERS = 20;

/**
 * The SAE normalization lives with the catalog contract since add-lubricant-oil-type, so the
 * web can apply the same rule when it decides whether a card's description already names its
 * grade. Re-exported here for the pipeline's callers.
 */
export { normalizeSaeGrade };

/**
 * Keeps the grades that are real SAE multigrades, in source order, without duplicates.
 *
 * The list is never collapsed to one entry (D12): a source that lists `5W-30` and `5W-40`
 * must be able to offer a catalog card for each.
 *
 * @param grades - Grades as the source listed them.
 * @returns Normalized grades; empty when none were valid.
 */
export function normalizeSaeGrades(grades: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const grade of grades) {
    const normalized = normalizeSaeGrade(grade);
    if (normalized != null) {
      seen.add(normalized);
    }
  }
  return [...seen];
}

/**
 * Reads the motor part of a flattened Motul recommendation, whatever case the key uses.
 *
 * @param recommendation - Flattened Motul recommendation.
 * @returns The motor category part, or `undefined` when the payload has none.
 */
function motorPart(recommendation: FlatRecommendation) {
  return (
    recommendation.parts.Motor ??
    recommendation.parts.motor ??
    Object.entries(recommendation.parts).find(([key]) => key.toLowerCase() === "motor")?.[1]
  );
}

/**
 * Reads every motor SAE grade a Motul flatten payload lists.
 *
 * Deliberately walks *all* recommended motor products. Reading `products[0]` alone is the
 * bug this change exists to remove: Motul commonly lists more than one valid grade.
 *
 * @param recommendation - Flattened Motul recommendation.
 * @returns Normalized grades in Motul's order.
 */
export function motulViscosityGrades(recommendation: FlatRecommendation): string[] {
  const names = (motorPart(recommendation)?.products ?? []).flatMap((product) => {
    const match = /(\d{1,2}W-?\d{1,2})/.exec(product.name ?? "");
    return match ? [match[1]!] : [];
  });
  return normalizeSaeGrades(names);
}

/**
 * Reads the first motor classification/approval a Motul flatten payload states.
 *
 * @param recommendation - Flattened Motul recommendation.
 * @returns The spec string, or the empty string when the payload states none.
 */
function motulClassification(recommendation: FlatRecommendation): string {
  const products = motorPart(recommendation)?.products ?? [];
  const withSpec = products.find((product) => (product.spec ?? "").trim() !== "");
  return withSpec?.spec?.trim() ?? "";
}

/**
 * Extracts a Motul flatten payload deterministically — no model call.
 *
 * @param recommendation - Flattened Motul recommendation.
 * @returns Grades, classification, and the D1 service-fill liters.
 */
export function extractFromMotulFlatten(recommendation: FlatRecommendation): ExtractedOilSpec {
  return {
    viscosityGrades: motulViscosityGrades(recommendation),
    classification: motulClassification(recommendation),
    ...motulFill(pickEngineFillLiters(recommendation), () => pickDryFillLiters(recommendation)),
  };
}

/**
 * Rejects anything the source could not have meant as a service fill.
 *
 * @param spec - Freshly extracted facts.
 * Liters price only as `with_filter` or `unlabeled` (D5; the owner, 2026-09-26: an unlabeled figure
 * only when it is the single volume the source gives — the extractor is told so, and Motul's
 * picker enforces it). A `without_filter` or `dry` volume is moved to `unusableFillLiters`.
 *
 * @returns The same facts with liters cleared when they are implausible, carry no legend or are
 *   a volume a change does not use, and with grades normalized; `null` when no valid SAE grade
 *   survived.
 */
export function validateExtractedSpec(spec: ExtractedOilSpec): ExtractedOilSpec | null {
  const viscosityGrades = normalizeSaeGrades(spec.viscosityGrades);
  if (viscosityGrades.length === 0) {
    return null;
  }
  const plausible =
    spec.fillLiters != null && Number.isFinite(spec.fillLiters) && spec.fillLiters > 0 && spec.fillLiters <= MAX_PLAUSIBLE_FILL_LITERS;
  return {
    viscosityGrades,
    classification: spec.classification.trim(),
    ...validatedFill(plausible ? spec.fillLiters : null, plausible ? fillConditionOf(spec) : null),
    ...(spec.engineCoverage ? { engineCoverage: spec.engineCoverage } : {}),
    ...(spec.enginesNamed ? { enginesNamed: spec.enginesNamed } : {}),
  };
}

/**
 * Runs retrieve then extract then validate for one vehicle identity.
 *
 * The extractor is called only with a source in hand, once per retrieved source. Every
 * source that validates becomes a candidate; candidates are ordered by authority and
 * compared. Agreement (or a single candidate) verifies. Disagreement goes to the escalation
 * read when one is configured, whose answer is accepted only within the candidates' own
 * values; otherwise it is returned as `conflicting_sources`, never averaged or silently
 * decided. A source that states grades but no capacity still counts: the caller then shows
 * `no_capacity` rather than pricing a card from the unit price alone.
 *
 * @param identity - CRM make/year/model/version.
 * @param ports - Injected retriever and extractor.
 * @returns A verified spec, a clarification request, or `no_spec`, with the manual
 *   candidates retrieval found, whatever the status.
 */
export async function resolveOilSpec(
  identity: VehicleIdentity,
  ports: OilSpecPorts,
  options?: RetrieveOptions,
): Promise<OilSpecResult> {
  const retrieved = await ports.retrieve(identity, options);
  const trace: PipelineTrace = { extractionFailed: false, escalationFailed: false };
  const result = await specFromRetrieved(retrieved, identity, ports, trace);
  const leads = retrieved.status === "needs_clarification" ? [] : (retrieved.manualCandidates ?? []);
  const web = retrieved.status === "found" ? retrieved.webSearch : undefined;
  const webFoundUnverified =
    web != null && web.complete && web.sources > 0 && !trace.extractionFailed && result.status === "no_spec";
  const answered = retrieved.status === "found" || retrieved.status === "none" ? retrieved : null;
  // Some source unread or unsettled (D10): an extraction or escalation failed, or retrieval left one unread.
  const incomplete = trace.extractionFailed || trace.escalationFailed || (answered !== null && (answered.incomplete === true || (web != null && !web.complete) || (answered.unreadAdmitted ?? 0) > 0));
  return {
    ...result,
    ...(leads.length > 0 ? { manualCandidates: leads } : {}),
    ...(webFoundUnverified ? { webFoundUnverified: { searchedAt: web.searchedAt } } : {}),
    ...(trace.escalationFailed ? { escalationFailed: true as const } : {}),
    ...(incomplete ? { incomplete: true as const } : {}),
    ...(answered?.notSearched ? { webNotSearched: true as const } : {}),
  };
}

/** What went wrong on the way, beside the outcome. */
type PipelineTrace = { extractionFailed: boolean; escalationFailed: boolean };

/** Extract, validate and compare what retrieval found; see {@link resolveOilSpec}. */
async function specFromRetrieved(
  retrieved: RetrieveResult,
  identity: VehicleIdentity,
  ports: OilSpecPorts,
  trace: PipelineTrace,
): Promise<OilSpecResult> {
  if (retrieved.status === "needs_clarification") {
    // Motul matched more than one engine for the identity: several (D10).
    return { status: "needs_clarification", coverage: "several", options: retrieved.options };
  }
  if (retrieved.status === "unavailable") {
    return { status: "unavailable" };
  }
  if (retrieved.status !== "found" || retrieved.sources.length === 0) {
    return { status: "no_spec" };
  }

  const candidates: Candidate[] = [];
  for (const source of retrieved.sources) {
    // The passage first. A page is read for the part about THIS vehicle, and a page the
    // selector says has no such part is not read at all — a menu or a download index must
    // not reach the extractor just because it was fetched.
    let candidateSource = source;
    if (ports.selectPassage && source.content.kind === "text") {
      const selection = await ports.selectPassage(source, identity);
      if (selection.status === "none") {
        continue;
      }
      if (selection.status === "selected") {
        candidateSource = selection.source;
      } else if (selection.fallback) {
        // `unavailable`: the selector failed, so the narrowed text is read (D4); a page with no
        // hit to narrow to is read capped, as before.
        candidateSource = selection.fallback;
      }
    }
    const extracted = await ports.extract(candidateSource, identity);
    if (isExtractionFailed(extracted)) {
      // Unread, not empty: the quote still misses, but nothing may remember it as absent.
      trace.extractionFailed = true;
      continue;
    }
    if (extracted == null) {
      continue;
    }
    // A passage about the wrong engine, or about several, stops the quote here. It is not
    // a `no_spec` (the source exists and is readable) and not a silent extraction (the
    // numbers would have been real, just for another car).
    if (extracted.engineCoverage === "several" || extracted.engineCoverage === "mismatch") {
      // The passage is kept, so an engine pick re-reads it for one engine (D24).
      const passage = clarifiedPassage(candidateSource);
      const options = extracted.enginesNamed?.length ? extracted.enginesNamed : [];
      return { status: "needs_clarification", coverage: extracted.engineCoverage, options, ...(passage ? { passages: [passage] } : {}) };
    }
    const validated = validateExtractedSpec(extracted);
    if (validated == null) {
      continue;
    }
    // The narrowed source is what gets cited: its excerpt IS the passage the spec came from.
    candidates.push({ spec: validated, source: candidateSource });
  }
  if (candidates.length === 0) {
    return { status: "no_spec" };
  }

  // Highest authority first. Every read of `candidates[0]` below relies on this.
  candidates.sort((a, b) => authorityRank(a.source) - authorityRank(b.source));

  const conflicts = detectConflicts(candidates);
  if (conflicts.length === 0) {
    return verifiedFrom(candidates);
  }

  if (ports.escalate) {
    const settled = await ports.escalate({
      sources: candidates.map((candidate) => candidate.source),
      identity,
      conflicts,
    });
    if (isEscalationFailed(settled)) {
      trace.escalationFailed = true;
    }
    const validated = settled == null || isEscalationFailed(settled) ? null : validateExtractedSpec(settled);
    if (validated != null && withinCandidates(validated, candidates)) {
      return { ...verifiedFrom(candidates, validated), settledByEscalation: true };
    }
  }
  return { status: "conflicting_sources", conflicts, cards: conflictCardsFrom(candidates) };
}

/**
 * The extractor used in production: deterministic for Motul payloads and stored manual
 * readings, model-backed for prose.
 *
 * @param textExtractor - Model-backed extractor for `text` sources.
 * @returns An extractor that never sends a structured Motul payload to a model.
 */
export function createOilSpecExtractor(textExtractor: OilSpecExtractor): OilSpecExtractor {
  return async (source, identity) => {
    if (source.content.kind === "motul_flatten") {
      // Oil Advisor resolved the submodel before answering, so the payload is already
      // about one engine; there is nothing for a coverage check to add.
      return { ...extractFromMotulFlatten(source.content.recommendation), engineCoverage: "one" };
    }
    if (source.content.kind === "stored_spec") {
      // Extracted once, when the manual was read; what the model said then is the extraction.
      return source.content.spec;
    }
    return textExtractor(source, identity);
  };
}

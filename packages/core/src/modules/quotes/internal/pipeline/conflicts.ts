/**
 * Comparing the sources that validated: authority order, where they disagree, what an
 * escalation may answer, and the verified spec they agree on. Split out of `oil-spec.ts`
 * (its line limit); `resolveOilSpec` there is the caller.
 */
import { pickDryFillLiters } from "../../../../kernel/clients/motul/index.js";
import type { PricedFillCondition, UnusableFillCondition } from "../../contracts/http.js";
import { fillConditionOf } from "./fill-condition.js";
import type { ExtractedOilSpec, RetrievedSource, SourceCitation, SourceConflict, VerifiedOilSpec } from "./oil-spec.js";

/** A source that extracted and validated, kept with what it said. */
export type Candidate = { spec: ExtractedOilSpec; source: RetrievedSource };

/**
 * Sort key for the prompt.md hierarchy: 1 (manufacturer manual) sorts first. A source
 * that never declared its tier sorts after every one that did.
 */
export function authorityRank(source: RetrievedSource): number {
  return source.authority ?? 6;
}

/** Order-insensitive identity for a grade list, so `5W-30, 5W-40` equals `5W-40, 5W-30`. */
/**
 * Whether two grade lists disagree: each names a grade the other lacks (D11). One listing a
 * subset of the other is not a disagreement — a source that names only the first-fill grade
 * is silent on the alternatives, not contradicting them.
 */
function gradesConflict(a: readonly string[], b: readonly string[]): boolean {
  const inA = new Set(a);
  const inB = new Set(b);
  return a.some((grade) => !inB.has(grade)) && b.some((grade) => !inA.has(grade));
}

/** Every grade the agreeing sources name, in authority order, each once. */
function unionGrades(candidates: readonly Candidate[]): string[] {
  return [...new Set(candidates.flatMap((c) => c.spec.viscosityGrades))];
}

/**
 * Finds the fields on which validated sources disagree.
 *
 * Grades conflict only when two sources each name a grade the other lacks; a subset agrees
 * (D11). Liters are compared only when both sides state one — a source that is silent on
 * volume is not contradicting one that states it. Classification is deliberately not
 * compared: it is informational, not a filter (D13), so it is not a conflict either.
 *
 * @param candidates - Validated sources, highest authority first.
 * @returns One entry per disputed field, each listing every source's value in authority order.
 */
export function detectConflicts(candidates: readonly Candidate[]): SourceConflict[] {
  const conflicts: SourceConflict[] = [];

  const gradeConflict = candidates.some((c, i) =>
    candidates.slice(i + 1).some((other) => gradesConflict(c.spec.viscosityGrades, other.spec.viscosityGrades)),
  );
  if (gradeConflict) {
    conflicts.push({
      field: "viscosityGrades",
      values: candidates.map((c) => ({
        value: c.spec.viscosityGrades.join(", "),
        citation: citationOf(c.source),
      })),
    });
  }

  const withLiters = candidates.filter((c) => c.spec.fillLiters != null);
  const literValues = new Set(withLiters.map((c) => c.spec.fillLiters));
  if (literValues.size > 1) {
    conflicts.push({
      field: "fillLiters",
      values: withLiters.map((c) => ({
        value: String(c.spec.fillLiters),
        citation: citationOf(c.source),
      })),
    });
  }
  return conflicts;
}

/**
 * The guardrail on escalation: the stronger model may only pick among what the sources
 * said. Every grade must appear in some candidate's list, and the volume must be one some
 * candidate stated (or null). Anything else is a number nobody cited, and is refused.
 */
export function withinCandidates(spec: ExtractedOilSpec, candidates: readonly Candidate[]): boolean {
  const knownGrades = new Set(candidates.flatMap((c) => c.spec.viscosityGrades));
  if (!spec.viscosityGrades.every((grade) => knownGrades.has(grade))) {
    return false;
  }
  if (spec.fillLiters == null) {
    return true;
  }
  return candidates.some((c) => c.spec.fillLiters === spec.fillLiters);
}

function citationOf(source: RetrievedSource): SourceCitation {
  return {
    publisher: source.publisher,
    document: source.document,
    page: source.page,
    ...(source.authority != null ? { authority: source.authority } : {}),
    ...(source.url != null ? { url: source.url } : {}),
    ...(source.classification != null ? { classification: source.classification } : {}),
    ...(source.excerpt != null ? { excerpt: source.excerpt } : {}),
  };
}

/**
 * What a conflict's cards need (background-oil-research D24 F1, F2): every grade any source
 * lists, each cited to the highest-authority source that lists it (never one that does not); the
 * classification of the highest-authority source; and the volume — the one the sources agree on,
 * with its type and source, or one choice per distinct volume, highest authority first. Null
 * `volume` when no source stated a usable one.
 */
export type ConflictCards = {
  viscosityGrades: string[];
  classification: string;
  gradeCitations: { grade: string; citation: SourceCitation }[];
  volume:
    | { kind: "agreed"; fillLiters: number; fillKind: NonNullable<ExtractedOilSpec["fillKind"]>; fillCondition: PricedFillCondition; citation: SourceCitation }
    | { kind: "choices"; choices: { liters: number; fillCondition: PricedFillCondition; citation: SourceCitation }[] }
    | null;
};

/**
 * @param candidates - Validated sources, highest authority first.
 * @returns The conflict's card data.
 */
export function conflictCardsFrom(candidates: readonly Candidate[]): ConflictCards {
  const top = candidates[0]!;
  const viscosityGrades = unionGrades(candidates);
  const withLiters = candidates.filter((c) => c.spec.fillLiters != null && c.spec.fillKind != null);
  const distinct: Candidate[] = [];
  for (const candidate of withLiters) {
    if (!distinct.some((seen) => seen.spec.fillLiters === candidate.spec.fillLiters)) distinct.push(candidate);
  }
  let volume: ConflictCards["volume"] = null;
  if (distinct.length === 1) {
    const [only] = distinct;
    volume = { kind: "agreed", fillLiters: only!.spec.fillLiters!, fillKind: only!.spec.fillKind!, fillCondition: pricedCondition(only!.spec), citation: citationOf(only!.source) };
  } else if (distinct.length > 1) {
    volume = {
      kind: "choices",
      choices: distinct.map((c) => ({ liters: c.spec.fillLiters!, fillCondition: pricedCondition(c.spec), citation: citationOf(c.source) })),
    };
  }
  return {
    viscosityGrades,
    classification: top.spec.classification,
    gradeCitations: viscosityGrades.map((grade) => ({
      grade,
      citation: citationOf((candidates.find((c) => c.spec.viscosityGrades.includes(grade)) ?? top).source),
    })),
    volume,
  };
}

/** A passage a clarification read (D24): its source and the text itself. */
export type ClarifiedPassage = SourceCitation & { excerpt: string };

/**
 * The passage a source was read from, as a clarification keeps it (D24): its citation and the
 * text the extractor read, so an engine pick can re-read it. A Motul payload has no text to keep.
 */
export function clarifiedPassage(source: RetrievedSource): ClarifiedPassage | null {
  const text = source.content.kind === "motul_flatten" ? null : source.content.text;
  if (!text?.trim()) return null;
  return { ...citationOf(source), excerpt: text };
}

/** The priced capacity type of a validated spec's liters. */
function pricedCondition(spec: ExtractedOilSpec): PricedFillCondition {
  return fillConditionOf(spec) === "unlabeled" ? "unlabeled" : "with_filter";
}

/** The highest-authority unusable volume, when no candidate gave one a change uses. */
function unusableFillOf(candidates: readonly Candidate[]): { liters: number; condition: UnusableFillCondition } | null {
  for (const { spec } of candidates) {
    const condition = spec.fillCondition;
    if (spec.unusableFillLiters != null && (condition === "without_filter" || condition === "dry")) {
      return { liters: spec.unusableFillLiters, condition };
    }
  }
  return null;
}

/**
 * Builds the verified result from agreeing candidates (or from an escalation answer).
 *
 * The grades are the union of what the candidates list, and each is cited to the
 * highest-authority candidate that lists it (D11). Liters come from, and are cited to, the
 * highest-authority candidate that STATES them: a lower source filling a gap the higher one
 * left is not the "silent override" prompt.md forbids — nothing was overridden. `citation`
 * is the highest-authority candidate overall, the primary source older readers show.
 *
 * The capacity type (D5) and its legend are the cited liters source's, never an escalation's
 * answer: the escalation only chooses among the candidates' values, and the caption must say
 * what the source the liters are cited to says (review of #189).
 *
 * @param candidates - Validated sources, highest authority first.
 * @param settled - When escalation answered, its (already guarded) spec.
 */
export function verifiedFrom(
  candidates: readonly Candidate[],
  settled?: ExtractedOilSpec,
): { status: "verified" } & VerifiedOilSpec {
  const top = candidates[0]!;
  const literSource =
    settled?.fillLiters != null
      ? candidates.find((c) => c.spec.fillLiters === settled.fillLiters)!
      : (candidates.find((c) => c.spec.fillLiters != null) ?? top);
  const spec = settled ?? top.spec;
  // Agreeing sources may list different subsets; the spec is everything they name (D11).
  // An escalation's answer is already confined to the candidates' own values.
  const viscosityGrades = settled ? spec.viscosityGrades : unionGrades(candidates);
  const fillLiters = settled ? settled.fillLiters : literSource.spec.fillLiters;
  return {
    status: "verified",
    viscosityGrades,
    classification: top.spec.classification,
    fillLiters,
    // Both from the source the liters are cited to (literSource), so caption and citation agree.
    fillKind: fillLiters == null ? null : literSource.spec.fillKind,
    fillCondition: fillLiters == null ? null : pricedCondition(literSource.spec),
    unusableFill: fillLiters == null ? unusableFillOf(candidates) : null,
    citation: citationOf(top.source),
    // Candidates are highest authority first, so `find` is the best source that LISTS the
    // grade. Every grade has one: the union, or an escalation confined by withinCandidates.
    gradeCitations: viscosityGrades.map((grade) => ({
      grade,
      citation: citationOf((candidates.find((c) => c.spec.viscosityGrades.includes(grade)) ?? top).source),
    })),
    litersCitation: fillLiters == null ? null : citationOf(literSource.source),
    dryFillLiters:
      top.source.content.kind === "motul_flatten"
        ? pickDryFillLiters(top.source.content.recommendation)
        : null,
  };
}

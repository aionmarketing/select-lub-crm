/**
 * Stored manual readings as sources (ingest-harvested-manuals D6/D7).
 *
 * Each verified reading becomes a `RetrievedSource`: the publisher is the host, the document the
 * candidate's label (or the file name), the page the one it was read from ("p. N"), and the
 * authority the tier its class maps to — a manufacturer's manual is tier 1. Its content is the
 * extraction already made, so the quote validates it, checks its engine coverage, orders it,
 * detects conflicts and cites it per grade like any other source, but calls no model for it.
 *
 * A reading is tier 1, stored for good, and spares the paid web search, so it is held to more
 * than a model's word (review of #182):
 * - **Anchored.** Every grade, and the liters, must appear in the passage it was read from —
 *   SAE with or without the hyphen or a space, liters with a comma or a dot. A value the text does
 *   not carry (a page that told the model what to answer, a model that answered from memory) is
 *   not a source.
 * - **The capacity type decides the price** (D5, PR 4; replaces #182's interim in-service-only
 *   rule): the validator prices a with-filter volume, or an unlabeled one that is the single
 *   volume the passage gives, and keeps a without-filter or dry one aside to tell the attendant.
 * - **Several engines does not spare the search.** A reading whose passage covered several
 *   engines is still offered, so the quote asks which one, but it does not count toward the
 *   gate's "good enough locally": the web may find a single-engine source.
 */
import { tierForClassification } from "@select-lub/core/db";
import { validateExtractedSpec, type AuthoritativeSourceRetriever, type RetrievedSource } from "../pipeline/oil-spec.js";
import type { StoredManualReading } from "../store/manual-readings.js";
import type { VehicleIdentity } from "../store/store.js";

/** What the retriever needs from the store: a narrow port, like the search-miss one. */
export type ManualReadingPort = {
  listManualReadings(identity: VehicleIdentity): Promise<StoredManualReading[]>;
};

/** Lowercase, accents off, whitespace collapsed: what the anchor patterns read. */
function folded(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ");
}

/** A normalized multigrade ("5W-40") as the text may print it: 5W-40, 5W40, 5w 40, 5 W - 40. */
function gradePattern(grade: string): RegExp | null {
  const parts = /^(\d{1,2})W-(\d{1,2})$/.exec(grade);
  return parts ? new RegExp(`(?<!\\d)${parts[1]}\\s*w\\s*-?\\s*${parts[2]}(?!\\d)`) : null;
}

/** A liters figure as the text may print it: 4, 4,0, 4.0; 4,5 or 4.5, with any trailing zeros. */
function litersPattern(liters: number): RegExp {
  const [whole, fraction = ""] = String(Number(liters.toFixed(3))).split(".");
  const number = fraction ? `${whole}[.,]${fraction}0*` : `${whole}(?:[.,]0+)?`;
  return new RegExp(`(?<![\\d.,])${number}(?![\\d])`);
}

/**
 * What a reading states that its passage does not: each grade, and the liters, missing from it.
 *
 * @returns The missing values; empty when every one is anchored.
 */
export function unanchoredValues(excerpt: string | null, grades: readonly string[], liters: number | null): string[] {
  const text = folded(excerpt ?? "");
  const missing = grades.filter((grade) => {
    const pattern = gradePattern(grade);
    return !pattern || !pattern.test(text);
  });
  if (liters !== null && !litersPattern(liters).test(text)) missing.push(`${liters} L`);
  return missing;
}

/**
 * @returns The reading as a source, or null when its class maps to no tier or a value it states
 *   is not in its passage.
 */
export function sourceOfReading(reading: StoredManualReading): RetrievedSource | null {
  const { spec } = reading;
  const authority = tierForClassification(spec.sourceClass);
  if (authority === null) return null;
  const { publisher, document, sourceClass, ...extracted } = spec;
  // The values the quote will use, as the validator keeps them: the grades, and the liters —
  // priced, or the unusable volume the attendant is told about.
  const validated = validateExtractedSpec(extracted);
  if (validated === null) return null;
  const litersUsed = validated.fillLiters ?? validated.unusableFillLiters ?? null;
  const missing = unanchoredValues(reading.excerpt, validated.viscosityGrades, litersUsed);
  if (missing.length > 0) {
    console.warn("manual-reading", JSON.stringify({ url: reading.url, page: reading.citedPage, outcome: "unanchored", missing }));
    return null;
  }
  const severalEngines = extracted.engineCoverage === "several" || extracted.engineCoverage === "mismatch";
  return {
    publisher,
    document,
    page: reading.citedPage,
    url: reading.url,
    classification: sourceClass,
    authority,
    ...(reading.excerpt ? { excerpt: reading.excerpt } : {}),
    ...(severalEngines ? { sparesWebSearch: false } : {}),
    content: { kind: "stored_spec", spec: extracted, text: reading.excerpt ?? "" },
  };
}

/**
 * The stored-manual adapter.
 *
 * @param port - Reads the verified readings for an identity.
 * @returns `found` with one source per usable reading, `none` when there is none, `unavailable`
 *   when the read fails.
 */
export function createStoredManualRetriever(port: ManualReadingPort): AuthoritativeSourceRetriever {
  return async (identity) => {
    try {
      const sources = (await port.listManualReadings(identity))
        .map(sourceOfReading)
        .filter((source): source is RetrievedSource => source !== null);
      return sources.length > 0 ? { status: "found", sources } : { status: "none" };
    } catch {
      return { status: "unavailable" };
    }
  };
}

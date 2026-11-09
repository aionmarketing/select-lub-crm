/**
 * One identity's reading of a stored manual (ingest-harvested-manuals D7).
 *
 * The spec depends on the engine, and one manual can list several, so each identity that queued
 * a manual gets its own reading of the same stored pages: locate its pages (D4, with its own
 * engine words), let the passage selector pick the passage out of those K pages, and run the
 * extractor on that passage once. What it stores is the extraction as the model gave it, cited to
 * the page it came from; validation, engine coverage, conflicts and per-grade citation run again
 * at quote time, over this and every other source, without calling a model for the manual.
 *
 * No database here: the job loads the pages, and stores what this returns.
 */
import { tierForClassification } from "@select-lub/core/db";
import { z } from "zod";
import { sourceClassificationSchema, type SourceClassification } from "../../../../shared/web/source-classification.js";
import { fillConditionSchema, fillKindSchema } from "../../contracts/http.motul-compatibility.js";
import {
  isExtractionFailed,
  validateExtractedSpec,
  type ExtractedOilSpec,
  type OilSpecExtractor,
  type RetrievedSource,
} from "../pipeline/oil-spec.js";
import type { LineSpan, PassageSelector } from "../pipeline/passage-selector.js";
import type { VehicleIdentity } from "../store/store.js";
import { citePages, locatePages, pagesForLines, type ManualPage } from "./locate-pages.js";

/** Who published a manual and what it is: the host, the document's label, its class (D6). */
export type ManualSourceMeta = { publisher: string; document: string; sourceClass: SourceClassification };

/** A stored reading's spec: the extraction, and the source it cites. */
export type StoredManualSpec = ExtractedOilSpec & ManualSourceMeta;

/** A stored spec as read back from its JSON column: anything else is not a reading to trust. */
const storedManualSpecSchema = z.object({
  viscosityGrades: z.array(z.string()),
  classification: z.string(),
  fillLiters: z.number().nullable(),
  fillKind: fillKindSchema.nullable(),
  // Absent on a reading stored before D5: the validator reads it from fillKind.
  fillCondition: fillConditionSchema.nullable().optional(),
  engineCoverage: z.enum(["one", "several", "mismatch", "unknown"]).optional(),
  enginesNamed: z.array(z.string()).optional(),
  publisher: z.string(),
  document: z.string(),
  sourceClass: sourceClassificationSchema,
});

/** @returns The stored spec, or null when the column does not hold one. */
export function parseStoredManualSpec(json: unknown): StoredManualSpec | null {
  const parsed = storedManualSpecSchema.safeParse(json);
  return parsed.success ? (parsed.data as StoredManualSpec) : null;
}

/** What reading a manual for one identity gave. `failed` is a model failure, and is retried. */
export type ReadingOutcome =
  | { status: "verified"; spec: StoredManualSpec; citedPage: string; excerpt: string }
  | { status: "stated_nothing"; why: string; citedPage: string | null; excerpt: string | null; spec: StoredManualSpec | null }
  | { status: "failed"; why: string };

/**
 * Reads the manual for one identity.
 *
 * @param input.pages - The manual's stored pages.
 * @param input.k - How many pages the selector sees.
 * @param deps.selectPassage - The passage selector; without one, the K pages are read whole.
 * @param deps.extract - The extractor.
 */
export async function readForIdentity(
  input: { url: string; pages: readonly ManualPage[]; identity: VehicleIdentity; meta: ManualSourceMeta; k: number },
  deps: { selectPassage?: PassageSelector; extract: OilSpecExtractor },
): Promise<ReadingOutcome> {
  const located = locatePages(input.pages, input.identity, input.k);
  if (located.pageNumbers.length === 0) {
    return { status: "stated_nothing", why: "no page mentions engine oil", citedPage: null, excerpt: null, spec: null };
  }
  const authority = tierForClassification(input.meta.sourceClass) ?? undefined;
  const source: RetrievedSource = {
    publisher: input.meta.publisher,
    document: input.meta.document,
    page: citePages(located.pageNumbers),
    url: input.url,
    classification: input.meta.sourceClass,
    ...(authority ? { authority } : {}),
    content: { kind: "text", text: located.text },
  };

  try {
    let passage = located.text;
    let lines: LineSpan[] | undefined;
    if (deps.selectPassage) {
      const selection = await deps.selectPassage(source, input.identity, { lineToPage: located.lineToPage });
      if (selection.status === "none") {
        return { status: "stated_nothing", why: `no passage about engine oil in ${source.page}`, citedPage: source.page, excerpt: null, spec: null };
      }
      // `unavailable` reads the K pages' narrowed text (background-oil-research D4), and cites them all.
      if (selection.status === "selected" && selection.source.content.kind === "text") {
        passage = selection.source.content.text;
        lines = selection.lines;
      }
    }
    // The pages of every span the selector chose (D22); without spans, every page sent.
    const citedPage = citePages(pagesForLines(located, lines));
    const narrowed: RetrievedSource = { ...source, page: citedPage, excerpt: passage, content: { kind: "text", text: passage } };

    const extracted = await deps.extract(narrowed, input.identity);
    if (isExtractionFailed(extracted)) return { status: "failed", why: "the extractor failed" };
    if (extracted === null) return { status: "stated_nothing", why: "the passage names no oil", citedPage, excerpt: passage, spec: null };
    const spec: StoredManualSpec = { ...extracted, ...input.meta };
    // Validated now only to label the reading; the quote validates again, as for every source.
    if (validateExtractedSpec(extracted) === null) {
      return { status: "stated_nothing", why: "no valid SAE grade in the passage", citedPage, excerpt: passage, spec };
    }
    return { status: "verified", spec, citedPage, excerpt: passage };
  } catch (err) {
    return { status: "failed", why: String(err).slice(0, 200) };
  }
}

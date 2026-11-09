/**
 * One cited source in the three shapes the quote passes it through (D11, owner 2026-09-25):
 * the pipeline's citation, the cache's `source*` fields, and what the dialog shows.
 */
import type { CitedSource, QuoteCitedSource } from "../contracts/http.js";
import type { SourceCitation } from "./pipeline/oil-spec.js";

/**
 * @param citation - A citation as the pipeline produced it.
 * @returns The same source in the cache's field names, excerpt and class included.
 */
export function citedSource(citation: SourceCitation): CitedSource {
  return {
    sourcePublisher: citation.publisher,
    sourceDocument: citation.document,
    sourcePage: citation.page,
    sourceAuthority: citation.authority ?? null,
    sourceUrl: citation.url ?? null,
    sourceClassification: citation.classification ?? null,
    sourceExcerpt: citation.excerpt ?? null,
  };
}

/**
 * @param source - A cached source.
 * @returns It as the dialog shows it: no excerpt or class, which stay in the cache.
 */
export function shownSource(source: CitedSource): QuoteCitedSource {
  return {
    sourcePublisher: source.sourcePublisher,
    sourceDocument: source.sourceDocument,
    sourcePage: source.sourcePage,
    sourceAuthority: source.sourceAuthority,
    sourceUrl: source.sourceUrl,
  };
}

/**
 * The liters' source for an `options` result.
 *
 * The store reads one whenever there are liters — an old row's is its primary source — so a
 * missing one is an inconsistent row, not a reason to break the attendant's quote
 * (orchestrator ruling, 2026-09-25). It falls back to the primary source and warns, naming
 * the cache row and never its excerpt.
 *
 * @param spec - The cache row's id and its liters' source, as the store read them.
 * @param primary - The row's primary source, as the dialog shows it.
 * @returns The liters' source, or the primary source when the row lacks one.
 */
export function litersSourceOf(
  spec: { id: string; litersSource: CitedSource | null },
  primary: QuoteCitedSource,
): QuoteCitedSource {
  if (spec.litersSource) {
    return shownSource(spec.litersSource);
  }
  console.warn(
    "oil-quote",
    JSON.stringify({ event: "liters_source_missing", compatibilityId: spec.id, fallback: "primary_source" }),
  );
  return primary;
}

/**
 * The re-resolve's second source (background-oil-research D11): the web page behind the
 * identity's current answer, read again from its stored passage — no fetch, no model call — so a
 * manual that disagrees with it meets it under the conflict rules instead of silently replacing
 * it.
 */
import type { MotulCompatibility } from "../../contracts/http.js";
import type { RetrievedSource, SourceAuthority } from "../pipeline/oil-spec.js";
import { unanchoredValues } from "../retrieval/stored-manuals.js";

/**
 * The latest cache row as a `stored_spec` source, when it came from a web page: its recorded tier,
 * its stored passage, the grades cited to that page and the liters when that page stated them,
 * with their capacity type — or the volume a change does not use that the row kept (D5).
 * Held to the stored-reading anchoring: every grade and the liters must appear in the passage.
 *
 * @param row - The identity's latest cache row, or null.
 * @returns The source, or null when there is no row, it is not from a web page, it keeps no
 *   passage, or a value it states is not in that passage.
 */
export function currentWebSource(row: MotulCompatibility | null): RetrievedSource | null {
  if (!row || !row.sourceUrl || !row.sourceClassification || !row.sourceExcerpt || row.sourceAuthority == null) return null;
  const url = row.sourceUrl;
  const grades = (row.gradeSources ?? []).filter((source) => source.sourceUrl === url).map((source) => source.grade);
  const litersHere = row.litersSource?.sourceUrl === url && row.fillLiters != null && row.fillKind != null;
  // A volume a change does not use (D5) has no liters citation; the row keeps it only when no
  // source gave a usable one, so it is the page's when the page is the row's own source and its
  // passage states it. Carried, the re-resolve can still name it (review of #189).
  const condition = row.fillCondition ?? null;
  const unusableHere =
    !litersHere && row.fillLiters == null && row.unusableFillLiters != null && (condition === "without_filter" || condition === "dry");
  const fill = litersHere
    ? {
        fillLiters: row.fillLiters,
        fillKind: row.fillKind,
        // A row before the column has none: the validator then reads the legend.
        ...(condition === "with_filter" || condition === "unlabeled" ? { fillCondition: condition } : {}),
      }
    : unusableHere
      ? { fillLiters: row.unusableFillLiters ?? null, fillKind: null, fillCondition: condition }
      : { fillLiters: null, fillKind: null };
  if (grades.length === 0) return null;
  if (unanchoredValues(row.sourceExcerpt, grades, fill.fillLiters).length > 0) return null;
  return {
    publisher: row.sourcePublisher,
    document: row.sourceDocument,
    page: row.sourcePage,
    url,
    classification: row.sourceClassification,
    authority: row.sourceAuthority as SourceAuthority,
    excerpt: row.sourceExcerpt,
    content: {
      kind: "stored_spec",
      spec: { viscosityGrades: grades, classification: row.classification, ...fill, engineCoverage: "one" },
      text: row.sourceExcerpt,
    },
  };
}

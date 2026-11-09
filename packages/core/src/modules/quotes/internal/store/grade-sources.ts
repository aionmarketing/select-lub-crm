/**
 * The `motul_compatibility.grade_sources` column: which source each SAE grade, and the
 * liters, is cited to (D11, owner 2026-09-25).
 *
 * On disk the grade entries are grouped by source, so two grades read from one page do not
 * duplicate its excerpt, and the liters are a sibling key rather than a fake grade. The
 * contract flattens that to one entry per grade. A row written before the column (NULL, or
 * a value that no longer parses) reads as one provenance — the row's `source_*` columns —
 * for every grade and the liters, so nothing downstream branches on a row's age.
 */
import { z } from "zod";
import type { CitedSource, GradeSource } from "../../contracts/http.js";
import { sourceClassificationSchema } from "../../../../shared/web/source-classification.js";

const storedSourceSchema = z.object({
  publisher: z.string(),
  document: z.string(),
  page: z.string(),
  authority: z.number().int().min(1).max(5).nullable(),
  url: z.string().nullable(),
  classification: sourceClassificationSchema.nullable(),
  excerpt: z.string().nullable(),
});

const storedGradeSourcesSchema = z.object({
  grades: z.array(storedSourceSchema.extend({ grades: z.array(z.string()).min(1) })),
  liters: storedSourceSchema.nullable(),
});

type StoredSource = z.infer<typeof storedSourceSchema>;

/** The provenance the contract reads back for one cache row. */
export type RowProvenance = { gradeSources: GradeSource[]; litersSource: CitedSource | null };

function toStored(source: CitedSource): StoredSource {
  return {
    publisher: source.sourcePublisher,
    document: source.sourceDocument,
    page: source.sourcePage,
    authority: source.sourceAuthority,
    url: source.sourceUrl,
    classification: source.sourceClassification ?? null,
    excerpt: source.sourceExcerpt ?? null,
  };
}

function fromStored(source: StoredSource): CitedSource {
  return {
    sourcePublisher: source.publisher,
    sourceDocument: source.document,
    sourcePage: source.page,
    sourceAuthority: source.authority,
    sourceUrl: source.url,
    sourceClassification: source.classification,
    sourceExcerpt: source.excerpt,
  };
}

/**
 * @param gradeSources - One entry per grade, as the pipeline cited them; absent when the
 * caller recorded none.
 * @param litersSource - The source that stated the liters, or null.
 * @returns The column value, or `null` when there is no per-grade provenance to record (the
 * row then reads as one provenance, its primary source).
 */
export function writeGradeSources(
  gradeSources: GradeSource[] | undefined,
  litersSource: CitedSource | null | undefined,
): z.infer<typeof storedGradeSourcesSchema> | null {
  if (!gradeSources || gradeSources.length === 0) {
    return null;
  }
  const groups = new Map<string, StoredSource & { grades: string[] }>();
  for (const { grade, ...source } of gradeSources) {
    const stored = toStored(source);
    const key = JSON.stringify(stored);
    const group = groups.get(key);
    if (group) {
      group.grades.push(grade);
    } else {
      groups.set(key, { ...stored, grades: [grade] });
    }
  }
  return { grades: [...groups.values()], liters: litersSource ? toStored(litersSource) : null };
}

/**
 * Reads a row's per-grade provenance.
 *
 * A NULL column is a row from before it existed, and reads as one provenance without comment.
 * A NON-NULL value that does not parse, or that does not mention one of the row's grades, is
 * a damaged row: it still reads (a quote must not fail over it), with the primary source for
 * what it cannot place — which may cite a grade to a source that does not list it — so it
 * warns, naming the row and never an excerpt (orchestrator review of #175, 2026-09-25).
 *
 * @param rowId - The cache row, named in the warning.
 * @param stored - The `grade_sources` column.
 * @param grades - The row's grades, whose order the result follows.
 * @param hasLiters - Whether the row has verified liters; `litersSource` is null otherwise.
 * @param primary - The row's `source_*` columns.
 * @returns One source per grade, and the liters' source.
 */
export function readGradeSources(
  rowId: string,
  stored: unknown,
  grades: string[],
  hasLiters: boolean,
  primary: CitedSource,
): RowProvenance {
  const parsed = storedGradeSourcesSchema.safeParse(stored);
  const groups = parsed.success ? parsed.data.grades : [];
  const unplaced: string[] = [];
  const gradeSources = grades.map((grade) => {
    const group = groups.find((g) => g.grades.includes(grade));
    if (!group) {
      unplaced.push(grade);
    }
    return { grade, ...(group ? fromStored(group) : primary) };
  });
  if (stored != null && (!parsed.success || unplaced.length > 0)) {
    console.warn(
      "oil-quote",
      JSON.stringify({
        event: "grade_sources_unreadable",
        compatibilityId: rowId,
        reason: parsed.success ? "grades_not_listed" : "invalid_shape",
        gradesCitedToPrimary: unplaced,
      }),
    );
  }
  const liters = parsed.success && parsed.data.liters ? fromStored(parsed.data.liters) : primary;
  return { gradeSources, litersSource: hasLiters ? liters : null };
}

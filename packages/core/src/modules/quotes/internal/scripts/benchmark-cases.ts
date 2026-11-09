/**
 * The OpenAI benchmark's capture and cases (switch-oil-research-to-openai task 2.1, design.md D9).
 * The capture is the read-only query the owner runs: GLM's stored answers, the passages and the
 * run telemetry. Each case pairs a passage, a manual or an unverified identity with what GLM
 * stored for it. Pure: split out of `benchmark-plan.ts`.
 */
import { locatePages, pagesToSelector, type ManualPage } from "../manuals/locate-pages.js";
import type { VehicleIdentity } from "../store/store.js";

/** The searches the run makes at most (owner: 3–5). */
export const BENCHMARK_MAX_SEARCHES = 5;

// ---------------------------------------------------------------------------------------------
// The capture (design.md D9's query): GLM's stored answers, the passages and the run telemetry.
// ---------------------------------------------------------------------------------------------

/** One `grade_sources` group or the liters' source, as stored. */
export type CapturedSource = {
  publisher: string;
  document: string;
  page: string;
  authority: number | null;
  url: string | null;
  classification: string | null;
  excerpt: string | null;
  grades?: string[];
};

/** One `motul_compatibility` row. */
export type CapturedCacheRow = {
  id: string;
  make: string;
  year: number;
  model: string;
  version: string;
  viscosities: string[] | null;
  viscosity: string;
  classification: string;
  fill_liters: number | string | null;
  fill_kind: string | null;
  fill_condition: string | null;
  source_publisher: string | null;
  source_document: string | null;
  source_page: string | null;
  source_authority: number | null;
  source_url: string | null;
  source_classification: string | null;
  source_excerpt: string | null;
  grade_sources: { grades?: CapturedSource[]; liters?: CapturedSource | null } | null;
};

/** One `oil_manual_reading`; its document's pages are in the capture's `manual_documents`. */
export type CapturedReading = {
  id: string;
  url: string;
  make: string;
  year: number;
  model: string;
  version: string;
  status: string;
  spec: Record<string, unknown> | null;
  cited_page: string | null;
  excerpt: string | null;
  read_by: string | null;
  document_id: string | null;
};

/** One document's pages, in page order. */
export type CapturedPage = { page: number; text: string };

/** One `oil_research_run` row's telemetry. */
export type CapturedRun = {
  id: string;
  identity_key: string;
  path: string;
  outcome: string | null;
  started_at: string;
  finished_at: string | null;
  cost_usd: number | string;
  tokens: unknown;
  efforts: unknown;
};

/** One `oil_research` identity. */
export type CapturedIdentity = { identity_key: string; make: string; year: number; model: string; version: string; state: string; outcome: string | null };

/** The capture file. */
export type BenchmarkCapture = {
  captured_at: string;
  cache_rows: CapturedCacheRow[];
  manual_readings: CapturedReading[];
  /** Each document's pages once, by `document_id`, however many readings share it. */
  manual_documents: Record<string, CapturedPage[]>;
  runs: CapturedRun[];
  identities: CapturedIdentity[];
};

/** Reads a capture, failing loudly on a file that is not one. */
export function parseCapture(raw: string): BenchmarkCapture {
  const parsed = JSON.parse(raw.trim()) as Partial<BenchmarkCapture>;
  for (const key of ["cache_rows", "manual_readings", "runs", "identities"] as const) {
    if (!Array.isArray(parsed[key])) throw new Error(`capture: "${key}" is missing or not a list`);
  }
  const documents = parsed.manual_documents;
  if (documents == null || typeof documents !== "object" || Array.isArray(documents)) {
    throw new Error('capture: "manual_documents" is missing or not an object');
  }
  return parsed as BenchmarkCapture;
}

// ---------------------------------------------------------------------------------------------
// The cases.
// ---------------------------------------------------------------------------------------------

/** A stored passage, re-read with gpt-6.1-sol and compared with what GLM stored from it. */
export type PassageCase = {
  group: "a";
  id: string;
  identity: VehicleIdentity;
  source: CapturedSource;
  /** GLM's answer from this passage: the grades cited to it, and the liters when it stated them. */
  expected: { grades: string[]; liters: number | null; fillCondition: string | null };
};

/** A stored manual reading, re-read from its stored pages. */
export type ReadingCase = {
  group: "b";
  id: string;
  identity: VehicleIdentity;
  url: string;
  pages: ManualPage[];
  meta: { publisher: string; document: string; sourceClass: string };
  expected: { status: string; grades: string[]; liters: number | null; fillCondition: string | null };
  /** Characters the located pages send to the selector (D9's estimate). */
  locatedChars: number;
};

/** An identity with no verified row, searched on OpenAI. */
export type SearchCase = { group: "c"; id: string; identity: VehicleIdentity; storedOutcome: string | null };

/** Every case. */
export type BenchmarkCase = PassageCase | ReadingCase | SearchCase;

const numberOrNull = (value: unknown): number | null => {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(n) ? n : null;
};

const identityOf = (row: { make: string; year: number; model: string; version: string }): VehicleIdentity => ({
  make: row.make,
  year: Number(row.year),
  model: row.model,
  version: row.version,
});

/** Group (a): one case per distinct stored excerpt of each cache row. */
export function passageCases(rows: readonly CapturedCacheRow[]): PassageCase[] {
  const cases: PassageCase[] = [];
  for (const row of rows) {
    const liters = numberOrNull(row.fill_liters);
    const seen = new Set<string>();
    const add = (source: CapturedSource, grades: string[], withLiters: boolean) => {
      const excerpt = source.excerpt?.trim();
      if (!excerpt || seen.has(excerpt)) return;
      seen.add(excerpt);
      cases.push({
        group: "a",
        id: `${row.id}#${cases.length}`,
        identity: identityOf(row),
        source,
        expected: { grades, liters: withLiters ? liters : null, fillCondition: withLiters ? row.fill_condition : null },
      });
    };
    const groups = row.grade_sources?.grades ?? [];
    const litersSource = row.grade_sources?.liters ?? null;
    for (const group of groups) {
      add(group, group.grades ?? [], litersSource?.excerpt != null && litersSource.excerpt === group.excerpt);
    }
    if (litersSource) add(litersSource, [], true);
    if (row.source_excerpt) {
      add(
        {
          publisher: row.source_publisher ?? "",
          document: row.source_document ?? "",
          page: row.source_page ?? "",
          authority: row.source_authority,
          url: row.source_url,
          classification: row.source_classification,
          excerpt: row.source_excerpt,
        },
        row.viscosities ?? [row.viscosity],
        groups.length === 0,
      );
    }
  }
  return cases;
}

/** Group (b): one case per stored reading whose document has pages in `documents`. */
export function readingCases(readings: readonly CapturedReading[], documents: Readonly<Record<string, readonly CapturedPage[]>>): ReadingCase[] {
  const pagesOf = (reading: CapturedReading) => (reading.document_id ? (documents[reading.document_id] ?? []) : []);
  return readings
    .filter((reading) => pagesOf(reading).length > 0)
    .map((reading) => {
      const identity = identityOf(reading);
      const pages = pagesOf(reading).map((page) => ({ pageNumber: page.page, text: page.text }));
      const spec = reading.spec ?? {};
      return {
        group: "b" as const,
        id: reading.id,
        identity,
        url: reading.url,
        pages,
        meta: {
          publisher: typeof spec.publisher === "string" ? spec.publisher : new URL(reading.url).hostname,
          document: typeof spec.document === "string" ? spec.document : reading.url,
          sourceClass: typeof spec.sourceClass === "string" ? spec.sourceClass : "manufacturer_manual",
        },
        expected: {
          status: reading.status,
          grades: Array.isArray(spec.viscosityGrades) ? (spec.viscosityGrades as string[]) : [],
          liters: numberOrNull(spec.fillLiters),
          fillCondition: typeof spec.fillCondition === "string" ? spec.fillCondition : null,
        },
        locatedChars: locatePages(pages, identity, pagesToSelector()).text.length,
      };
    });
}

/**
 * Parses one `--search-identity "<make>|<year>|<model>|<version>"` value: four non-empty parts, the
 * year a 4-digit integer. Throws a message naming the value otherwise.
 */
export function parseSearchIdentity(text: string): VehicleIdentity {
  const parts = text.split("|").map((part) => part.trim());
  if (parts.length !== 4 || parts.some((part) => part === "")) {
    throw new Error(`--search-identity "${text}": expected "<make>|<year>|<model>|<version>" with four non-empty parts`);
  }
  const [make, year, model, version] = parts as [string, string, string, string];
  if (!/^\d{4}$/.test(year)) throw new Error(`--search-identity "${text}": the year must be a 4-digit integer`);
  return { make, year: Number(year), model, version };
}

/** An identity's comparison key: case- and space-insensitive over its four parts. */
const identityKey = (identity: VehicleIdentity): string =>
  [identity.make, identity.year, identity.model, identity.version].map((part) => String(part).trim().toLowerCase()).join("|");

/**
 * Group (c): the identities with no verified answer, oldest first, plus the owner's extra
 * `--search-identity` cars. Without extras the captured list is cut at `max`. With extras nothing is
 * dropped silently: more than `max` searches in total, or an extra that repeats another, throws.
 */
export function searchCases(identities: readonly CapturedIdentity[], extras: readonly VehicleIdentity[] = [], max = BENCHMARK_MAX_SEARCHES): SearchCase[] {
  const captured: SearchCase[] = identities
    .filter((row) => row.state !== "verified" && row.state !== "abandoned")
    .map((row) => ({ group: "c" as const, id: row.identity_key, identity: identityOf(row), storedOutcome: row.outcome ?? row.state }));
  if (extras.length === 0) return captured.slice(0, max);
  const added: SearchCase[] = extras.map((identity) => ({
    group: "c" as const,
    id: `extra|${identity.year}|${identity.make}|${identity.model}|${identity.version}`,
    identity,
    storedOutcome: null,
  }));
  if (captured.length + added.length > max) {
    throw new Error(`--search-identity: ${captured.length} captured unverified car(s) + ${added.length} extra(s) = ${captured.length + added.length} searches, at most ${max} allowed`);
  }
  const seen = new Set<string>();
  for (const entry of [...captured, ...added]) {
    const key = identityKey(entry.identity);
    if (seen.has(key)) throw new Error(`--search-identity: ${entry.identity.make} ${entry.identity.year} ${entry.identity.model} ${entry.identity.version} is already in the search group`);
    seen.add(key);
  }
  return [...captured, ...added];
}

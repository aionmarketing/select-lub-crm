/**
 * The hard limits on reading a manual (ingest-harvested-manuals, owner rulings Q3), read from the
 * environment at call time like the web search's budgets. Q5 measured the recorded candidates
 * (median 4.3 MB, max 14.5 MB, 0 of 28 over 40 MB); the page count and the durations could not be
 * measured by HEAD, so every document logs them (D2). The text, heap and memory caps come from
 * the reviews of #180.
 */

/** Largest document downloaded: checked against the declared size, then enforced on the stream. */
export const MANUAL_DEFAULT_MAX_BYTES = 40 * 1024 * 1024;

/** Most pages extracted. */
export const MANUAL_DEFAULT_MAX_PAGES = 600;

/** Longest a download may take, HEAD and GET together. */
export const MANUAL_DEFAULT_FETCH_TIMEOUT_MS = 60_000;

/** Longest the text extraction may take; the parser is killed at it. */
export const MANUAL_DEFAULT_PARSE_TIMEOUT_MS = 60_000;

/** Characters one page's text may hold. A dense manual page runs to a few thousand. */
export const MANUAL_DEFAULT_MAX_PAGE_CHARS = 50_000;

/** Characters a whole document's text may hold: 600 pages at over 8,000 each. */
export const MANUAL_DEFAULT_MAX_TEXT_CHARS = 5_000_000;

/**
 * The parser's JS heap, in MB. It bounds pdf.js's objects, NOT the data it decodes: decoded
 * streams are typed arrays, outside the V8 heap, so a decompression bomb is bounded by
 * {@link MANUAL_DEFAULT_PARSE_MEMORY_MB} instead, where that limit can be set.
 */
export const MANUAL_DEFAULT_PARSE_HEAP_MB = 256;

/**
 * The parser child's whole address space, in MB, typed arrays included (Linux: `ulimit -v`).
 * Node reserves about 768 MB of address space before running anything, so 1024 leaves about
 * 256 MB for the parse. Measured on the worker image: the authored 5-page manual parses under 900
 * with a 70 MB peak. The worker VM has 1 GB (the owner's ruling, 2026-09-25), so a parse at the
 * cap, about 300 MB resident, fits beside the worker itself.
 */
export const MANUAL_DEFAULT_PARSE_MEMORY_MB = 1024;

/**
 * Whether manual ingestion is on: everything but an explicit `false` is on. The kill switch for
 * both jobs, downloading (`quotes/ingest-manuals`) and reading (`quotes/read-manuals`).
 */
export function manualIngestionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MANUAL_INGESTION_ENABLED !== "false";
}

/** The limits one read runs under. */
export type ManualLimits = {
  maxBytes: number;
  maxPages: number;
  fetchTimeoutMs: number;
  parseTimeoutMs: number;
  maxPageChars: number;
  maxTextChars: number;
  parseHeapMb: number;
  parseMemoryMb: number;
};

function envInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isInteger(raw) && raw > 0 ? raw : fallback;
}

/** @returns The limits from `MANUAL_*`, each falling back to its default when unset or invalid. */
export function manualLimits(): ManualLimits {
  return {
    maxBytes: envInt("MANUAL_MAX_BYTES", MANUAL_DEFAULT_MAX_BYTES),
    maxPages: envInt("MANUAL_MAX_PAGES", MANUAL_DEFAULT_MAX_PAGES),
    fetchTimeoutMs: envInt("MANUAL_FETCH_TIMEOUT_MS", MANUAL_DEFAULT_FETCH_TIMEOUT_MS),
    parseTimeoutMs: envInt("MANUAL_PARSE_TIMEOUT_MS", MANUAL_DEFAULT_PARSE_TIMEOUT_MS),
    maxPageChars: envInt("MANUAL_MAX_PAGE_CHARS", MANUAL_DEFAULT_MAX_PAGE_CHARS),
    maxTextChars: envInt("MANUAL_MAX_TEXT_CHARS", MANUAL_DEFAULT_MAX_TEXT_CHARS),
    parseHeapMb: envInt("MANUAL_PARSE_HEAP_MB", MANUAL_DEFAULT_PARSE_HEAP_MB),
    parseMemoryMb: envInt("MANUAL_PARSE_MEMORY_MB", MANUAL_DEFAULT_PARSE_MEMORY_MB),
  };
}

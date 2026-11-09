/**
 * One manual, downloaded and turned into page text under the limits, with one log line
 * (ingest-harvested-manuals D2). Storage is the ingestion job's (PR 2); this returns what it
 * read, or why it could not, as a definite refusal or a transient failure. It never throws: a
 * throw from the extractor is a document it could not read (review of #180), and every path
 * logs its line.
 *
 * `beforeParse` runs between the download and the parse, and the parse waits for it: the job
 * commits the attempt there, so a parse that takes the whole process down still counted (second
 * review of #180). If it fails, nothing is parsed and the read is a transient failure.
 */
import { fetchManual, type ManualHttp } from "./document-fetcher.js";
import type { ManualLimits } from "./limits.js";
import type { ExtractionOutcome, ManualTextExtractor } from "./text-extractor.js";

/** What reading one manual gave. */
export type ManualReadOutcome =
  | { ok: true; sha256: string; bytes: number; pages: string[]; fetchMs: number; parseMs: number }
  | { ok: false; definite: boolean; reason: string };

/** One log line per document, so the caps Q5 could not measure are checked in production. */
export type ManualReadLog = {
  url: string;
  outcome: "read" | "refused" | "failed";
  reason?: string;
  bytes?: number;
  pages?: number;
  fetchMs: number;
  parseMs?: number;
};

function refusalReason(extracted: Exclude<ExtractionOutcome, { ok: true }>, parseTimeoutMs: number): string {
  if ("timedOut" in extracted) return `parse timeout: over ${parseTimeoutMs} ms`;
  if ("unavailable" in extracted) return `parser unavailable: ${extracted.unavailable}`;
  const { refusal } = extracted;
  switch (refusal.kind) {
    case "too_many_pages":
      return `too_many_pages: ${refusal.pages}`;
    case "too_large":
      return `too_large: ${refusal.what}`;
    case "unreadable":
      return `unreadable: ${refusal.message}`;
    case "no_text_layer":
      return "no_text_layer";
  }
}

/**
 * @param url - The document's URL.
 * @param deps - The HTTP client, the text extractor, the limits, the log and the clock.
 */
export async function readManual(
  url: string,
  deps: {
    http: ManualHttp;
    extract: ManualTextExtractor;
    limits: ManualLimits;
    log?: (entry: ManualReadLog) => void;
    now?: () => number;
    beforeParse?: () => Promise<void>;
  },
): Promise<ManualReadOutcome> {
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? ((entry: ManualReadLog) => console.info("manual-read", JSON.stringify(entry)));

  const fetched = await fetchManual(url, deps.http, { maxBytes: deps.limits.maxBytes, timeoutMs: deps.limits.fetchTimeoutMs }, now);
  if (!fetched.ok) {
    const { failure } = fetched;
    const reason = [failure.kind, failure.status, failure.detail].filter((part) => part != null).join(": ");
    log({ url, outcome: failure.definite ? "refused" : "failed", reason, fetchMs: fetched.fetchMs });
    return { ok: false, definite: failure.definite, reason };
  }

  // Read what the log needs before the bytes are handed to the extractor, which may take them.
  const { sha256, fetchMs } = fetched;
  const bytes = fetched.bytes.byteLength;
  if (deps.beforeParse) {
    try {
      await deps.beforeParse();
    } catch (err) {
      const reason = `the parse attempt was not recorded: ${String(err).slice(0, 200)}`;
      log({ url, outcome: "failed", reason, bytes, fetchMs });
      return { ok: false, definite: false, reason };
    }
  }
  const parseStarted = now();
  let extracted: ExtractionOutcome;
  try {
    extracted = await deps.extract(fetched.bytes, {
      maxPages: deps.limits.maxPages,
      timeoutMs: deps.limits.parseTimeoutMs,
      maxPageChars: deps.limits.maxPageChars,
      maxTextChars: deps.limits.maxTextChars,
      maxHeapMb: deps.limits.parseHeapMb,
      maxMemoryMb: deps.limits.parseMemoryMb,
    });
  } catch (err) {
    extracted = { ok: false, refusal: { kind: "unreadable", message: String(err).slice(0, 200) } };
  }
  const parseMs = now() - parseStarted;
  const base = { url, bytes, fetchMs, parseMs };
  if (!extracted.ok) {
    // A parse that ran out of time, or a parser that did not start, may do better next time; a
    // refusal would say the same again.
    const definite = !("timedOut" in extracted) && !("unavailable" in extracted);
    const reason = refusalReason(extracted, deps.limits.parseTimeoutMs);
    log({ ...base, outcome: definite ? "refused" : "failed", reason });
    return { ok: false, definite, reason };
  }
  log({ ...base, outcome: "read", pages: extracted.pages.length });
  return { ok: true, sha256, bytes, pages: extracted.pages, fetchMs, parseMs };
}

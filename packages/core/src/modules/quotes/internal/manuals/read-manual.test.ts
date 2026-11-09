/**
 * Test design (testing-strategy) — reading one manual, and its log line
 *
 * SUT: readManual over a fake HTTP client and the real unpdf extractor, on the authored PDFs.
 *
 * Oracle: ingest-harvested-manuals D2 — a document read gives its pages, checksum and
 *   durations; a definite refusal and a transient failure are told apart (a parse timeout is
 *   transient); and every document logs its size, page count and fetch and parse durations,
 *   because Q5 could not measure the page cap or the timeouts. Review of #180: readManual never
 *   throws — a throw from the extractor is an unreadable document, refused and logged — and a
 *   document over a text cap is refused as too large. Second review: `beforeParse` (where the
 *   job commits the attempt) runs before the parse, and when it fails nothing is parsed; a parser
 *   that could not start is transient.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { GuardedResponse } from "../net/guarded-http.js";
import type { ManualHttp } from "./document-fetcher.js";
import { readManual, type ManualReadLog } from "./read-manual.js";
import { createUnpdfTextExtractor, type ManualTextExtractor } from "./text-extractor.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const MANUAL = new Uint8Array(readFileSync(join(FIXTURES, "manual-5-pages.pdf")));
const URL_PDF = "https://www.vw.com.br/manuals/gol-2021.pdf";
const limits = {
  maxBytes: 1_000_000,
  maxPages: 600,
  fetchTimeoutMs: 5_000,
  parseTimeoutMs: 30_000,
  maxPageChars: 50_000,
  maxTextChars: 5_000_000,
  parseHeapMb: 256,
  parseMemoryMb: 1024,
};

function serving(source: Uint8Array, status = 200): ManualHttp {
  return vi.fn(async (url: string, init: { method: "GET" | "HEAD" }): Promise<GuardedResponse> => {
    const robots = url.endsWith("/robots.txt");
    const headers: Record<string, string> = { "content-type": "application/pdf", "content-length": String(source.byteLength) };
    // A fresh copy per response: the extractor takes the bytes it is handed.
    const body = robots || init.method === "HEAD" || status >= 300 ? new Uint8Array() : source.slice();
    return {
      status: robots ? 404 : status,
      url,
      headers: { get: (name: string) => (robots ? null : (headers[name] ?? null)) },
      body,
      truncated: false,
      text: async () => "",
    };
  }) as unknown as ManualHttp;
}

/** A clock that moves 10 ms on every read, so every duration is known and non-zero. */
function steppingClock() {
  let t = 0;
  return () => (t += 10);
}

describe("readManual", () => {
  it("reads the pages and logs the size, page count and both durations", async () => {
    const entries: ManualReadLog[] = [];

    const outcome = await readManual(URL_PDF, {
      http: serving(MANUAL),
      extract: createUnpdfTextExtractor(),
      limits,
      log: (entry) => entries.push(entry),
      now: steppingClock(),
    });

    if (!outcome.ok) throw new Error(JSON.stringify(outcome));
    expect(outcome.pages).toHaveLength(5);
    expect(outcome.bytes).toBe(MANUAL.byteLength);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ url: URL_PDF, outcome: "read", bytes: MANUAL.byteLength, pages: 5 });
    expect(entries[0]!.fetchMs).toBeGreaterThan(0);
    expect(entries[0]!.parseMs).toBeGreaterThan(0);
  });

  it("reports a 404 as a definite refusal, logged", async () => {
    const entries: ManualReadLog[] = [];

    const outcome = await readManual(URL_PDF, { http: serving(MANUAL, 404), extract: createUnpdfTextExtractor(), limits, log: (e) => entries.push(e) });

    expect(outcome).toEqual({ ok: false, definite: true, reason: "status: 404" });
    expect(entries[0]).toMatchObject({ outcome: "refused", reason: "status: 404" });
  });

  it("reports a parse timeout as transient, so the document is tried again", async () => {
    const hangs: ManualTextExtractor = async () => ({ ok: false, timedOut: true });

    const outcome = await readManual(URL_PDF, { http: serving(MANUAL), extract: hangs, limits, log: () => {} });

    expect(outcome).toMatchObject({ ok: false, definite: false });
  });

  it("refuses, and logs, a document whose extraction throws, rather than throwing", async () => {
    const entries: ManualReadLog[] = [];
    const throws: ManualTextExtractor = async () => {
      throw new RangeError("Invalid array length");
    };

    const outcome = await readManual(URL_PDF, { http: serving(MANUAL), extract: throws, limits, log: (e) => entries.push(e) });

    expect(outcome).toEqual({ ok: false, definite: true, reason: "unreadable: RangeError: Invalid array length" });
    expect(entries).toEqual([expect.objectContaining({ outcome: "refused", reason: "unreadable: RangeError: Invalid array length" })]);
  });

  it("refuses a document over a text cap as too large, definitely", async () => {
    const outcome = await readManual(URL_PDF, {
      http: serving(MANUAL),
      extract: createUnpdfTextExtractor(),
      limits: { ...limits, maxPageChars: 60 },
      log: () => {},
    });

    expect(outcome).toEqual({ ok: false, definite: true, reason: "too_large: page_text" });
  });

  it("runs beforeParse after the download and before the parse", async () => {
    const order: string[] = [];
    const extract: ManualTextExtractor = async () => {
      order.push("parse");
      return { ok: true, pages: ["x"] };
    };

    await readManual(URL_PDF, {
      http: serving(MANUAL),
      extract,
      limits,
      log: () => {},
      beforeParse: async () => {
        order.push("beforeParse");
      },
    });

    expect(order).toEqual(["beforeParse", "parse"]);
  });

  it("parses nothing when beforeParse fails, and reports it as transient, logged", async () => {
    const entries: ManualReadLog[] = [];
    const extract = vi.fn<ManualTextExtractor>(async () => ({ ok: true, pages: ["x"] }));

    const outcome = await readManual(URL_PDF, {
      http: serving(MANUAL),
      extract,
      limits,
      log: (e) => entries.push(e),
      beforeParse: async () => {
        throw new Error("database unreachable");
      },
    });

    expect(extract).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ ok: false, definite: false, reason: expect.stringContaining("database unreachable") });
    expect(entries).toEqual([expect.objectContaining({ outcome: "failed" })]);
  });

  it("reports a parser that could not start as transient", async () => {
    const unavailable: ManualTextExtractor = async () => ({ ok: false, unavailable: "the parser's memory limit could not be set" });

    expect(await readManual(URL_PDF, { http: serving(MANUAL), extract: unavailable, limits, log: () => {} })).toEqual({
      ok: false,
      definite: false,
      reason: "parser unavailable: the parser's memory limit could not be set",
    });
  });

  it("reports a document with no text layer as a definite refusal", async () => {
    const outcome = await readManual(URL_PDF, {
      http: serving(new Uint8Array(readFileSync(join(FIXTURES, "no-text-layer.pdf")))),
      extract: createUnpdfTextExtractor(),
      limits,
      log: () => {},
    });

    expect(outcome).toEqual({ ok: false, definite: true, reason: "no_text_layer" });
  });
});

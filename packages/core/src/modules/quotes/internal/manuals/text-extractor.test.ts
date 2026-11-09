/**
 * Test design (testing-strategy) — the unpdf text extractor, in its worker thread
 *
 * SUT: createUnpdfTextExtractor, for real, over `fixtures/manual-5-pages.pdf` and
 *   `fixtures/no-text-layer.pdf` (authored by `fixtures/make-fixtures.ts`, never a real manual);
 *   and with its worker source or its library swapped, to reach the failures a real PDF cannot
 *   be made to cause on demand.
 *
 * Oracle: ingest-harvested-manuals D2 and oil-manual-ingestion "A download and a parse stay
 *   within hard limits" — text per page with page numbers kept; a document over the page cap is
 *   refused; a document whose pages carry no text is refused as having no text layer; bytes
 *   that are not a PDF are refused. Review of #180 (2026-09-25): the parse runs in a worker
 *   that is TERMINATED at the timeout — the work stops, not only the wait; running out of heap
 *   costs the thread, not the process, and is refused as too large; a page or a document over
 *   the character caps is refused as too large; a throw from the library is unreadable. Second
 *   review: one parse at a time, process-wide; the parser gets an empty environment. The
 *   default isolation is the child process on Linux, so the first block runs the real parse
 *   through whichever this machine uses; the child's OS memory limit is in
 *   text-extractor.process.test.ts, Linux only.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Worker } from "node:worker_threads";
import { afterAll, describe, expect, it } from "vitest";
import { createUnpdfTextExtractor, defaultIsolation, type ExtractionLimits } from "./text-extractor.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const pdf = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));
const limits: ExtractionLimits = {
  maxPages: 600,
  timeoutMs: 30_000,
  maxPageChars: 50_000,
  maxTextChars: 5_000_000,
  maxHeapMb: 256,
  maxMemoryMb: 1024,
};
const extract = createUnpdfTextExtractor();

describe("createUnpdfTextExtractor", () => {
  it("returns each page's text in page order, the capacities table on page 3", async () => {
    const outcome = await extract(pdf("manual-5-pages.pdf"), limits);

    if (!outcome.ok) throw new Error(`expected pages, got ${JSON.stringify(outcome)}`);
    expect(outcome.pages).toHaveLength(5);
    expect(outcome.pages[2]).toContain("Capacidade com filtro: 4,0 litros");
    expect(outcome.pages[2]).toContain("Viscosidade SAE 5W-40");
    expect(outcome.pages[0]).toContain("Manual do Proprietário");
    expect(outcome.pages[0]).not.toContain("Capacidade");
  });

  it("refuses a document over the page cap, naming its page count", async () => {
    expect(await extract(pdf("manual-5-pages.pdf"), { ...limits, maxPages: 4 })).toEqual({
      ok: false,
      refusal: { kind: "too_many_pages", pages: 5 },
    });
  });

  it("refuses a document whose pages carry no text", async () => {
    expect(await extract(pdf("no-text-layer.pdf"), limits)).toEqual({ ok: false, refusal: { kind: "no_text_layer" } });
  });

  it("refuses bytes that are not a PDF", async () => {
    const outcome = await extract(new TextEncoder().encode("<html>not a pdf</html>"), limits);

    expect(outcome).toMatchObject({ ok: false, refusal: { kind: "unreadable" } });
  });

  it("refuses a page whose text is over the page cap", async () => {
    // Page 3, the capacities table, is the longest page of the fixture; 60 characters is less.
    expect(await extract(pdf("manual-5-pages.pdf"), { ...limits, maxPageChars: 60 })).toEqual({
      ok: false,
      refusal: { kind: "too_large", what: "page_text" },
    });
  });

  it("refuses a document whose text is over the document cap, though every page fits", async () => {
    const pages = await extract(pdf("manual-5-pages.pdf"), limits);
    if (!pages.ok) throw new Error("expected pages");
    const longest = Math.max(...pages.pages.map((page) => page.length));
    const total = pages.pages.reduce((sum, page) => sum + page.length, 0);

    expect(await extract(pdf("manual-5-pages.pdf"), { ...limits, maxPageChars: longest, maxTextChars: total - 1 })).toEqual({
      ok: false,
      refusal: { kind: "too_large", what: "document_text" },
    });
  });
});

describe("createUnpdfTextExtractor's worker", () => {
  const scratch = mkdtempSync(join(tmpdir(), "manual-extractor-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  it("terminates a worker that never yields at the timeout, and the promise settles", async () => {
    let exited: Promise<number> | undefined;
    const spinning = createUnpdfTextExtractor({
      isolation: "thread",
      workerSource: "for (;;) {}",
      onWorker: (w: Worker) => (exited = new Promise((resolve) => w.once("exit", resolve))),
    });
    const started = Date.now();

    const outcome = await spinning(pdf("manual-5-pages.pdf"), { ...limits, timeoutMs: 200 });

    expect(outcome).toEqual({ ok: false, timedOut: true });
    expect(Date.now() - started).toBeLessThan(5_000);
    // The thread itself stopped: a busy loop never exits on its own, so an exit is the terminate.
    expect(await exited).toBe(1);
  });

  // About 80 MB kept alive, then an answer: over a 16 MB heap, under a 256 MB one. Bounded, so
  // it is the heap limit that refuses it, not an allocation no limit could hold.
  const HOG =
    "const kept = []; for (let i = 0; i < 100; i += 1) kept.push(new Array(1e5).fill(Math.random()));" +
    "require('node:worker_threads').parentPort.postMessage({ kind: 'pages', pages: ['kept ' + kept.length] });";

  it("refuses as too large a parse that exhausts the worker's heap, and the process lives on", async () => {
    expect(await createUnpdfTextExtractor({ isolation: "thread", workerSource: HOG })(pdf("manual-5-pages.pdf"), { ...limits, maxHeapMb: 16 })).toEqual({
      ok: false,
      refusal: { kind: "too_large", what: "memory" },
    });
  });

  it("lets the same allocation finish under a heap it fits in", async () => {
    expect(await createUnpdfTextExtractor({ isolation: "thread", workerSource: HOG })(pdf("manual-5-pages.pdf"), { ...limits, maxHeapMb: 256 })).toEqual({
      ok: true,
      pages: ["kept 100"],
    });
  });

  it("refuses as unreadable when the library's extractText throws", async () => {
    const library = join(scratch, "throwing-unpdf.cjs");
    writeFileSync(
      library,
      "exports.getDocumentProxy = async () => ({ numPages: 1 });\n" +
        "exports.extractText = async () => { throw new Error('bad xref table'); };\n",
    );

    expect(await createUnpdfTextExtractor({ unpdfPath: library })(pdf("manual-5-pages.pdf"), limits)).toEqual({
      ok: false,
      refusal: { kind: "unreadable", message: "Error: bad xref table" },
    });
  });

  it("refuses as unreadable a worker that dies without answering", async () => {
    const dies = createUnpdfTextExtractor({ isolation: "thread", workerSource: "process.exit(3)" });

    expect(await dies(pdf("manual-5-pages.pdf"), limits)).toEqual({
      ok: false,
      refusal: { kind: "unreadable", message: "worker exited with code 3" },
    });
  });
});

describe("createUnpdfTextExtractor, whatever the isolation", () => {
  it("runs one parse at a time: a second waits for the first to finish before it starts", async () => {
    const events: string[] = [];
    // Answers after 150 ms, so two concurrent parses would overlap if allowed to.
    const slow = createUnpdfTextExtractor({
      isolation: "thread",
      workerSource: "setTimeout(() => require('node:worker_threads').parentPort.postMessage({ kind: 'pages', pages: ['done'] }), 150);",
      onWorker: (w: Worker) => {
        events.push("start");
        w.once("exit", () => events.push("end"));
      },
    });

    // Two different extractors share the one process-wide slot.
    const other = createUnpdfTextExtractor({ isolation: "thread", workerSource: "require('node:worker_threads').parentPort.postMessage({ kind: 'pages', pages: ['x'] });", onWorker: (w: Worker) => {
      events.push("start");
      w.once("exit", () => events.push("end"));
    } });
    await Promise.all([slow(pdf("manual-5-pages.pdf"), limits), other(pdf("manual-5-pages.pdf"), limits)]);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(events).toEqual(["start", "end", "start", "end"]);
  });

  it("gives the parser an empty environment: no DATABASE_URL, no API key", async () => {
    process.env.MANUAL_TEST_SECRET = "must-not-reach-the-parser";
    try {
      const counting = createUnpdfTextExtractor({
        isolation: "thread",
        workerSource: "require('node:worker_threads').parentPort.postMessage({ kind: 'pages', pages: [JSON.stringify(Object.keys(process.env))] });",
      });

      expect(await counting(pdf("manual-5-pages.pdf"), limits)).toEqual({ ok: true, pages: ["[]"] });
    } finally {
      delete process.env.MANUAL_TEST_SECRET;
    }
  });

  it("isolates in a child only where an OS memory limit can be set", () => {
    expect(defaultIsolation("win32")).toBe("thread");
    expect(defaultIsolation("darwin")).toBe("thread");
  });
});

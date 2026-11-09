/**
 * Test design (testing-strategy) — the parse in a child process under an OS memory limit
 *
 * SUT: createUnpdfTextExtractor with `isolation: "process"`: `/bin/sh -c 'ulimit -v …; exec
 *   node …'`. Linux only — where the limit can be set, which is where production runs; skipped
 *   elsewhere (Windows development falls back to the worker thread, text-extractor.test.ts).
 *
 * Oracle: second review of #180 (2026-09-25, MEDIUM): pdf.js decodes into typed arrays, outside
 *   the V8 heap, so only an OS limit bounds a decompression bomb. An ArrayBuffer-heavy
 *   allocation — not a JS-array hog, which the heap limit alone would catch — is stopped IN the
 *   child and refused as too large; the same allocation under a larger limit completes, so it
 *   is the limit that stops it. The child is killed at the parse timeout; it gets an empty
 *   environment; the real parse works through it.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";
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

/**
 * 768 MB of ArrayBuffers, never touched: `ulimit -v` counts address space, so this is cheap on
 * the machine but past what 1024 MB leaves once node has reserved its ~768.
 */
const ARRAY_BUFFER_HOG =
  "const kept = []; for (let i = 0; i < 12; i += 1) kept.push(new ArrayBuffer(64 * 1024 * 1024));" +
  "process.stdout.write(JSON.stringify({ kind: 'pages', pages: ['kept ' + kept.length] }), () => process.exit(0));";

describe.skipIf(defaultIsolation() !== "process")("the parse in a child under an OS memory limit (Linux)", () => {
  const scratch = mkdtempSync(join(tmpdir(), "manual-child-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  it("reads the authored manual through the child", async () => {
    const outcome = await createUnpdfTextExtractor({ isolation: "process" })(pdf("manual-5-pages.pdf"), limits);

    if (!outcome.ok) throw new Error(JSON.stringify(outcome));
    expect(outcome.pages[2]).toContain("Capacidade com filtro: 4,0 litros");
  });

  it("stops an ArrayBuffer-heavy allocation at the limit, and refuses it as too large", async () => {
    const hog = createUnpdfTextExtractor({ isolation: "process", childSource: ARRAY_BUFFER_HOG });

    expect(await hog(pdf("manual-5-pages.pdf"), limits)).toEqual({ ok: false, refusal: { kind: "too_large", what: "memory" } });
  });

  it("lets the same allocation finish under a limit it fits in", async () => {
    const hog = createUnpdfTextExtractor({ isolation: "process", childSource: ARRAY_BUFFER_HOG });

    expect(await hog(pdf("manual-5-pages.pdf"), { ...limits, maxMemoryMb: 4096 })).toEqual({ ok: true, pages: ["kept 12"] });
  });

  it("refuses as too large a library whose decoding runs out of memory inside the real parse", async () => {
    // What a decompression bomb does to pdf.js: typed arrays until an allocation fails.
    const library = join(scratch, "bomb-unpdf.cjs");
    writeFileSync(
      library,
      "exports.getDocumentProxy = async () => { const kept = []; for (;;) kept.push(new Uint8Array(64 * 1024 * 1024)); };\n" +
        "exports.extractText = async () => ({ text: [] });\n",
    );

    expect(await createUnpdfTextExtractor({ isolation: "process", unpdfPath: library })(pdf("manual-5-pages.pdf"), limits)).toEqual({
      ok: false,
      refusal: { kind: "too_large", what: "memory" },
    });
  });

  it("kills a child that never answers at the timeout", async () => {
    let child: ChildProcess | undefined;
    const spinning = createUnpdfTextExtractor({ isolation: "process", childSource: "for (;;) {}", onChild: (c) => (child = c) });
    const exited = () => new Promise<string | null>((resolve) => child!.once("exit", (_code, signal) => resolve(signal)));

    const outcome = await spinning(pdf("manual-5-pages.pdf"), { ...limits, timeoutMs: 300 });

    expect(outcome).toEqual({ ok: false, timedOut: true });
    expect(child!.exitCode !== null || child!.signalCode !== null ? child!.signalCode : await exited()).toBe("SIGKILL");
  });

  it("gives the child an empty environment", async () => {
    process.env.MANUAL_TEST_SECRET = "must-not-reach-the-parser";
    try {
      const counting = createUnpdfTextExtractor({
        isolation: "process",
        childSource: "process.stdout.write(JSON.stringify({ kind: 'pages', pages: [JSON.stringify(Object.keys(process.env))] }), () => process.exit(0));",
      });

      expect(await counting(pdf("manual-5-pages.pdf"), limits)).toEqual({ ok: true, pages: ["[]"] });
    } finally {
      delete process.env.MANUAL_TEST_SECRET;
    }
  });
});

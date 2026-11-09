/**
 * Text out of a manual's PDF, page by page (ingest-harvested-manuals, owner ruling Q4).
 *
 * A port, so tests inject a fake and the library can be swapped: the production adapter is
 * `unpdf` (a serverless build of pdf.js 6.1). The PDF is untrusted input, so the parse is
 * isolated, and killed at the parse timeout (reviews of #180):
 *
 * - **On Linux, a child process under an OS memory limit** (`ulimit -v`). pdf.js decodes into
 *   typed arrays, which live OUTSIDE the V8 heap, so a heap limit alone does not bound a
 *   decompression bomb; an address-space limit does — an allocation past it fails in the child,
 *   and the machine is untouched.
 * - **Elsewhere (Windows development), a `worker_threads` Worker** with a heap limit. It stops a
 *   runaway parse, but bounds only the JS heap: this is the fallback, not the protection.
 *
 * Either way: **one parse at a time, process-wide** — the next starts only once the last
 * parser has EXITED, not merely answered, since its memory is held until then; an empty environment, so the parser never
 * sees `DATABASE_URL` or an API key; text only — no rendering, no font loading, no image
 * decoding; and a page or a document whose text passes the character caps is refused before any
 * of it is handed back.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";

/** Why a document's text could not be taken. Every kind is a definite answer (D2). */
export type ExtractionRefusal =
  | { kind: "too_many_pages"; pages: number }
  | { kind: "too_large"; what: "page_text" | "document_text" | "memory" }
  | { kind: "no_text_layer" }
  | { kind: "unreadable"; message: string };

/** The outcome of extracting a document's text. `timedOut` and `unavailable` are transient. */
export type ExtractionOutcome =
  | { ok: true; pages: string[] }
  | { ok: false; refusal: ExtractionRefusal }
  | { ok: false; timedOut: true }
  | { ok: false; unavailable: string };

/** The limits one extraction runs under. */
export type ExtractionLimits = {
  maxPages: number;
  timeoutMs: number;
  /** Characters one page's text may hold. */
  maxPageChars: number;
  /** Characters the whole document's text may hold. */
  maxTextChars: number;
  /** The parser's JS heap, in MB. */
  maxHeapMb: number;
  /** The child's whole address space, in MB (Linux only). Node itself reserves about 768. */
  maxMemoryMb: number;
};

/**
 * Extracts a PDF's text, one string per page, in page order (page 1 is index 0). The bytes are
 * handed over, not copied: the caller must not use them afterwards.
 */
export type ManualTextExtractor = (bytes: Uint8Array, limits: ExtractionLimits) => Promise<ExtractionOutcome>;

/**
 * The pdf.js options that keep extraction text-only. pdf.js 6 has no `eval` path to switch off;
 * what is left is to load no fonts and to stay quiet.
 */
export const TEXT_ONLY_OPTIONS = {
  disableFontFace: true,
  useSystemFonts: false,
  isOffscreenCanvasSupported: false,
  verbosity: 0,
} as const;

/**
 * The parse itself, as plain JavaScript shared by the thread and the child: production runs
 * from TypeScript source through tsx, and neither has a TypeScript loader. It loads `unpdf` from
 * the path the parent resolved and returns one message. An allocation that fails — the child's
 * memory limit reached — is too large, not unreadable.
 */
const PARSE_SOURCE = `
async function parseManual(bytes, cfg) {
  try {
    const { getDocumentProxy, extractText } = require(cfg.unpdfPath);
    const pdf = await getDocumentProxy(bytes, cfg.options);
    if (pdf.numPages > cfg.maxPages) return { kind: "too_many_pages", pages: pdf.numPages };
    const { text } = await extractText(pdf, { mergePages: false });
    let total = 0;
    for (const page of text) {
      if (page.length > cfg.maxPageChars) return { kind: "too_large", what: "page_text" };
      total += page.length;
      if (total > cfg.maxTextChars) return { kind: "too_large", what: "document_text" };
    }
    return { kind: "pages", pages: text };
  } catch (err) {
    if (err instanceof RangeError && /allocation failed|out of memory/i.test(String(err.message))) {
      return { kind: "too_large", what: "memory" };
    }
    return { kind: "unreadable", message: String(err).slice(0, 200) };
  }
}
`;

/** The thread's entry: the bytes and the settings arrive as `workerData`. */
export const EXTRACTION_WORKER_SOURCE = `${PARSE_SOURCE}
const { parentPort, workerData } = require("node:worker_threads");
parseManual(new Uint8Array(workerData.buffer), workerData).then((message) => parentPort.postMessage(message));
`;

/** The child's entry: the settings as its one argument, the bytes on stdin, the answer on stdout. */
export const EXTRACTION_CHILD_SOURCE = `${PARSE_SOURCE}
const cfg = JSON.parse(process.argv[1]);
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  parseManual(new Uint8Array(Buffer.concat(chunks)), cfg).then((message) => {
    process.stdout.write(JSON.stringify(message), () => process.exit(0));
  });
});
`;

/** How the parse is isolated. */
export type ParseIsolation = "process" | "thread";

/** @returns "process" where an OS memory limit can be set (Linux with /bin/sh), else "thread". */
export function defaultIsolation(platform: NodeJS.Platform = process.platform): ParseIsolation {
  return platform === "linux" && existsSync("/bin/sh") ? "process" : "thread";
}

/** How a test can reach inside: the isolation, the entry source, the library, the spawned parser. */
export type ExtractorOptions = {
  isolation?: ParseIsolation;
  workerSource?: string;
  childSource?: string;
  unpdfPath?: string;
  onWorker?: (worker: Worker) => void;
  onChild?: (child: ChildProcess) => void;
};

type ParseMessage =
  | { kind: "pages"; pages: string[] }
  | { kind: "too_many_pages"; pages: number }
  | { kind: "too_large"; what: "page_text" | "document_text" | "memory" }
  | { kind: "unreadable"; message: string };

function fromMessage(message: ParseMessage): ExtractionOutcome {
  switch (message.kind) {
    case "pages":
      return message.pages.every((page) => page.trim() === "")
        ? { ok: false, refusal: { kind: "no_text_layer" } }
        : { ok: true, pages: message.pages };
    case "too_many_pages":
      return { ok: false, refusal: { kind: "too_many_pages", pages: message.pages } };
    case "too_large":
      return { ok: false, refusal: { kind: "too_large", what: message.what } };
    default:
      return { ok: false, refusal: { kind: "unreadable", message: String(message.message) } };
  }
}

/** The settings the parser reads, shared by both entries. */
function parserSettings(unpdfPath: string, limits: ExtractionLimits) {
  return {
    unpdfPath,
    options: TEXT_ONLY_OPTIONS,
    maxPages: limits.maxPages,
    maxPageChars: limits.maxPageChars,
    maxTextChars: limits.maxTextChars,
  };
}

/** Exit status of the child's shell when `ulimit -v` could not be set. */
const ULIMIT_FAILED = 97;

/** Bytes of the child's stderr kept, to recognise a memory failure; never logged. */
const STDERR_KEEP = 4096;

function inProcess(bytes: Uint8Array, limits: ExtractionLimits, unpdfPath: string, options: ExtractorOptions): Promise<ExtractionOutcome> {
  return new Promise<ExtractionOutcome>((resolve) => {
    const settings = JSON.stringify(parserSettings(unpdfPath, limits));
    // `ulimit -v` bounds the whole address space, typed arrays included; `exec` makes the
    // limited shell become node, so the pid killed at the timeout is the parser's own.
    const child = spawn(
      "/bin/sh",
      [
        "-c",
        // `unset PWD`: the shell exports its own, and the parser gets nothing from us.
        `ulimit -v "$1" || exit ${ULIMIT_FAILED}; shift; unset PWD; exec "$@"`,
        "sh",
        String(limits.maxMemoryMb * 1024),
        process.execPath,
        `--max-old-space-size=${limits.maxHeapMb}`,
        "-e",
        options.childSource ?? EXTRACTION_CHILD_SOURCE,
        settings,
      ],
      { env: {}, stdio: ["pipe", "pipe", "pipe"] },
    );
    options.onChild?.(child);
    // JSON can spend six bytes on a character; past that, the answer is over the cap anyway.
    const stdoutCap = limits.maxTextChars * 6 + 65_536;
    const out: Buffer[] = [];
    let outBytes = 0;
    let err = "";
    let settled: ExtractionOutcome | null = null;
    let closed = false;
    // The outcome is decided here; the promise resolves once the child has gone, so the next
    // parse never overlaps a dying one.
    const settle = (outcome: ExtractionOutcome) => {
      if (settled) return;
      settled = outcome;
      clearTimeout(timer);
      if (closed) resolve(outcome);
      else child.kill("SIGKILL");
    };
    const timer = setTimeout(() => settle({ ok: false, timedOut: true }), limits.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      outBytes += chunk.length;
      if (outBytes > stdoutCap) {
        settle({ ok: false, refusal: { kind: "too_large", what: "document_text" } });
        return;
      }
      out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (err.length < STDERR_KEEP) err += chunk.toString("utf8").slice(0, STDERR_KEEP - err.length);
    });
    child.on("error", (error) => {
      // It never ran, so there is nothing to wait for.
      closed = true;
      settle({ ok: false, unavailable: `parser did not start: ${String(error).slice(0, 200)}` });
    });
    // A child that dies before reading all of stdin makes the write fail; its exit says why.
    child.stdin.on("error", () => undefined);
    child.on("close", (code, signal) => {
      closed = true;
      if (settled) return resolve(settled);
      if (code === ULIMIT_FAILED) return settle({ ok: false, unavailable: "the parser's memory limit could not be set" });
      if (code === 0) {
        try {
          return settle(fromMessage(JSON.parse(Buffer.concat(out).toString("utf8")) as ParseMessage));
        } catch {
          return settle({ ok: false, refusal: { kind: "unreadable", message: "the parser's answer was not readable" } });
        }
      }
      if (/allocation failed|out of memory|heap limit|ERR_MEMORY/i.test(err)) {
        return settle({ ok: false, refusal: { kind: "too_large", what: "memory" } });
      }
      settle({ ok: false, refusal: { kind: "unreadable", message: `parser exited with code ${code}${signal ? ` (${signal})` : ""}` } });
    });
    child.stdin.end(bytes);
  });
}

function inThread(bytes: Uint8Array, limits: ExtractionLimits, unpdfPath: string, options: ExtractorOptions): Promise<ExtractionOutcome> {
  return new Promise<ExtractionOutcome>((resolve) => {
    // Hand the buffer over rather than copying it; copy only when it is a view on a larger one.
    const buffer =
      bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? (bytes.buffer as ArrayBuffer) : bytes.slice().buffer;
    let settled = false;
    let worker: Worker;
    // Resolves once the thread has exited, so the next parse never overlaps a dying one.
    const settle = (outcome: ExtractionOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().then(
        () => resolve(outcome),
        () => resolve(outcome),
      );
    };
    try {
      worker = new Worker(options.workerSource ?? EXTRACTION_WORKER_SOURCE, {
        eval: true,
        env: {},
        workerData: { buffer, ...parserSettings(unpdfPath, limits) },
        transferList: [buffer],
        resourceLimits: { maxOldGenerationSizeMb: limits.maxHeapMb, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
      });
    } catch (err) {
      resolve({ ok: false, refusal: { kind: "unreadable", message: String(err).slice(0, 200) } });
      return;
    }
    options.onWorker?.(worker);
    // Terminating is what makes the timeout real: the thread stops whatever it is doing.
    const timer = setTimeout(() => settle({ ok: false, timedOut: true }), limits.timeoutMs);
    worker.on("message", (message: ParseMessage) => settle(fromMessage(message)));
    worker.on("error", (err: Error & { code?: string }) => {
      settle(
        err.code === "ERR_WORKER_OUT_OF_MEMORY"
          ? { ok: false, refusal: { kind: "too_large", what: "memory" } }
          : { ok: false, refusal: { kind: "unreadable", message: String(err).slice(0, 200) } },
      );
    });
    worker.on("exit", (code) => {
      settle({ ok: false, refusal: { kind: "unreadable", message: `worker exited with code ${code}` } });
    });
  });
}

/** The tail of the process-wide parse queue: every parse waits for the one before it. */
let parseSlot: Promise<unknown> = Promise.resolve();

/** Runs `parse` once every parse queued before it has settled: one parse at a time, per process. */
function oneAtATime<T>(parse: () => Promise<T>): Promise<T> {
  const run = parseSlot.then(parse, parse);
  parseSlot = run.catch(() => undefined);
  return run;
}

/** @returns The production extractor: `unpdf`, isolated per {@link defaultIsolation}, one parse at a time. */
export function createUnpdfTextExtractor(options: ExtractorOptions = {}): ManualTextExtractor {
  const unpdfPath = options.unpdfPath ?? createRequire(import.meta.url).resolve("unpdf");
  const isolation = options.isolation ?? defaultIsolation();
  // The timeout starts when a parse starts, not while it waits its turn.
  return (bytes, limits) =>
    oneAtATime(() => (isolation === "process" ? inProcess : inThread)(bytes, limits, unpdfPath, options));
}

/**
 * Downloading a manual under hard limits (ingest-harvested-manuals D2), through the SSRF guard.
 *
 * Every request goes through `createGuardedHttp` (`../net/guarded-http.ts`): https only, public
 * addresses only — checked where the connection resolves them — and every redirect hop checked
 * again. Then robots.txt; then a HEAD, which ends it on a status, a content type or a declared
 * size that already rules the document out; then a GET whose body is cut at the byte cap
 * whatever the headers said, under one timeout. The bytes must start like a PDF (`%PDF-`)
 * whatever the content type or the extension claim, and an empty body is refused.
 *
 * Every outcome is either the bytes, a DEFINITE refusal (a retry would say the same: a blocked
 * URL, a 4xx other than 408/429, robots, not a PDF, empty, over the cap) or a TRANSIENT failure
 * (a 5xx, 408, 429, a timeout, a network error) — the split the completed-search miss uses.
 */
import { createHash } from "node:crypto";
import { assertAllowedUrl, BlockedUrlError, createGuardedHttp, type GuardedHttp } from "../net/guarded-http.js";
import { robotsAllows, type FetchTransport } from "../retrieval/page-fetcher.js";

/** Why a document was not downloaded. */
export type FetchFailure =
  | { definite: true; kind: "blocked" | "robots" | "not_pdf" | "empty" | "too_large" | "status"; status?: number; detail?: string }
  | { definite: false; kind: "status" | "timeout" | "network"; status?: number; detail?: string };

/** The outcome of one download. */
export type ManualFetchOutcome =
  | { ok: true; bytes: Uint8Array; sha256: string; fetchMs: number }
  | { ok: false; failure: FetchFailure; fetchMs: number };

/** The HTTP client: the guarded one, injected so tests never reach the network. */
export type ManualHttp = GuardedHttp;

/** robots.txt is read up to this many bytes. */
const ROBOTS_MAX_BYTES = 512 * 1024;

/** A PDF's header must appear within its first kilobyte. */
const PDF_MAGIC_WINDOW = 1024;

/** Whether a status is definite: a 4xx other than 408 and 429. */
function definiteStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

function statusFailure(status: number): FetchFailure {
  return definiteStatus(status) ? { definite: true, kind: "status", status } : { definite: false, kind: "status", status };
}

/**
 * A short, allow-listed token for a content type, so a foreign header never reaches a log as is.
 */
export function contentTypeToken(contentType: string | null): string {
  const type = (contentType ?? "").toLowerCase();
  if (type === "") return "none";
  if (type.includes("application/pdf")) return "pdf";
  if (type.includes("html")) return "html";
  if (type.includes("octet-stream")) return "octet-stream";
  if (type.startsWith("text/")) return "text";
  return "other";
}

/** Whether a HEAD's content type leaves room for a PDF. Some hosts say octet-stream, or nothing. */
function mayBePdf(contentType: string | null): boolean {
  const token = contentTypeToken(contentType);
  return token === "pdf" || token === "octet-stream" || token === "none";
}

/** Whether the bytes start like a PDF: `%PDF-` within the first kilobyte. */
export function hasPdfMagic(bytes: Uint8Array): boolean {
  const window = bytes.subarray(0, PDF_MAGIC_WINDOW);
  for (let i = 0; i + 4 < window.length; i += 1) {
    if (window[i] === 0x25 && window[i + 1] === 0x50 && window[i + 2] === 0x44 && window[i + 3] === 0x46 && window[i + 4] === 0x2d) return true;
  }
  return false;
}

/**
 * Downloads one manual.
 *
 * @param url - The document's URL.
 * @param http - The guarded HTTP client; defaults to a real one.
 * @param limits - The byte cap and the timeout for the whole download.
 * @param now - The clock, for the duration.
 */
export async function fetchManual(
  url: string,
  http: ManualHttp = createGuardedHttp(),
  limits: { maxBytes: number; timeoutMs: number },
  now: () => number = () => Date.now(),
): Promise<ManualFetchOutcome> {
  const started = now();
  const signal = AbortSignal.timeout(limits.timeoutMs);
  const elapsed = () => now() - started;
  const fail = (failure: FetchFailure): ManualFetchOutcome => ({ ok: false, failure, fetchMs: elapsed() });
  try {
    assertAllowedUrl(url);
    const robotsTransport = ((u: string, init: { method: "GET" | "HEAD"; signal: AbortSignal; redirect: "manual" | "follow" }) =>
      http(u, { ...init, maxBytes: ROBOTS_MAX_BYTES })) as FetchTransport;
    if (!(await robotsAllows(url, robotsTransport, signal))) {
      return fail({ definite: true, kind: "robots" });
    }

    const head = await http(url, { method: "HEAD", signal, maxBytes: 0, redirect: "follow" });
    if (head.status < 200 || head.status >= 300) return fail(statusFailure(head.status));
    if (!mayBePdf(head.headers.get("content-type"))) {
      return fail({ definite: true, kind: "not_pdf", detail: contentTypeToken(head.headers.get("content-type")) });
    }
    const declared = Number(head.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > limits.maxBytes) {
      return fail({ definite: true, kind: "too_large", detail: `declared ${declared} bytes` });
    }

    const res = await http(url, { method: "GET", signal, maxBytes: limits.maxBytes, redirect: "follow" });
    if (res.status < 200 || res.status >= 300) return fail(statusFailure(res.status));
    if (res.truncated) return fail({ definite: true, kind: "too_large", detail: `streamed past ${limits.maxBytes} bytes` });
    if (res.body.byteLength === 0) return fail({ definite: true, kind: "empty" });
    // Whatever the headers and the extension said, the bytes decide.
    if (!hasPdfMagic(res.body)) return fail({ definite: true, kind: "not_pdf", detail: "no %PDF- header" });
    return { ok: true, bytes: res.body, sha256: createHash("sha256").update(res.body).digest("hex"), fetchMs: elapsed() };
  } catch (err) {
    if (err instanceof BlockedUrlError) return fail({ definite: true, kind: "blocked", detail: err.message });
    if (signal.aborted) return fail({ definite: false, kind: "timeout", detail: `over ${limits.timeoutMs} ms` });
    return fail({ definite: false, kind: "network", detail: String(err).slice(0, 200) });
  }
}

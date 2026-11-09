/**
 * Test design (testing-strategy) — downloading a manual under hard limits, through the SSRF guard
 *
 * SUT: fetchManual with an injected guarded HTTP client (no socket). The SSRF cells run the REAL
 *   createGuardedHttp over a fake raw exchange that "dials" the way node:https does: it calls
 *   the connection's `lookup` first, so a private resolution fails exactly where it would.
 *
 * Oracle: ingest-harvested-manuals D2 and oil-manual-ingestion "A download and a parse stay
 *   within hard limits" / "A definite answer ends a candidate; a transient failure leaves it
 *   pending": robots honoured; a 4xx other than 408/429, not a PDF, empty, or over the byte cap
 *   is a DEFINITE refusal; a 5xx, 408, 429, a network error or the timeout is TRANSIENT; the
 *   byte cap is checked against the declared size and enforced on the stream whatever it says.
 *   Review of #180 (2026-09-25): only public https is fetched — `http:`, `data:`, `file:`, a
 *   redirect to 127.0.0.1 or 169.254.169.254, and a name resolving to a private address are
 *   refused, definitely, without reaching them; the bytes must start `%PDF-` whatever the
 *   content type says; an empty body is refused, not a document of 0 bytes; a foreign content
 *   type reaches the log only as an allow-listed token.
 *
 * Cells: ok (bytes + sha256) | robots | HEAD 404 / 410 / 403 / 401 definite | HEAD 503 / 500 /
 *   408 / 429 transient | not a PDF by type | not a PDF by magic | empty | declared over the cap
 *   (no GET) | streamed over the cap | timeout | network error | blocked schemes | blocked
 *   redirects | blocked resolution.
 */
import type { IncomingMessage } from "node:http";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createGuardedHttp, type GuardedResponse, type LookupFn, type RawRequest } from "../net/guarded-http.js";
import { contentTypeToken, fetchManual, hasPdfMagic, type ManualHttp } from "./document-fetcher.js";

const URL_PDF = "https://www.vw.com.br/manuals/gol-2021.pdf";
const BODY = new Uint8Array([...new TextEncoder().encode("%PDF-1.4\n"), ...Array.from({ length: 1000 }, (_, i) => i % 256)]);
const limits = { maxBytes: 10_000, timeoutMs: 5_000 };

type Reply = { status?: number; type?: string; length?: string | null; body?: Uint8Array };

function response(url: string, status: number, headers: Record<string, string>, body: Uint8Array, maxBytes: number): GuardedResponse {
  const truncated = body.byteLength > maxBytes;
  const kept = truncated ? body.subarray(0, maxBytes) : body;
  return {
    status,
    url,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    body: kept,
    truncated,
    text: async () => new TextDecoder().decode(kept),
  };
}

/** A guarded client answering robots.txt, HEAD and GET from the given replies. */
function http(opts: { robots?: string; head?: Reply; get?: Reply } = {}) {
  const calls: string[] = [];
  const client: ManualHttp = vi.fn(async (url, init) => {
    calls.push(`${init.method} ${url}`);
    if (url.endsWith("/robots.txt")) {
      return response(url, opts.robots ? 200 : 404, {}, new TextEncoder().encode(opts.robots ?? ""), init.maxBytes);
    }
    const reply = init.method === "HEAD" ? (opts.head ?? {}) : (opts.get ?? {});
    const body = reply.body ?? BODY;
    const headers: Record<string, string> = { "content-type": reply.type ?? "application/pdf" };
    const length = reply.length === undefined ? String(body.byteLength) : reply.length;
    if (length != null) headers["content-length"] = length;
    const status = reply.status ?? 200;
    return response(url, status, headers, init.method === "HEAD" || status >= 300 ? new Uint8Array() : body, init.maxBytes);
  });
  return { client, calls };
}

/**
 * The real guarded client over a raw exchange that resolves through the connection's lookup
 * before answering, as node:https does. Records every URL it was asked to dial.
 */
function guarded(byUrl: Record<string, { status: number; location?: string }>, resolve: LookupFn) {
  const dialled: string[] = [];
  const request: RawRequest = async (url, options) => {
    const lookup = options.lookup as unknown as (h: string, o: object, cb: (err: Error | null) => void) => void;
    await new Promise<void>((ok, fail) => lookup(url.hostname, {}, (err) => (err ? fail(err) : ok())));
    dialled.push(url.href);
    const a = byUrl[url.href] ?? { status: 404 };
    const headers = a.location ? { location: a.location, "content-type": "application/pdf" } : { "content-type": "application/pdf" };
    return { res: { statusCode: a.status, headers } as unknown as IncomingMessage, body: BODY, truncated: false };
  };
  return { client: createGuardedHttp({ request, lookup: resolve }), dialled };
}

const publicDns: LookupFn = (_h, _o, cb) => cb(null, [{ address: "93.184.216.34", family: 4 }]);

describe("fetchManual", () => {
  it("returns the bytes and their SHA-256", async () => {
    const outcome = await fetchManual(URL_PDF, http().client, limits);

    if (!outcome.ok) throw new Error(JSON.stringify(outcome));
    expect(outcome.bytes).toEqual(BODY);
    expect(outcome.sha256).toBe(createHash("sha256").update(BODY).digest("hex"));
  });

  it("honours a robots.txt disallow, definitely, without touching the document", async () => {
    const { client, calls } = http({ robots: "User-agent: *\nDisallow: /manuals/" });

    const outcome = await fetchManual(URL_PDF, client, limits);

    expect(outcome).toMatchObject({ ok: false, failure: { definite: true, kind: "robots" } });
    expect(calls.filter((c) => !c.endsWith("/robots.txt"))).toEqual([]);
  });

  it.each([404, 410, 403, 401])("refuses a %i definitely", async (status) => {
    expect(await fetchManual(URL_PDF, http({ head: { status } }).client, limits)).toMatchObject({
      ok: false,
      failure: { definite: true, kind: "status", status },
    });
  });

  it.each([503, 500, 408, 429])("treats a %i as transient", async (status) => {
    expect(await fetchManual(URL_PDF, http({ head: { status } }).client, limits)).toMatchObject({
      ok: false,
      failure: { definite: false, kind: "status", status },
    });
  });

  it("refuses something served as HTML, definitely, naming only a token", async () => {
    expect(await fetchManual(URL_PDF, http({ head: { type: "text/html; charset=<script>" } }).client, limits)).toEqual({
      ok: false,
      failure: { definite: true, kind: "not_pdf", detail: "html" },
      fetchMs: expect.any(Number),
    });
  });

  it("refuses bytes that do not start like a PDF, whatever the content type says", async () => {
    const html = new TextEncoder().encode("<html><body>not a manual</body></html>");

    expect(await fetchManual(URL_PDF, http({ get: { body: html } }).client, limits)).toMatchObject({
      ok: false,
      failure: { definite: true, kind: "not_pdf" },
    });
  });

  it("refuses an empty body instead of reading a document of 0 bytes", async () => {
    expect(await fetchManual(URL_PDF, http({ get: { body: new Uint8Array() } }).client, limits)).toMatchObject({
      ok: false,
      failure: { definite: true, kind: "empty" },
    });
  });

  it("refuses a declared size over the cap without downloading it", async () => {
    const { client, calls } = http({ head: { length: String(limits.maxBytes + 1) } });

    const outcome = await fetchManual(URL_PDF, client, limits);

    expect(outcome).toMatchObject({ ok: false, failure: { definite: true, kind: "too_large" } });
    expect(calls.some((c) => c.startsWith("GET ") && !c.endsWith("/robots.txt"))).toBe(false);
  });

  it("stops the stream at the cap when no size was declared", async () => {
    const big = new Uint8Array(limits.maxBytes + 5_000);
    const { client } = http({ head: { length: null }, get: { length: null, body: big } });

    const outcome = await fetchManual(URL_PDF, client, limits);

    expect(outcome).toMatchObject({ ok: false, failure: { definite: true, kind: "too_large" } });
  });

  it("gives up at the timeout, transiently", async () => {
    const hanging: ManualHttp = vi.fn(async (url, init) => {
      if (url.endsWith("/robots.txt")) return response(url, 404, {}, new Uint8Array(), 0);
      return new Promise<GuardedResponse>((_, reject) => {
        init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "TimeoutError")));
      });
    });

    expect(await fetchManual(URL_PDF, hanging, { ...limits, timeoutMs: 50 })).toMatchObject({
      ok: false,
      failure: { definite: false, kind: "timeout" },
    });
  });

  it("treats a network error as transient", async () => {
    const broken: ManualHttp = vi.fn(async (url) => {
      if (url.endsWith("/robots.txt")) return response(url, 404, {}, new Uint8Array(), 0);
      throw new TypeError("socket hang up");
    });

    expect(await fetchManual(URL_PDF, broken, limits)).toMatchObject({ ok: false, failure: { definite: false, kind: "network" } });
  });
});

describe("fetchManual behind the SSRF guard", () => {
  it.each(["http://www.vw.com.br/manuals/gol-2021.pdf", "data:application/pdf;base64,JVBERi0xLjQK", "file:///etc/passwd"])(
    "refuses %s definitely, dialling nothing",
    async (url) => {
      const { client, dialled } = guarded({}, publicDns);

      expect(await fetchManual(url, client, limits)).toMatchObject({ ok: false, failure: { definite: true, kind: "blocked" } });
      expect(dialled).toEqual([]);
    },
  );

  it("refuses a blocked URL before calling even an unguarded client", async () => {
    const { client, calls } = http();

    expect(await fetchManual("http://www.vw.com.br/manuals/gol-2021.pdf", client, limits)).toMatchObject({
      ok: false,
      failure: { definite: true, kind: "blocked" },
    });
    expect(calls).toEqual([]);
  });

  it.each(["https://127.0.0.1/admin", "https://169.254.169.254/latest/meta-data/"])(
    "refuses a redirect to %s without following it",
    async (target) => {
      const { client, dialled } = guarded({ [URL_PDF]: { status: 302, location: target } }, publicDns);

      expect(await fetchManual(URL_PDF, client, limits)).toMatchObject({ ok: false, failure: { definite: true, kind: "blocked" } });
      expect(dialled).not.toContain(target);
    },
  );

  it("refuses a hostname that resolves to a private address, at connect", async () => {
    const internal: LookupFn = (_h, _o, cb) => cb(null, [{ address: "10.0.0.7", family: 4 }]);
    const { client, dialled } = guarded({ [URL_PDF]: { status: 200 } }, internal);

    expect(await fetchManual(URL_PDF, client, limits)).toMatchObject({ ok: false, failure: { definite: true, kind: "blocked" } });
    expect(dialled).toEqual([]);
  });
});

describe("hasPdfMagic and contentTypeToken", () => {
  it("finds %PDF- within the first kilobyte, and not past it", () => {
    const header = new TextEncoder().encode("%PDF-1.7");
    const late = new Uint8Array(2048);
    late.set(header, 1500);
    const early = new Uint8Array(2048);
    early.set(header, 500);

    expect(hasPdfMagic(early)).toBe(true);
    expect(hasPdfMagic(late)).toBe(false);
    expect(hasPdfMagic(new TextEncoder().encode("%PDF"))).toBe(false);
  });

  it("reduces any content type to an allow-listed token", () => {
    expect(contentTypeToken("application/pdf; name=x")).toBe("pdf");
    expect(contentTypeToken("text/html")).toBe("html");
    expect(contentTypeToken("application/x-evil\r\ninjected: 1")).toBe("other");
    expect(contentTypeToken(null)).toBe("none");
  });
});

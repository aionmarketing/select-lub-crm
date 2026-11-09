/**
 * Test design (testing-strategy) — the SSRF guard
 *
 * SUT: assertAllowedUrl, isPublicAddress, guardedLookup and createGuardedHttp, with an injected
 *   resolver and raw request (no socket).
 *
 * Oracle: review of #180 (2026-09-25, HIGH): only https; no loopback, private, link-local
 *   (169.254.169.254), 0.0.0.0/8, CGNAT or `*.internal` destination, whether given directly, by
 *   a redirect, or by a name that resolves to one; the address is checked in the connection's
 *   own lookup, so the address checked is the address dialled; at most five redirects; bodies
 *   capped. Second review of #180: an IPv4 address carried inside IPv6 (compatible, mapped,
 *   translated, NAT64, 6to4) is judged as that IPv4 address; fec0::/10, the local-use NAT64
 *   prefix and the documentation ranges are refused; decimal and hex host literals are read as
 *   the address they spell. The real-socket loop is in guarded-http.socket.test.ts.
 */
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import {
  assertAllowedUrl,
  BlockedUrlError,
  createGuardedHttp,
  guardedLookup,
  isPublicAddress,
  MAX_REDIRECTS,
  type LookupFn,
  type RawRequest,
} from "./guarded-http.js";

const resolvesTo = (...addresses: string[]): LookupFn => (_host, _opts, cb) =>
  cb(null, addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })));

/** A raw request answering by URL; records each URL and the lookup it was given. */
function answering(byUrl: Record<string, { status: number; location?: string; body?: string }>) {
  const seen: string[] = [];
  const lookups: unknown[] = [];
  const request: RawRequest = async (url, options, init) => {
    seen.push(url.href);
    lookups.push(options.lookup);
    const a = byUrl[url.href] ?? { status: 404 };
    const headers: Record<string, string> = a.location ? { location: a.location } : {};
    const body = new TextEncoder().encode(a.body ?? "");
    const truncated = body.byteLength > init.maxBytes;
    return { res: { statusCode: a.status, headers } as unknown as IncomingMessage, body: truncated ? body.slice(0, init.maxBytes) : body, truncated };
  };
  return { request, seen, lookups };
}

const init = { method: "GET" as const, signal: new AbortController().signal, maxBytes: 1_000_000, redirect: "follow" as const };

describe("assertAllowedUrl", () => {
  it.each(["http://www.vw.com.br/a.pdf", "data:application/pdf;base64,JVBERi0=", "file:///etc/passwd", "ftp://vw.com.br/a.pdf"])(
    "refuses %s",
    (url) => {
      expect(() => assertAllowedUrl(url)).toThrow(BlockedUrlError);
    },
  );

  it.each([
    "https://127.0.0.1/",
    "https://169.254.169.254/latest/meta-data/",
    "https://10.1.2.3/",
    "https://172.16.0.1/",
    "https://192.168.1.1/",
    "https://100.64.0.1/",
    "https://0.0.0.0/",
    "https://[::1]/",
    "https://[fd00::1]/",
    "https://[fe80::1]/",
    "https://[::ffff:127.0.0.1]/",
    "https://localhost/",
    "https://api.localhost/",
    "https://select-lub-crm-api.internal/",
    // The URL parser reads these as 127.0.0.1 and 169.254.169.254.
    "https://2130706433/",
    "https://0x7f000001/",
    "https://127.1/",
    "https://0177.0.0.1/",
    "https://2852039166/",
  ])("refuses %s", (url) => {
    expect(() => assertAllowedUrl(url)).toThrow(BlockedUrlError);
  });

  it("allows a public https URL", () => {
    expect(assertAllowedUrl("https://www.vw.com.br/manual.pdf").hostname).toBe("www.vw.com.br");
  });
});

describe("isPublicAddress", () => {
  it.each([
    "93.184.216.34",
    "200.147.67.142",
    "2606:2800:220:1::1",
    // An IPv4 address carried inside IPv6 is judged as itself: these carry 8.8.8.8.
    "::ffff:8.8.8.8",
    "::8.8.8.8",
    "::ffff:0:808:808",
    "64:ff9b::808:808",
    "2002:808:808::1",
  ])("treats %s as public", (ip) => {
    expect(isPublicAddress(ip)).toBe(true);
  });

  it.each([
    // IPv4 documentation and 6to4 relay ranges.
    "192.0.2.10",
    "198.51.100.10",
    "203.0.113.10",
    "192.88.99.1",
    // IPv4 carried inside IPv6: compatible, mapped, translated, NAT64 and 6to4, each hiding a
    // loopback or metadata address.
    "::127.0.0.1",
    "::ffff:169.254.169.254",
    "::ffff:0:7f00:1",
    "64:ff9b::a9fe:a9fe",
    "2002:7f00:1::1",
    // Local-use NAT64, whose embedding cannot be known.
    "64:ff9b:1::808:808",
    // Site-local, unique local, link-local, multicast, discard.
    "fec0::1",
    "fd12::1",
    "fe80::1",
    "ff02::1",
    "100::1",
    // Special purpose (Teredo, benchmarking) and documentation.
    "2001::1",
    "2001:2::1",
    "2001:db8::1",
    "3fff::1",
    // Not an address at all.
    "vw.com.br",
  ])("refuses %s", (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });
});

describe("guardedLookup", () => {
  const run = (base: LookupFn) =>
    new Promise<{ err: Error | null; address?: unknown }>((resolve) =>
      (guardedLookup(base) as unknown as (h: string, o: object, cb: (e: Error | null, a?: unknown) => void) => void)(
        "manuals.example",
        {},
        (err, address) => resolve({ err, address }),
      ),
    );

  it("refuses a name that resolves to a private address", async () => {
    expect((await run(resolvesTo("10.0.0.5"))).err).toBeInstanceOf(BlockedUrlError);
  });

  it("refuses a name with ANY private address, even behind a public one", async () => {
    expect((await run(resolvesTo("93.184.216.34", "169.254.169.254"))).err).toBeInstanceOf(BlockedUrlError);
  });

  it("hands the connection the public address it checked", async () => {
    expect(await run(resolvesTo("93.184.216.34"))).toEqual({ err: null, address: "93.184.216.34" });
  });

  /** The same lookup, asked the way a connection racing IPv4 and IPv6 asks: every address. */
  const runAll = (base: LookupFn) =>
    new Promise<{ err: Error | null; addresses?: unknown }>((resolve) =>
      (guardedLookup(base) as unknown as (h: string, o: object, cb: (e: Error | null, a?: unknown) => void) => void)(
        "manuals.example",
        { all: true },
        (err, addresses) => resolve({ err, addresses }),
      ),
    );

  it("hands every address over when all of them are asked for and all are public", async () => {
    expect(await runAll(resolvesTo("93.184.216.34", "2606:2800:220:1::1"))).toEqual({
      err: null,
      addresses: [
        { address: "93.184.216.34", family: 4 },
        { address: "2606:2800:220:1::1", family: 6 },
      ],
    });
  });

  it("refuses every address when all are asked for and one is private", async () => {
    expect((await runAll(resolvesTo("93.184.216.34", "fd00::1"))).err).toBeInstanceOf(BlockedUrlError);
  });
});

describe("createGuardedHttp", () => {
  it("refuses a redirect to 127.0.0.1 without following it", async () => {
    const { request, seen } = answering({ "https://www.vw.com.br/a.pdf": { status: 302, location: "https://127.0.0.1/admin" } });

    await expect(createGuardedHttp({ request, lookup: resolvesTo("93.184.216.34") })("https://www.vw.com.br/a.pdf", init)).rejects.toThrow(BlockedUrlError);
    expect(seen).toEqual(["https://www.vw.com.br/a.pdf"]);
  });

  it("refuses a redirect to the cloud metadata address", async () => {
    const { request, seen } = answering({ "https://www.vw.com.br/a.pdf": { status: 301, location: "https://169.254.169.254/latest/meta-data/" } });

    await expect(createGuardedHttp({ request })("https://www.vw.com.br/a.pdf", init)).rejects.toThrow(BlockedUrlError);
    expect(seen).toHaveLength(1);
  });

  it("refuses a redirect down to http", async () => {
    const { request } = answering({ "https://www.vw.com.br/a.pdf": { status: 302, location: "http://www.vw.com.br/a.pdf" } });

    await expect(createGuardedHttp({ request })("https://www.vw.com.br/a.pdf", init)).rejects.toThrow(/scheme http:/);
  });

  it("dials through the guarded lookup, so a private resolution is refused at connect", async () => {
    const { request, lookups } = answering({ "https://manuals.example/a.pdf": { status: 200, body: "%PDF-" } });
    await createGuardedHttp({ request, lookup: resolvesTo("10.0.0.5") })("https://manuals.example/a.pdf", init);

    const given = lookups[0] as (h: string, o: object, cb: (e: Error | null) => void) => void;
    const err = await new Promise<Error | null>((resolve) => given("manuals.example", {}, resolve));
    expect(err).toBeInstanceOf(BlockedUrlError);
  });

  it("follows a public redirect, checked, and stops after the cap", async () => {
    const chain: Record<string, { status: number; location?: string }> = {};
    for (let i = 0; i <= MAX_REDIRECTS + 1; i += 1) chain[`https://www.vw.com.br/${i}`] = { status: 302, location: `https://www.vw.com.br/${i + 1}` };
    const { request, seen } = answering(chain);

    await expect(createGuardedHttp({ request })("https://www.vw.com.br/0", init)).rejects.toThrow(/redirects/);
    expect(seen).toHaveLength(MAX_REDIRECTS + 1);
  });

  it("returns a 3xx as is when redirects are manual", async () => {
    const { request } = answering({ "https://www.vw.com.br/a": { status: 302, location: "https://127.0.0.1/" } });

    expect((await createGuardedHttp({ request })("https://www.vw.com.br/a", { ...init, redirect: "manual" })).status).toBe(302);
  });

  it("caps the body and says so", async () => {
    const { request } = answering({ "https://www.vw.com.br/a": { status: 200, body: "x".repeat(50) } });

    const res = await createGuardedHttp({ request })("https://www.vw.com.br/a", { ...init, maxBytes: 10 });
    expect(res.truncated).toBe(true);
    expect(res.body.byteLength).toBe(10);
  });
});

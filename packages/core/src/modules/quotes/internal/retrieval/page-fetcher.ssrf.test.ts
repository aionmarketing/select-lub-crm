/**
 * Test design (testing-strategy) — fetchPage behind the SSRF guard
 *
 * SUT: fetchPage, with a fake transport for the up-front URL check, and with the REAL
 *   guardedTransport over a raw exchange that "dials" the way node:https does — through the
 *   connection's lookup — for redirects and resolutions.
 *
 * Oracle: review of #180 (2026-09-25, HIGH): a page URL comes from a search result, so it is
 *   untrusted. Only public https is fetched: `http:`, `data:`, `file:` and a private IP literal
 *   are refused before anything is requested, even with an injected transport; a redirect to
 *   169.254.169.254 or 127.0.0.1 is not followed, for the page or its robots.txt; a name that
 *   resolves to a private address is refused at connect. A refused URL is `blocked`.
 */
import type { IncomingMessage } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createGuardedHttp, type LookupFn, type RawRequest } from "../net/guarded-http.js";
import { fetchPage, guardedTransport, type FetchTransport } from "./page-fetcher.js";

const PAGE = "https://vw.com.br/manual";

/** A fake transport that records every request and answers 404. */
function fakeTransport() {
  const calls: string[] = [];
  const transport = vi.fn<FetchTransport>(async (url, init) => {
    calls.push(`${init.method} ${url}`);
    return { status: 404, headers: { get: () => null }, text: async () => "" };
  });
  return { transport, calls };
}

describe("fetchPage behind the SSRF guard", () => {
  it.each([
    "http://vw.com.br/manual",
    "data:text/html,<p>hi</p>",
    "file:///etc/passwd",
    "https://169.254.169.254/latest/meta-data/",
    "https://10.0.0.1/admin",
  ])("refuses %s before requesting anything", async (url) => {
    const { transport, calls } = fakeTransport();

    const out = await fetchPage(url, { transport });

    expect(out).toMatchObject({ ok: false, refusal: { kind: "blocked" } });
    expect(calls).toEqual([]);
  });

  /** The real guarded transport over a raw exchange that resolves through the connection's lookup. */
  function guarded(byUrl: Record<string, { status: number; location?: string; type?: string; body?: string }>, resolve: LookupFn) {
    const dialled: string[] = [];
    const request: RawRequest = async (url, options) => {
      const lookup = options.lookup as unknown as (h: string, o: object, cb: (err: Error | null) => void) => void;
      await new Promise<void>((ok, fail) => lookup(url.hostname, {}, (err) => (err ? fail(err) : ok())));
      dialled.push(url.href);
      const a = byUrl[url.href] ?? { status: 404 };
      const headers: Record<string, string> = {};
      if (a.location) headers.location = a.location;
      if (a.type) headers["content-type"] = a.type;
      const body = new TextEncoder().encode(a.body ?? "");
      return { res: { statusCode: a.status, headers } as unknown as IncomingMessage, body, truncated: false };
    };
    return { transport: guardedTransport(createGuardedHttp({ request, lookup: resolve })), dialled };
  }

  const publicDns: LookupFn = (_h, _o, cb) => cb(null, [{ address: "93.184.216.34", family: 4 }]);

  it("reads a public page through the guarded transport", async () => {
    const { transport } = guarded(
      { [PAGE]: { status: 200, type: "text/html", body: "<p>Óleo 5W-40</p>" } },
      publicDns,
    );

    const out = await fetchPage(PAGE, { transport });

    expect(out).toMatchObject({ ok: true, page: { text: "Óleo 5W-40" } });
  });

  it("refuses a page that redirects to the cloud metadata address", async () => {
    const { transport, dialled } = guarded(
      {
        [`${PAGE}`]: { status: 302, location: "https://169.254.169.254/latest/meta-data/" },
      },
      publicDns,
    );

    const out = await fetchPage(PAGE, { transport });

    // The page's own requests go out with redirect "manual", so the 302 is not followed at all.
    expect(out.ok).toBe(false);
    expect(dialled.some((u) => u.includes("169.254"))).toBe(false);
  });

  it("does not follow a robots.txt redirect to a private address", async () => {
    const { transport, dialled } = guarded(
      {
        "https://vw.com.br/robots.txt": { status: 301, location: "https://127.0.0.1/robots.txt" },
        [PAGE]: { status: 200, type: "text/html", body: "<p>ok</p>" },
      },
      publicDns,
    );

    await fetchPage(PAGE, { transport });

    expect(dialled).not.toContain("https://127.0.0.1/robots.txt");
  });

  it("refuses a page whose name resolves to a private address", async () => {
    const internal: LookupFn = (_h, _o, cb) => cb(null, [{ address: "10.0.0.7", family: 4 }]);
    const { transport, dialled } = guarded({ [PAGE]: { status: 200, type: "text/html", body: "<p>x</p>" } }, internal);

    const out = await fetchPage(PAGE, { transport });

    expect(out).toMatchObject({ ok: false, refusal: { kind: "blocked" } });
    expect(dialled).toEqual([]);
  });

  it("follows a same-host redirect over the guarded transport and cites the target", async () => {
    const to = "https://vw.com.br/manual/";
    const { transport, dialled } = guarded(
      {
        [PAGE]: { status: 301, location: "/manual/" },
        [to]: { status: 200, type: "text/html", body: "<p>Óleo 5W-40</p>" },
      },
      publicDns,
    );

    const out = await fetchPage(PAGE, { transport });

    expect(out).toMatchObject({ ok: true, page: { url: to, text: "Óleo 5W-40" } });
    expect(dialled).toContain(to);
  });

  it("refuses a same-host redirect whose name now resolves to a private address", async () => {
    let answers = 0;
    // Public for the first dial of the name, private from then on (a rebinding).
    const rebinding: LookupFn = (_h, _o, cb) => {
      answers += 1;
      cb(null, [{ address: answers <= 2 ? "93.184.216.34" : "10.0.0.7", family: 4 }]);
    };
    const to = "https://vw.com.br/manual/";
    const { transport, dialled } = guarded(
      {
        [PAGE]: { status: 301, location: "/manual/" },
        [to]: { status: 200, type: "text/html", body: "<p>x</p>" },
      },
      rebinding,
    );

    const out = await fetchPage(PAGE, { transport });

    expect(out).toMatchObject({ ok: false, refusal: { kind: "blocked" } });
    expect(dialled).not.toContain(to);
  });
});

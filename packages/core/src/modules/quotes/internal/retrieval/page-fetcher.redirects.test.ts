/**
 * Test design (testing-strategy) — fetchPage and its redirects (oil-research-web-retrieval D1)
 *
 * SUT: fetchPage and requestFollowing (retrieval/redirects.ts). The transport is an injected
 * fake — no socket.
 *
 * Oracle: specs/quotes/oil-spec-web-search "Only HTML text is extracted; documents are recorded
 * as manual candidates": a redirect is followed for at most three hops, every hop passing the
 * same checks as the first request, and only within the same host; anything else is a definite
 * refusal; the page is cited to the URL that answered.
 *
 * Axes
 *   F1 hop target — same host (trailing slash, www.) / another host / non-public / blocked
 *   F2 chain — one hop / over three / HEAD and GET sharing the budget / no Location
 *   F3 what the target is — HTML / a document / a path robots.txt forbids
 *   F4 what the Location carries — credentials / another port / a different origin only the GET reaches
 *   F5 time — the hops share the page's one timeout
 *
 * Sampled cells (one row per `it`)
 *   301 to the trailing-slash form | F1    | read, `page.url` is the target, the origin never GET
 *   308 adding www.                 | F1    | read, document links resolved against the target
 *   302 to a PDF                    | F3    | `document` refusal naming the PDF that answered
 *   308 to another host             | F1    | `redirect`, the other host never requested
 *   301 to 169.254.169.254          | F1    | `blocked`, never requested
 *   301 with no Location, 4th hop   | F2    | `redirect`
 *   2 hops on HEAD + 2 on GET       | F2    | `redirect`: the budget is shared
 *   target disallowed by robots     | F3    | `robots`, the target never GET
 *   Location with userinfo          | F4    | `redirect`, never requested
 *   same host, another port         | F4    | `redirect`: another service
 *   GET-only redirect to www.       | F4,F3 | the final origin's robots.txt is checked and obeyed
 *   a hop that never answers        | F5    | `network` once the shared timeout fires, not after one timeout per hop
 *
 * Out of scope: the guarded transport's own checks (page-fetcher.ssrf.test.ts), what the
 * adapter does with each refusal (web-search.unread.test.ts).
 */
import { describe, expect, it, vi } from "vitest";
import { fetchPage, type FetchTransport } from "./page-fetcher.js";

const PAGE = "https://vw.com.br/manual";

function headers(map: Record<string, string>) {
  return { get: (name: string) => map[name.toLowerCase()] ?? null };
}

/** A transport whose replies are keyed by `${method} ${url}`, recording every call. */
function fakeTransport(routes: Record<string, { status: number; type?: string; body?: string; location?: string }>) {
  const calls: string[] = [];
  const transport = vi.fn<FetchTransport>(async (url, init) => {
    const key = `${init.method} ${url}`;
    calls.push(key);
    const route = routes[key] ?? routes[`* ${url}`] ?? (url.endsWith("/robots.txt") ? { status: 404 } : undefined);
    if (!route) {
      return { status: 404, headers: headers({}), text: async () => "" };
    }
    return {
      status: route.status,
      headers: headers({
        ...(route.type ? { "content-type": route.type } : {}),
        ...(route.location ? { location: route.location } : {}),
      }),
      text: async () => route.body ?? "",
    };
  });
  return { transport, calls };
}

describe("fetchPage redirects", () => {
  const HTML = "<html><head><title>Manual</title></head><body><p>Óleo 5W-30</p></body></html>";

  it("follows a 301 to the trailing-slash form and cites the page that answered", async () => {
    const from = "https://www.omecanico.com.br/hb20";
    const to = "https://www.omecanico.com.br/hb20/";
    const { transport, calls } = fakeTransport({
      [`HEAD ${from}`]: { status: 301, location: "/hb20/" },
      [`HEAD ${to}`]: { status: 200, type: "text/html" },
      [`GET ${to}`]: { status: 200, type: "text/html", body: HTML },
    });

    const out = await fetchPage(from, { transport });

    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("expected a page");
    expect(out.page.url).toBe(to);
    expect(out.page.text).toContain("5W-30");
    expect(calls).not.toContain(`GET ${from}`);
  });

  it("follows a 308 that adds the www. form, and resolves document links against the target", async () => {
    const from = "https://olhonocarro.com.br/hb20";
    const to = "https://www.olhonocarro.com.br/hb20";
    const { transport } = fakeTransport({
      [`HEAD ${from}`]: { status: 308, location: to },
      [`HEAD ${to}`]: { status: 200, type: "text/html" },
      [`GET ${to}`]: {
        status: 200,
        type: "text/html",
        body: '<a href="/files/hb20.pdf">Manual HB20</a>',
      },
    });

    const out = await fetchPage(from, { transport });

    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("expected a page");
    expect(out.page.url).toBe(to);
    expect(out.page.documentLinks).toEqual([{ url: "https://www.olhonocarro.com.br/files/hb20.pdf", label: "Manual HB20" }]);
  });

  it("records a redirect to a document as that document", async () => {
    const from = "https://hyundai.com.br/manual";
    const to = "https://hyundai.com.br/files/hb20.pdf";
    const { transport } = fakeTransport({
      [`HEAD ${from}`]: { status: 302, location: to },
      [`HEAD ${to}`]: { status: 200, type: "application/pdf" },
    });

    const out = await fetchPage(from, { transport });

    expect(out).toMatchObject({ ok: false, refusal: { kind: "document", url: to } });
  });

  it("does not follow a redirect to another host, and never requests it", async () => {
    const from = "https://olhonocarro.com.br/hb20";
    const { transport, calls } = fakeTransport({
      [`HEAD ${from}`]: { status: 308, location: "https://other-site.com/hb20" },
    });

    const out = await fetchPage(from, { transport });

    expect(out).toMatchObject({ ok: false, refusal: { kind: "redirect" } });
    expect(calls.some((c) => c.includes("other-site.com"))).toBe(false);
  });

  it("refuses a redirect to a non-public address before any request to it", async () => {
    const from = "https://vw.com.br/manual";
    const { transport, calls } = fakeTransport({
      [`HEAD ${from}`]: { status: 301, location: "https://169.254.169.254/latest/meta-data/" },
    });

    const out = await fetchPage(from, { transport });

    expect(out).toMatchObject({ ok: false, refusal: { kind: "blocked" } });
    expect(calls.some((c) => c.includes("169.254.169.254"))).toBe(false);
  });

  it("refuses a redirect with no Location", async () => {
    const { transport } = fakeTransport({ [`HEAD ${PAGE}`]: { status: 301 } });

    const out = await fetchPage(PAGE, { transport });

    expect(out).toMatchObject({ ok: false, refusal: { kind: "redirect", message: expect.stringContaining("Location") } });
  });

  it("stops after the third hop", async () => {
    const hop = (n: number) => `https://vw.com.br/step-${n}`;
    const { transport, calls } = fakeTransport({
      [`HEAD ${hop(0)}`]: { status: 301, location: hop(1) },
      [`HEAD ${hop(1)}`]: { status: 301, location: hop(2) },
      [`HEAD ${hop(2)}`]: { status: 301, location: hop(3) },
      [`HEAD ${hop(3)}`]: { status: 301, location: hop(4) },
      [`HEAD ${hop(4)}`]: { status: 200, type: "text/html" },
    });

    const out = await fetchPage(hop(0), { transport });

    expect(out).toMatchObject({ ok: false, refusal: { kind: "redirect", message: expect.stringContaining("more than 3") } });
    expect(calls).not.toContain(`HEAD ${hop(4)}`);
  });

  it("shares the hop budget between the HEAD and the GET", async () => {
    const a = "https://vw.com.br/a";
    const b = "https://vw.com.br/b";
    const c = "https://vw.com.br/c";
    const d = "https://vw.com.br/d";
    const e = "https://vw.com.br/e";
    const { transport } = fakeTransport({
      [`HEAD ${a}`]: { status: 301, location: b },
      [`HEAD ${b}`]: { status: 301, location: c },
      [`HEAD ${c}`]: { status: 200, type: "text/html" },
      [`GET ${c}`]: { status: 301, location: d },
      [`GET ${d}`]: { status: 301, location: e },
    });

    const out = await fetchPage(a, { transport });

    // Two hops spent on the HEAD leave one for the GET: the second GET hop is the fourth overall.
    expect(out).toMatchObject({ ok: false, refusal: { kind: "redirect" } });
  });

  it("honours the robots.txt of the page a redirect landed on", async () => {
    const from = "https://vw.com.br/manual";
    const to = "https://vw.com.br/private/manual";
    const { transport, calls } = fakeTransport({
      "GET https://vw.com.br/robots.txt": { status: 200, body: "User-agent: *\nDisallow: /private" },
      [`HEAD ${from}`]: { status: 301, location: to },
      [`HEAD ${to}`]: { status: 200, type: "text/html" },
    });

    const out = await fetchPage(from, { transport });

    expect(out).toMatchObject({ ok: false, refusal: { kind: "robots" } });
    expect(calls).not.toContain(`GET ${to}`);
  });

  it("refuses a Location that carries credentials, and never requests it", async () => {
    const from = "https://vw.com.br/manual";
    const { transport, calls } = fakeTransport({
      [`HEAD ${from}`]: { status: 301, location: "https://user:secret@vw.com.br/manual" },
    });

    const out = await fetchPage(from, { transport });

    expect(out).toMatchObject({ ok: false, refusal: { kind: "redirect", message: expect.stringContaining("credentials") } });
    expect(calls.some((c) => c.includes("secret"))).toBe(false);
  });

  it("treats a port change as another host", async () => {
    const from = "https://vw.com.br/manual";
    const { transport, calls } = fakeTransport({
      [`HEAD ${from}`]: { status: 301, location: "https://vw.com.br:8443/manual" },
    });

    const out = await fetchPage(from, { transport });

    expect(out).toMatchObject({ ok: false, refusal: { kind: "redirect", message: expect.stringContaining("another host") } });
    expect(calls.some((c) => c.includes("8443"))).toBe(false);
  });

  it("checks robots.txt again for an origin only the GET reaches", async () => {
    const from = "https://vw.com.br/manual";
    const to = "https://www.vw.com.br/manual";
    const { transport, calls } = fakeTransport({
      "GET https://www.vw.com.br/robots.txt": { status: 200, body: "User-agent: *\nDisallow: /" },
      [`HEAD ${from}`]: { status: 200, type: "text/html" },
      [`GET ${from}`]: { status: 301, location: to },
      [`HEAD ${to}`]: { status: 200, type: "text/html" },
      [`GET ${to}`]: { status: 200, type: "text/html", body: "<p>x</p>" },
    });

    const out = await fetchPage(from, { transport });

    expect(out).toMatchObject({ ok: false, refusal: { kind: "robots" } });
    expect(calls).toContain("GET https://www.vw.com.br/robots.txt");
    expect(calls).not.toContain(`GET ${to}`);
  });

  it("spends one timeout across the hops, not one per hop", async () => {
    const hop = (n: number) => `https://vw.com.br/step-${n}`;
    const started = Date.now();
    // Every hop answers a redirect after 40 ms; the third never answers at all, until aborted.
    const transport = vi.fn<FetchTransport>(async (url, init) => {
      if (url.endsWith("/robots.txt")) return { status: 404, headers: headers({}), text: async () => "" };
      const n = Number(/step-(d)/.exec(url)![1]);
      if (n >= 2) {
        await new Promise<never>((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
      }
      await new Promise((ok) => setTimeout(ok, 40));
      return { status: 301, headers: headers({ location: hop(n + 1) }), text: async () => "" };
    });

    const out = await fetchPage(hop(0), { transport, timeoutMs: 200 });

    expect(out).toMatchObject({ ok: false, refusal: { kind: "network" } });
    expect(Date.now() - started).toBeLessThan(1_500);
  });
});

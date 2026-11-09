/**
 * Test design (testing-strategy) — what the web adapter counts as a page left unread
 *
 * SUT: createWebSearchRetriever with an injected search, transport and log.
 *
 * Oracle: review of #176 (2026-09-25) — an admitted page whose content is unknown (a
 *   transient status, a network failure, or the budget) makes the search incomplete, so it is
 *   never remembered as a miss; a definite answer — a 4xx other than 408/429, a robots.txt
 *   disallow, "not a page" — counts as read; a provider that fails makes the search
 *   `unavailable`.
 *
 * Cells: a redirect that was not followed → not counted (definite: a retry meets the same one) |
 *   a same-host redirect → read once, cited to the target (oil-research-web-retrieval D1) |
 *   budget-skipped → counted | robots → not counted (definite, like a 403) |
 *   not_html → not counted |
 *   the search throws → unavailable | a definite 4xx → not counted, a transient status →
 *   counted (orchestrator ruling on #176: 404, 410, 401, 403 and other 4xx are definite;
 *   5xx, 408 and 429 are transient)
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SearchCandidate } from "./admit.js";
import type { FetchTransport } from "./page-fetcher.js";
import { SearchUnavailableError } from "./search-fn.js";
import { createWebSearchRetriever, leftUnread } from "./web-search.js";

const identity = { make: "Fiat", year: 2021, model: "Argo", version: "1.0 Firefly" };
const A = "https://fiat.com.br/a.html";
const B = "https://fiat.com.br/b.html";
const IMAGE = "https://fiat.com.br/argo.png";

const hit = (url: string): SearchCandidate => ({ url, classification: "manufacturer_manual", reason: "r", title: "t" });

function transport(robots = ""): FetchTransport {
  return vi.fn(async (url: string, init: { method: "GET" | "HEAD" }) => {
    if (url.endsWith("/robots.txt")) {
      return { status: robots ? 200 : 404, headers: { get: () => "text/plain" }, text: async (): Promise<string> => robots };
    }
    const type = url.endsWith(".png") ? "image/png" : "text/html";
    const answered = /\/status-(\d+)\.html$/.exec(url);
    if (answered) {
      return { status: Number(answered[1]), headers: { get: () => type }, text: async (): Promise<string> => "" };
    }
    if (init.method === "HEAD") {
      return { status: 200, headers: { get: () => type }, text: async (): Promise<string> => "" };
    }
    return {
      status: 200,
      headers: { get: () => type },
      text: async (): Promise<string> => "<html><title>Fiat</title><body>Fiat Argo manual.</body></html>",
    };
  }) as unknown as FetchTransport;
}

function retriever(hits: SearchCandidate[], t: FetchTransport) {
  return createWebSearchRetriever({ search: async () => hits, transport: t, log: () => {} });
}

afterEach(() => {
  delete process.env.WEB_SEARCH_MAX_FETCHES;
});

describe("admitted pages left unread", () => {
  it("counts a page the read cap left unfetched", async () => {
    process.env.WEB_SEARCH_MAX_FETCHES = "1";

    expect(await retriever([hit(A), hit(B)], transport())(identity)).toMatchObject({ status: "found", unreadAdmitted: 1 });
  });

  it("does not count a page robots.txt forbids: we may never read it, so that is definite", async () => {
    const result = await retriever([hit(A)], transport("User-agent: *\nDisallow: /"))(identity);

    expect(result).toEqual({ status: "none" });
  });

  it("does not count a URL that answered it is not a page", async () => {
    const result = await retriever([hit(A), hit(IMAGE)], transport())(identity);

    expect(result.status).toBe("found");
    expect(result).not.toHaveProperty("unreadAdmitted");
  });

  it("answers unavailable when the search itself fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failing = createWebSearchRetriever({
      search: async () => {
        throw new SearchUnavailableError("search tool call failed");
      },
      transport: transport(),
      log: () => {},
    });

    expect(await failing(identity)).toEqual({ status: "unavailable" });
  });
});

describe("a status is definite or transient", () => {
  it.each([400, 401, 403, 404, 410, 451])("counts a %i as read: the page will say the same again", (status) => {
    expect(leftUnread({ kind: "status", status })).toBe(false);
  });

  it.each([408, 429, 500, 502, 503, 504])("counts a %i as unread: a retry may read it", (status) => {
    expect(leftUnread({ kind: "status", status })).toBe(true);
  });

  it("counts a network failure as unread, and robots, not-a-page, a document and a blocked URL as read", () => {
    expect(leftUnread({ kind: "network", message: "timeout" })).toBe(true);
    expect(leftUnread({ kind: "blocked", message: "scheme http: is not allowed" })).toBe(false);
    expect(leftUnread({ kind: "robots" })).toBe(false);
    expect(leftUnread({ kind: "not_html", contentType: "image/png" })).toBe(false);
    expect(leftUnread({ kind: "document", contentType: "application/pdf", url: "https://fiat.com.br/argo.pdf" })).toBe(false);
    expect(leftUnread({ kind: "redirect", message: "301 to another host (x.com)" })).toBe(false);
  });

  it("leaves a 404 beside a read page complete, and a 503 incomplete", async () => {
    const gone = await retriever([hit(A), hit("https://fiat.com.br/status-404.html")], transport())(identity);
    const busy = await retriever([hit(A), hit("https://fiat.com.br/status-503.html")], transport())(identity);

    expect(gone.status).toBe("found");
    expect(gone).not.toHaveProperty("unreadAdmitted");
    expect(busy).toMatchObject({ status: "found", unreadAdmitted: 1 });
  });
});

describe("redirects (oil-research-web-retrieval D1)", () => {
  const OLD_A = "https://omecanico.com.br/argo";
  const OLD_B = "https://www.omecanico.com.br/argo";
  const NEW = "https://www.omecanico.com.br/argo/";

  /** Routes by URL: `redirects` answers a 3xx with a Location, everything else is an HTML page. */
  function redirecting(redirects: Record<string, { status: number; location?: string }>): FetchTransport {
    return vi.fn(async (url: string, init: { method: "GET" | "HEAD" }) => {
      if (url.endsWith("/robots.txt")) {
        return { status: 404, headers: { get: () => null }, text: async (): Promise<string> => "" };
      }
      const redirect = redirects[url];
      if (redirect) {
        return {
          status: redirect.status,
          headers: { get: (name: string) => (name === "location" ? (redirect.location ?? null) : null) },
          text: async (): Promise<string> => "",
        };
      }
      return {
        status: 200,
        headers: { get: () => "text/html" },
        text: async (): Promise<string> => (init.method === "HEAD" ? "" : "<html><title>Argo</title><body>Fiat Argo oil.</body></html>"),
      };
    }) as unknown as FetchTransport;
  }

  it("reads a page behind a same-host redirect and cites the page that answered", async () => {
    const result = await retriever([hit(OLD_A)], redirecting({ [OLD_A]: { status: 301, location: NEW } }))(identity);

    expect(result).toMatchObject({ status: "found", sources: [{ url: NEW }] });
    expect(result).not.toHaveProperty("unreadAdmitted");
  });

  it("does not leave the search incomplete for a redirect to another host: a retry meets the same one", async () => {
    const result = await retriever([hit(OLD_A)], redirecting({ [OLD_A]: { status: 308, location: "https://elsewhere.com/argo" } }))(identity);

    expect(result).toEqual({ status: "none" });
  });

  it("reads two results that redirect to one page once, and counts one read", async () => {
    const t = redirecting({ [OLD_A]: { status: 301, location: NEW }, [OLD_B]: { status: 301, location: NEW } });
    const logs: Array<{ fetched: number }> = [];
    const adapter = createWebSearchRetriever({ search: async () => [hit(OLD_A), hit(OLD_B)], transport: t, log: (entry) => logs.push(entry) });

    const result = await adapter(identity);

    expect(result).toMatchObject({ status: "found" });
    expect((result as { sources: unknown[] }).sources).toHaveLength(1);
    expect(logs[0]?.fetched).toBe(1);
  });
});

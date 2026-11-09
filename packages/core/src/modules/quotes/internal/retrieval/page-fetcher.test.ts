/**
 * Test design (testing-strategy)
 *
 * SUT: fetchPage and its helpers (apps/api/src/oil-quote/page-fetcher.ts). The transport is
 * an injected fake — no socket, per D9.
 *
 * Oracle: specs/quotes/oil-spec-web-search/spec.md "Only HTML text is extracted; documents are
 * recorded as manual candidates", plus design D4 (robots honoured, no credentials, capped
 * text, tables kept as lines).
 *
 * Axes
 *   F1 content type — text/html / application/pdf / application/json / absent
 *   F2 where the type is learned — HEAD headers / GET headers / URL extension
 *   F3 robots.txt — absent / allows / disallows this path
 *   F4 body size vs cap — under / over
 *   F5 transport behaviour — resolves / throws / non-2xx status
 *
 * Outputs: O1 ok with text; O2 refusal kind; O3 whether the body was ever read
 *
 * Sampled cells (one row per `it`)
 *   html + robots absent      | F1,F3   | O1 text, tables as lines
 *   pdf via HEAD              | F1,F2,F3| O2 `document`, O3 body NEVER read. THE case #77
 *      depends on: a manual must be recorded as a candidate, not downloaded and discarded
 *   pdf via URL extension     | F2      | O2 `document` even when the server says html —
 *      a mislabelled type must not smuggle a binary into the prompt
 *   json                      | F1      | O2 `not_html`
 *   robots disallow           | F3      | O2 `robots`, O3 page never requested
 *   body over cap             | F4      | O1 truncated exactly at the cap
 *   transport throws          | F5      | O2 `network`, no exception escapes
 *   404                       | F5      | O2 `status`
 *
 * Out of scope: redirects (page-fetcher.redirects.test.ts); admission (admit.test.ts); ordering and budget (adapter tests); extraction;
 * the SSRF guard (page-fetcher.ssrf.test.ts).
 */
import { describe, expect, it, vi } from "vitest";
import {
  DOCUMENT_LINK_CAP,
  DOCUMENT_LINK_SCAN_LIMIT,
  extractDocumentLinks,
  fetchPage,
  htmlToText,
  htmlTitle,
  isDocument,
  PAGE_TEXT_CAP,
  type FetchTransport,
} from "../retrieval/page-fetcher.js";

function headers(map: Record<string, string>) {
  return { get: (name: string) => map[name.toLowerCase()] ?? null };
}

/** A transport whose replies are keyed by `${method} ${url}`, recording every call. */
function fakeTransport(
  routes: Record<string, { status: number; type?: string; body?: string }>,
) {
  const calls: string[] = [];
  const transport = vi.fn<FetchTransport>(async (url, init) => {
    const key = `${init.method} ${url}`;
    calls.push(key);
    const route =
      routes[key] ?? routes[`* ${url}`] ?? (url.endsWith("/robots.txt") ? { status: 404 } : undefined);
    if (!route) {
      return { status: 404, headers: headers({}), text: async () => "" };
    }
    return {
      status: route.status,
      headers: headers(route.type ? { "content-type": route.type } : {}),
      text: async () => {
        calls.push(`BODY ${url}`);
        return route.body ?? "";
      },
    };
  });
  return { transport, calls };
}

const PAGE = "https://vw.com.br/manual";

describe("fetchPage", () => {
  it("reduces an HTML page to text and keeps table rows on their own lines", async () => {
    const { transport } = fakeTransport({
      [`HEAD ${PAGE}`]: { status: 200, type: "text/html; charset=utf-8" },
      [`GET ${PAGE}`]: {
        status: 200,
        type: "text/html",
        body:
          "<html><head><title>Manual Polo</title></head><body>" +
          "<script>ignored()</script>" +
          "<table><tr><td>1.0 TSI</td><td>0W-20</td><td>4,0 L</td></tr>" +
          "<tr><td>1.0 MPI</td><td>5W-30</td><td>3,4 L</td></tr></table>" +
          "</body></html>",
      },
    });

    const out = await fetchPage(PAGE, { transport });

    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("expected ok");
    expect(out.page.title).toBe("Manual Polo");
    expect(out.page.text).toContain("1.0 TSI | 0W-20 | 4,0 L");
    expect(out.page.text).toContain("1.0 MPI | 5W-30 | 3,4 L");
    expect(out.page.text).not.toContain("ignored()");
    expect(out.page.truncated).toBe(false);
  });

  it("refuses a PDF from its headers without ever reading the body", async () => {
    const pdf = "https://vw.com.br/manual-completo";
    const { transport, calls } = fakeTransport({
      [`HEAD ${pdf}`]: { status: 200, type: "application/pdf" },
    });

    const out = await fetchPage(pdf, { transport });

    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("expected refusal");
    expect(out.refusal.kind).toBe("document");
    // The whole point of #77: the manual is *recorded*, never downloaded here.
    expect(calls.some((c) => c.startsWith("BODY"))).toBe(false);
    expect(calls.some((c) => c.startsWith("GET https://vw.com.br/manual-completo"))).toBe(false);
  });

  it("refuses a document by URL extension even when the server calls it HTML", async () => {
    const pdf = "https://vw.com.br/files/manual.pdf";
    const { transport } = fakeTransport({
      [`HEAD ${pdf}`]: { status: 200, type: "text/html" },
    });

    const out = await fetchPage(pdf, { transport });

    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("expected refusal");
    expect(out.refusal.kind).toBe("document");
  });

  it("refuses a non-HTML, non-document type", async () => {
    const api = "https://vw.com.br/api/spec";
    const { transport } = fakeTransport({
      [`HEAD ${api}`]: { status: 200, type: "application/json" },
    });

    const out = await fetchPage(api, { transport });

    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("expected refusal");
    expect(out.refusal.kind).toBe("not_html");
  });

  it("honours a robots.txt disallow and never requests the page", async () => {
    const { transport, calls } = fakeTransport({
      "GET https://vw.com.br/robots.txt": {
        status: 200,
        type: "text/plain",
        body: "User-agent: *\nDisallow: /manual\n",
      },
    });

    const out = await fetchPage(PAGE, { transport });

    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("expected refusal");
    expect(out.refusal.kind).toBe("robots");
    expect(calls.some((c) => c === `HEAD ${PAGE}` || c === `GET ${PAGE}`)).toBe(false);
  });

  it("proceeds when robots.txt allows the path", async () => {
    const { transport } = fakeTransport({
      "GET https://vw.com.br/robots.txt": {
        status: 200,
        type: "text/plain",
        body: "User-agent: *\nDisallow: /admin\n",
      },
      [`HEAD ${PAGE}`]: { status: 200, type: "text/html" },
      [`GET ${PAGE}`]: { status: 200, type: "text/html", body: "<p>0W-20, 4,0 L</p>" },
    });

    const out = await fetchPage(PAGE, { transport });

    expect(out.ok).toBe(true);
  });

  it("truncates at the cap and says so", async () => {
    const { transport } = fakeTransport({
      [`HEAD ${PAGE}`]: { status: 200, type: "text/html" },
      [`GET ${PAGE}`]: { status: 200, type: "text/html", body: `<p>${"a".repeat(50_000)}</p>` },
    });

    const out = await fetchPage(PAGE, { transport, cap: 100 });

    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("expected ok");
    expect(out.page.text).toHaveLength(100);
    expect(out.page.truncated).toBe(true);
  });

  it("turns a thrown transport into a refusal, not an exception", async () => {
    const transport = vi.fn<FetchTransport>(async () => {
      throw new Error("ECONNRESET");
    });

    const out = await fetchPage(PAGE, { transport });

    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("expected refusal");
    expect(out.refusal.kind).toBe("network");
  });

  it("refuses a non-2xx page", async () => {
    const { transport } = fakeTransport({
      [`HEAD ${PAGE}`]: { status: 200, type: "text/html" },
      [`GET ${PAGE}`]: { status: 404, type: "text/html" },
    });

    const out = await fetchPage(PAGE, { transport });

    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("expected refusal");
    expect(out.refusal.kind).toBe("status");
  });
});

describe("helpers", () => {
  it("detects documents by type and by extension", () => {
    expect(isDocument("application/pdf", "https://x.test/a")).toBe(true);
    expect(isDocument("text/html", "https://x.test/manual.pdf?v=2")).toBe(true);
    expect(isDocument("text/html", "https://x.test/page")).toBe(false);
  });

  it("decodes entities and drops blank lines", () => {
    expect(htmlToText("<p>4,0&nbsp;L</p><p></p><p>0W&#45;20</p>")).toBe("4,0 L\n0W-20");
  });

  it("returns null when there is no title", () => {
    expect(htmlTitle("<html><body>x</body></html>")).toBeNull();
  });

  it("ships a cap that is a real bound", () => {
    expect(PAGE_TEXT_CAP).toBeGreaterThan(1000);
  });
});

/**
 * Test design (testing-strategy)
 *
 * SUT: htmlToText's entity/tag ordering and extractDocumentLinks
 * (apps/api/src/oil-quote/page-fetcher.ts). Both pure; no transport.
 *
 * Oracle: specs/quotes/oil-spec-web-search/spec.md "Fetched text SHALL be capped … the passage
 * handed to the extractor SHALL be the part of the page about the resolved vehicle" (markup
 * is not part of any passage), and the manual-candidate requirement — a document the adapter
 * finds is recorded rather than opened, whether the search named it or a page linked it.
 *
 * Both behaviours came from measurement, not speculation: servicos.fiat.com.br handed the
 * extractor literal <span> tags, and vw.com.br's manuals page carries 264 PDF links that
 * reduction was destroying.
 *
 * Axes — htmlToText
 *   T1 markup form — real tags / HTML-escaped tags / entities that are not markup
 *
 * Axes — extractDocumentLinks
 *   L1 link origin — same as the page / a different host
 *   L2 link form — absolute / root-relative / path-relative / inside escaped JSON / malformed
 *   L3 target — document extension / ordinary page / no extension
 *   L4 count vs DOCUMENT_LINK_CAP — under / over
 *   L5 relevantTo — empty / words matching some links / words shorter than 3 chars
 *   L6 page URL — parses / does not
 *
 * Outputs
 *   O1 the reduced text            O2 the harvested URL list, absolute and de-duplicated
 *   O3 ordering within the cap
 *
 * Sampled cells (one row per `it`)
 *   escaped markup            | T1    | O1 no "<span" survives | fails if entities are
 *      decoded after the only strip, which is the bug that shipped
 *   non-markup entities       | T1    | O1 still decoded | fails if the fix strips them
 *   same vs cross origin      | L1    | O2 keeps the same-origin PDF, drops the other |
 *      fails if a document from an unclassified publisher inherits this page's tier
 *   three href forms          | L2    | O2 all resolved absolute against the page URL
 *   escaped JSON href         | L2    | O2 found | fails on a page that ships links escaped
 *   non-document links        | L3    | O2 excluded — an .html link is not a candidate
 *   over the cap              | L4    | O2 exactly DOCUMENT_LINK_CAP
 *   relevance ordering        | L5,L4 | O3 the model-year match survives the cap
 *   short relevance words     | L5    | O2 a 2-char word matches nothing (it would match
 *      almost every path); fails if the length guard is dropped
 *   unparseable page URL      | L6    | O2 empty rather than a throw
 *   malformed href            | L2    | O2 the good link still comes back
 *
 * Decision map of extractDocumentLinks
 *   try new URL(pageUrl)          ok: every other test          throws: unparseable page URL
 *   !DOCUMENT_EXTENSIONS.test     true: non-document links      false: every accepting test
 *   whitespace in the href        true: malformed href test     false: every accepting test
 *   try new URL(raw, pageUrl)     ok: every test. The catch is ONE-SIDED and stays that way:
 *      `new URL(x, base)` treats anything it cannot parse as a relative path instead of
 *      throwing, so no input reaches it. The whitespace guard above is the real rejection —
 *      this test found that out by failing, and the guard was added because of it.
 *   origin !== origin || !ext     true: cross-origin test       false: same-origin tests
 *   word.length > 2               true: relevance ordering      false: short-words test
 *   slice(cap)                    over: cap test                under: every other test
 *
 * Out of scope: whether a harvested document is the RIGHT manual for the model year — the
 * ordering is deliberately not matching, and #77 owns that; admission (admit.test.ts); how
 * the adapter records them (web-search.test.ts).
 */
describe("htmlToText and escaped markup", () => {
  it("removes markup that the page had HTML-escaped", () => {
    // Measured on servicos.fiat.com.br: links and spans live escaped inside a JSON blob,
    // so decoding after the strip put real tags back into the extractor's input.
    const html = "<p>&lt;span class=&#34;font-h2&#34;&gt;Mopar Oil&lt;/span&gt; 4,0 L</p>";

    const text = htmlToText(html);

    expect(text).not.toContain("<span");
    expect(text).not.toContain("</span>");
    expect(text).toContain("Mopar Oil");
    expect(text).toContain("4,0 L");
  });

  it("still decodes entities that are not markup", () => {
    expect(htmlToText("<p>4,0&nbsp;L &amp; 0W&#45;20</p>")).toBe("4,0 L & 0W-20");
  });
});

describe("extractDocumentLinks", () => {
  const PAGE_URL = "https://www.vw.com.br/pt/manuais.html";

  it("keeps a same-origin document and drops one from another host", () => {
    // Same-origin is the whole safety rule: only then is the document demonstrably from
    // the publisher whose page the model classified.
    const html =
      '<a href="/dam/manual-polo-2021.pdf">Polo</a>' +
      '<a href="https://cdn.example.test/manual-polo-2021.pdf">mirror</a>';

    const links = extractDocumentLinks(html, PAGE_URL);

    expect(links).toEqual([{ url: "https://www.vw.com.br/dam/manual-polo-2021.pdf", label: "Polo" }]);
  });

  it("resolves absolute, root-relative and path-relative hrefs alike", () => {
    const html =
      '<a href="https://www.vw.com.br/a/one.pdf">1</a>' +
      '<a href="/b/two.pdf">2</a>' +
      '<a href="three.pdf">3</a>';

    const links = extractDocumentLinks(html, PAGE_URL).map((link) => link.url);

    expect(new Set(links)).toEqual(
      new Set([
        "https://www.vw.com.br/a/one.pdf",
        "https://www.vw.com.br/b/two.pdf",
        "https://www.vw.com.br/pt/three.pdf",
      ]),
    );
  });

  it("finds a link that the page ships HTML-escaped", () => {
    const html = '<script>{"cta":"&lt;a href=&#34;/dam/manual.pdf&#34;&gt;"}</script>';

    const links = extractDocumentLinks(html, PAGE_URL).map((link) => link.url);

    expect(links).toEqual(["https://www.vw.com.br/dam/manual.pdf"]);
  });

  it("ignores links that are not documents", () => {
    const html = '<a href="/pt/outra.html">page</a><a href="/pt/sem-extensao">page</a>';

    expect(extractDocumentLinks(html, PAGE_URL)).toEqual([]);
  });

  it("reads past the recording cap: choosing which to record is the caller's (D8)", () => {
    const html = Array.from(
      { length: DOCUMENT_LINK_CAP + 7 },
      (_unused, index) => `<a href="/d/${index}.pdf">x</a>`,
    ).join("");

    expect(extractDocumentLinks(html, PAGE_URL)).toHaveLength(DOCUMENT_LINK_CAP + 7);
  });

  it("stops at the scan limit", () => {
    const html = Array.from(
      { length: DOCUMENT_LINK_SCAN_LIMIT + 5 },
      (_unused, index) => `<a href="/d/${index}.pdf">x</a>`,
    ).join("");

    expect(extractDocumentLinks(html, PAGE_URL)).toHaveLength(DOCUMENT_LINK_SCAN_LIMIT);
  });

  it("lets the vehicle's own words survive the cap ahead of other models", () => {
    // Ordering only — this is NOT picking the right manual, which is #77's problem. It
    // decides which links are worth carrying when there are more than the cap allows.
    const others = Array.from(
      { length: DOCUMENT_LINK_CAP },
      (_unused, index) => `<a href="/d/tiguan-${index}.pdf">x</a>`,
    ).join("");
    const html = `${others}<a href="/d/polo-2021-manual.pdf">polo</a>`;

    const links = extractDocumentLinks(html, PAGE_URL, ["Polo", "2021"]);

    expect(links[0]?.url).toBe("https://www.vw.com.br/d/polo-2021-manual.pdf");
  });

  it("ignores relevance words too short to mean anything", () => {
    // A 2-character word would match a large share of any manufacturer's file names, so
    // it must not reorder anything.
    const html = '<a href="/d/gt-manual.pdf">a</a><a href="/d/outro.pdf">b</a>';

    const links = extractDocumentLinks(html, PAGE_URL, ["GT"]).map((link) => link.url);

    expect(new Set(links)).toEqual(
      new Set(["https://www.vw.com.br/d/gt-manual.pdf", "https://www.vw.com.br/d/outro.pdf"]),
    );
  });

  it("returns nothing rather than throwing when the page URL does not parse", () => {
    expect(extractDocumentLinks('<a href="/a.pdf">x</a>', "not a url")).toEqual([]);
  });

  it("skips a malformed href instead of failing the whole page", () => {
    const html = '<a href="ht tp://bad^^/x.pdf">bad</a><a href="/good.pdf">good</a>';

    expect(extractDocumentLinks(html, PAGE_URL)).toEqual([{ url: "https://www.vw.com.br/good.pdf", label: "good" }]);
  });

  // oil-quote-retrieval-hardening 5.1: labels.
  it("takes an anchor's text as the label, and its title when the text is empty", () => {
    const html =
      '<a href="/d/polo.pdf"><span>Manual Novo Polo</span> 2021</a>' +
      '<a href="/d/virtus.pdf" title="Manual Virtus 2022"><img src="/i.png"></a>';

    expect(extractDocumentLinks(html, PAGE_URL)).toEqual([
      { url: "https://www.vw.com.br/d/polo.pdf", label: "Manual Novo Polo 2021" },
      { url: "https://www.vw.com.br/d/virtus.pdf", label: "Manual Virtus 2022" },
    ]);
  });

  it("reads a JSON-shipped link and the label beside it, in the VW shape", () => {
    const html =
      '<script>{"items":[{"documentPath":"\\/dam\\/Polo_MY 2021_21B.pdf","linkLabel":"Manual Novo Polo 2021"},' +
      '{"documentPath":"/dam/tiguan.pdf","linkLabel":"Manual Tiguan 2020"}]}</script>';

    const links = extractDocumentLinks(html, PAGE_URL);

    expect(links).toContainEqual({ url: "https://www.vw.com.br/dam/Polo_MY%202021_21B.pdf", label: "Manual Novo Polo 2021" });
    expect(links).toContainEqual({ url: "https://www.vw.com.br/dam/tiguan.pdf", label: "Manual Tiguan 2020" });
  });

  it("gives a link with no label a null label, and orders labelled links first", () => {
    const html = '<img src="/d/bare.pdf"><a href="/d/named.pdf">Manual</a>';

    expect(extractDocumentLinks(html, PAGE_URL)).toEqual([
      { url: "https://www.vw.com.br/d/named.pdf", label: "Manual" },
      { url: "https://www.vw.com.br/d/bare.pdf", label: null },
    ]);
  });

  it("still drops a cross-origin JSON link", () => {
    const html = '{"documentPath":"https://cdn.example.test/polo.pdf","linkLabel":"Manual Polo"}';

    expect(extractDocumentLinks(html, PAGE_URL)).toEqual([]);
  });
});

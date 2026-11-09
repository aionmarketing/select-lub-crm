/**
 * Fetches an admitted page and reduces it to text (web-search-source-adapter D4).
 *
 * This is the only component that reaches the open web, so it is written as a series of
 * refusals rather than a download:
 *
 * - `robots.txt` is consulted before the page and a disallow is honoured;
 * - credentials are never sent and a redirect is followed only within the same host, for at
 *   most {@link MAX_REDIRECT_HOPS} hops, each one re-checked by the SSRF guard and the
 *   blocklist (oil-research-web-retrieval D1);
 * - the content type is checked from the HEADERS, and anything that is not HTML is refused
 *   before the body is read — a PDF must not arrive as bytes we then have to discard, and
 *   it is a *manual candidate* for GitHub #77, not a failure;
 * - the body is capped, so a 40 MB page cannot become 40 MB of prompt;
 * - the URL came from a search result, so it is untrusted: only public https is fetched, and
 *   the default transport is the SSRF guard (`../net/guarded-http.ts`), which checks every
 *   address it dials and every redirect hop (review of #180, 2026-09-25).
 *
 * Everything is injected (`transport`, `now`) so tests exercise every refusal without a
 * socket, per D9.
 */
import { assertAllowedUrl, BlockedUrlError, createGuardedHttp, type GuardedHttp } from "../net/guarded-http.js";
import { MAX_REDIRECT_HOPS, requestFollowing } from "./redirects.js";

/** What a transport must provide; `fetch` satisfies it, and tests pass a fake. */
export type FetchTransport = (
  url: string,
  init: { method: "GET" | "HEAD"; signal: AbortSignal; redirect: "manual" | "follow" },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

/** Why a page was not turned into text. `document` is the #77 case, not an error. */
export type FetchRefusal =
  | { kind: "blocked"; message: string }
  | { kind: "robots" }
  /** `url` is the one that answered, after any redirect: the document a candidate is recorded for. */
  | { kind: "document"; contentType: string; url: string }
  /** A redirect that was not followed (D1): off-host, blocked, too long or without a `Location`. Definite. */
  | { kind: "redirect"; message: string }
  | { kind: "status"; status: number }
  | { kind: "not_html"; contentType: string }
  | { kind: "network"; message: string };

/** A page reduced to capped plain text. */
export type FetchedPage = {
  url: string;
  title: string | null;
  text: string;
  /** True when the cap cut the page short, so the log can say so. */
  truncated: boolean;
  /**
   * Same-origin documents linked from this page, absolute and de-duplicated, each with the
   * label the page gives it when it gives one.
   *
   * A manufacturer's "manuals" page is a gateway: its prose says nothing about oil, and its
   * links are the entire point. vw.com.br's carries 264 PDFs including the exact Polo MY2021
   * manual the search model found on its own. Reducing the page to text destroyed all of
   * them, so they are collected from the raw HTML first. Which of them are recorded is the
   * caller's choice (`document-links.ts`), not this page's.
   */
  documentLinks: DocumentLink[];
};

export type FetchOutcome =
  | { ok: true; page: FetchedPage }
  | { ok: false; refusal: FetchRefusal };

/** Characters of text handed on. Beyond this a page is prompt bloat, not evidence. */
export const PAGE_TEXT_CAP = 20_000;

/** Milliseconds one page fetch may take, including its robots check. */
export const PAGE_FETCH_TIMEOUT_MS = 8_000;

/** Bytes of a page's body read at most; the text cap applies after. */
export const PAGE_BYTE_CAP = 4 * 1024 * 1024;

/**
 * A {@link FetchTransport} over the SSRF guard: public https only, every dialled address and
 * every redirect hop checked, the body cut at `maxBytes`.
 *
 * @param http - The guarded client; defaults to a real one.
 * @param maxBytes - Body cap for a GET; defaults to {@link PAGE_BYTE_CAP}.
 */
export function guardedTransport(http: GuardedHttp = createGuardedHttp(), maxBytes = PAGE_BYTE_CAP): FetchTransport {
  return (url, init) => http(url, { method: init.method, signal: init.signal, redirect: init.redirect, maxBytes });
}

/** Content types that are documents for #77 rather than pages we can read today. */
const DOCUMENT_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats",
  "application/vnd.ms-excel",
  "application/epub",
  "application/zip",
  "application/octet-stream",
];

/** Extensions that betray a document even when the server mislabels the type. */
const DOCUMENT_EXTENSIONS = /\.(pdf|docx?|xlsx?|epub|zip)(?:$|[?#])/i;

/**
 * Whether a content type (or the URL itself) says this is a document, not a web page.
 *
 * @param contentType - The `content-type` header, lowercased or not.
 * @param url - The URL, checked for a document extension when the header is vague.
 */
export function isDocument(contentType: string, url: string): boolean {
  const type = contentType.toLowerCase();
  if (DOCUMENT_TYPES.some((doc) => type.startsWith(doc))) {
    return true;
  }
  return DOCUMENT_EXTENSIONS.test(url);
}

/**
 * Reduces an HTML document to plain text, keeping the shape that matters for a spec table.
 *
 * Script, style, nav and footer content is dropped whole. Each table row becomes one line
 * with cells separated by ` | ` — a capacities table read as a wall of words is far harder
 * for the extractor to attribute to the right engine.
 *
 * @param html - Raw HTML.
 * @returns Plain text, entities decoded, blank lines collapsed.
 */
export function htmlToText(html: string): string {
  let s = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<(nav|footer|header|aside)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");

  s = s
    .replace(/<\/t[dh]>\s*<t[dh][^>]*>/gi, " | ")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|table)>/gi, "\n");

  s = s.replace(/<[^>]+>/g, " ");

  s = decodeEntities(s);

  // Strip a SECOND time. A page that carries HTML escaped inside a JSON blob or a data
  // attribute (`href=&#34;…&#34;`) turns back into real markup the moment the entities are
  // decoded, and the first pass has already gone. Measured on servicos.fiat.com.br, whose
  // extractor input came back full of literal <span class="font-h2"> tags.
  s = s.replace(/<[^>]+>/g, " ");

  return s
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line) => line !== "")
    .join("\n");
}

/** Most document links a gateway page may contribute; beyond this it is a library, not a lead. */
export const DOCUMENT_LINK_CAP = 25;

/** Links read off one page at most, before any choosing. Bounds the selector's prompt. */
export const DOCUMENT_LINK_SCAN_LIMIT = 300;

/** A same-origin document a page links, with the label the page gives it (or null). */
export type DocumentLink = { url: string; label: string | null };

/** Keys a JSON-shipped link carries its document path under. */
const JSON_LINK_KEYS = /"(?:documentPath|href|url|path|link|file)"\s*:\s*"([^"]+)"/gi;

/** Keys a JSON-shipped link carries its label under, in the same object. */
const JSON_LABEL_KEYS = /"(?:linkLabel|linkTitle|title|label)"\s*:\s*"([^"]*)"/i;

/** Whitespace-collapsed label text, or null when there is none worth keeping. */
function cleanLabel(raw: string | null | undefined): string | null {
  const text = decodeEntities((raw ?? "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
  return text === "" ? null : text.slice(0, 200);
}

/** The `{…}` around `index`: the JSON object a link key sits in, for its sibling label. */
function enclosingObject(text: string, index: number): string {
  const start = text.lastIndexOf("{", index);
  const end = text.indexOf("}", index);
  return start === -1 || end === -1 ? "" : text.slice(start, end + 1);
}

/**
 * Collects the same-origin documents a page links, with their labels.
 *
 * Same-origin is the whole safety rule. A PDF served from the domain of a page the searching
 * model classified is that publisher's own document; a PDF linked OFF to somewhere else is an
 * unclassified page from an unknown publisher, and the caller has no basis to give it a tier.
 * Cross-origin links are dropped rather than guessed at.
 *
 * The label is what a person reads for the link: an anchor's text (or its `title` /
 * `aria-label`), or — where a page ships its links as JSON, as vw.com.br does — a
 * `linkLabel` / `linkTitle` / `title` / `label` sibling of the document path in the same
 * object. A filename says little (Honda's `AT7A2121OM.PDF`); "Manual Novo Polo 2021" says
 * what the document is (oil-quote-retrieval-hardening D8).
 *
 * Ordered labelled first, then by how many of `relevantTo`'s words the path and label
 * mention. That is only an order, for the fallback when no selector chooses: picking the
 * right manual for a model year is GitHub #77's problem, and this cannot do it.
 *
 * @param html - Raw HTML, before any reduction.
 * @param pageUrl - The page's own URL, for resolving relative links and fixing the origin.
 * @param relevantTo - Words from the vehicle identity used only to order the results.
 * @returns De-duplicated documents, at most {@link DOCUMENT_LINK_SCAN_LIMIT}.
 */
export function extractDocumentLinks(
  html: string,
  pageUrl: string,
  relevantTo: readonly string[] = [],
): DocumentLink[] {
  let origin: string;
  try {
    origin = new URL(pageUrl).origin;
  } catch {
    return [];
  }

  // Decode first: a page may carry its links HTML-escaped inside a JSON blob.
  const source = `${html}
${decodeEntities(html)}`;
  const found = new Map<string, string | null>();
  const consider = (candidate: string, label: string | null) => {
    // JSON escapes its slashes; an HTML attribute never needs to.
    const raw = candidate.replace(/\\\//g, "/");
    // Whitespace is the tell for markup that is broken or was never a URL. `new URL` with a
    // base almost never throws — it treats the garbage as a RELATIVE path and hands back a
    // confident same-origin URL — so this guard, not the catch below, is what rejects it.
    if (/\s/.test(raw) || !DOCUMENT_EXTENSIONS.test(raw)) {
      return;
    }
    let absolute: URL;
    try {
      absolute = new URL(raw, pageUrl);
    } catch {
      return;
    }
    // Re-check on the RESOLVED path: the extension has to survive resolution, not merely
    // appear somewhere in the raw attribute.
    if (absolute.origin !== origin || !DOCUMENT_EXTENSIONS.test(absolute.pathname)) {
      return;
    }
    const key = absolute.toString();
    if (!found.has(key) || (found.get(key) === null && label !== null)) {
      found.set(key, label);
    }
  };

  for (const match of source.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = match[1]!;
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
    if (href) {
      const titled = /\b(?:title|aria-label)\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
      consider(href, cleanLabel(match[2]) ?? cleanLabel(titled));
    }
  }
  for (const match of source.matchAll(/(?:href|src|data-href)\s*=\s*["']([^"']+)["']/gi)) {
    consider(match[1]!, null);
  }
  for (const match of source.matchAll(JSON_LINK_KEYS)) {
    // A JSON string may hold a plain space (vw.com.br's "Polo_MY 2021_21B…pdf"); an HTML
    // attribute value is the one place a space means broken markup, so only there does the
    // whitespace guard in `consider` apply unescaped.
    const path = match[1]!.replace(/ /g, "%20");
    consider(path, cleanLabel(JSON_LABEL_KEYS.exec(enclosingObject(source, match.index))?.[1]));
  }

  const words = relevantTo.map((word) => word.toLowerCase()).filter((word) => word.length > 2);
  const scored = [...found].map(([url, label]) => {
    let path = url;
    try {
      path = decodeURIComponent(url);
    } catch {
      // A malformed escape: score the raw URL instead.
    }
    const text = `${path} ${label ?? ""}`.toLowerCase();
    return { url, label, hits: words.filter((word) => text.includes(word)).length };
  });
  scored.sort((a, b) => Number(b.label !== null) - Number(a.label !== null) || b.hits - a.hits);
  return scored.slice(0, DOCUMENT_LINK_SCAN_LIMIT).map(({ url, label }) => ({ url, label }));
}

/** Decodes the handful of HTML entities that matter for reading a spec table. */
function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code: string) => String.fromCharCode(parseInt(code, 16)));
}

/** Pulls `<title>` out of raw HTML, for the citation's page label. */
export function htmlTitle(html: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = match?.[1]?.replace(/\s+/g, " ").trim();
  return title ? title : null;
}

/**
 * Whether `robots.txt` allows this path for `*`.
 *
 * Deliberately conservative and simple: it reads the `User-agent: *` group and honours its
 * `Disallow` prefixes. A robots.txt that cannot be fetched is treated as permissive (that is
 * what its absence means), but one that disallows is obeyed.
 *
 * @param url - The page being considered.
 * @param transport - Injected transport.
 * @param signal - Shared timeout signal.
 */
export async function robotsAllows(
  url: string,
  transport: FetchTransport,
  signal: AbortSignal,
): Promise<boolean> {
  let robotsUrl: string;
  let path: string;
  try {
    const parsed = new URL(url);
    robotsUrl = `${parsed.origin}/robots.txt`;
    path = parsed.pathname;
  } catch {
    return false;
  }

  try {
    const res = await transport(robotsUrl, { method: "GET", signal, redirect: "follow" });
    if (res.status !== 200) {
      return true;
    }
    const body = await res.text();
    let inStar = false;
    for (const raw of body.split("\n")) {
      const line = raw.split("#")[0]!.trim();
      const [field, ...rest] = line.split(":");
      const key = field?.toLowerCase().trim();
      const value = rest.join(":").trim();
      if (key === "user-agent") {
        inStar = value === "*";
      } else if (inStar && key === "disallow" && value !== "") {
        if (path.startsWith(value)) {
          return false;
        }
      }
    }
    return true;
  } catch {
    // A robots.txt we could not reach is not a prohibition.
    return true;
  }
}

/**
 * Fetches one admitted page and reduces it to capped text.
 *
 * @param url - An already-admitted URL (the blocklist and classification gate ran before).
 * @param opts.transport - Injected transport; defaults to {@link guardedTransport}.
 * @param opts.cap - Text cap; defaults to {@link PAGE_TEXT_CAP}.
 * @param opts.timeoutMs - Per-page timeout; defaults to {@link PAGE_FETCH_TIMEOUT_MS}.
 * @returns The page as text, or the refusal that stopped it. Never throws.
 */
export async function fetchPage(
  url: string,
  opts: {
    transport?: FetchTransport;
    cap?: number;
    timeoutMs?: number;
    /** Words from the vehicle identity; only orders the harvested document links. */
    relevantTo?: readonly string[];
  } = {},
): Promise<FetchOutcome> {
  const transport = opts.transport ?? guardedTransport();
  const cap = opts.cap ?? PAGE_TEXT_CAP;
  const controller = AbortSignal.timeout(opts.timeoutMs ?? PAGE_FETCH_TIMEOUT_MS);

  try {
    // Checked here too, not only in the default transport, so an injected one cannot skip it.
    assertAllowedUrl(url);
    if (!(await robotsAllows(url, transport, controller))) {
      return { ok: false, refusal: { kind: "robots" } };
    }

    // HEAD first so a document is refused from its headers, before any body is read.
    const hops = { left: MAX_REDIRECT_HOPS };
    const allowed = (target: string) => robotsAllows(target, transport, controller);
    const headed = await requestFollowing(url, "HEAD", transport, controller, hops, allowed);
    if ("refusal" in headed) {
      return { ok: false, refusal: headed.refusal };
    }
    const head = headed.reply;
    // The URL that answered: what is cited, what the type is judged by, what links resolve against.
    let finalUrl = headed.url;
    const headType = head.headers.get("content-type") ?? "";
    if (head.status >= 200 && head.status < 300) {
      if (isDocument(headType, finalUrl)) {
        return { ok: false, refusal: { kind: "document", contentType: headType || "unknown", url: finalUrl } };
      }
      if (headType !== "" && !headType.toLowerCase().includes("html")) {
        return { ok: false, refusal: { kind: "not_html", contentType: headType } };
      }
    }

    const got = await requestFollowing(finalUrl, "GET", transport, controller, hops, allowed);
    if ("refusal" in got) {
      return { ok: false, refusal: got.refusal };
    }
    const res = got.reply;
    finalUrl = got.url;
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, refusal: { kind: "status", status: res.status } };
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (isDocument(contentType, finalUrl)) {
      return { ok: false, refusal: { kind: "document", contentType: contentType || "unknown", url: finalUrl } };
    }
    if (!contentType.toLowerCase().includes("html")) {
      return { ok: false, refusal: { kind: "not_html", contentType: contentType || "unknown" } };
    }

    const html = await res.text();
    const text = htmlToText(html);
    return {
      ok: true,
      page: {
        url: finalUrl,
        title: htmlTitle(html),
        text: text.slice(0, cap),
        truncated: text.length > cap,
        // Harvested from the RAW html: reduction strips every tag, and on a gateway page
        // the links are the only part worth having.
        documentLinks: extractDocumentLinks(html, finalUrl, opts.relevantTo ?? []),
      },
    };
  } catch (err) {
    if (err instanceof BlockedUrlError) {
      return { ok: false, refusal: { kind: "blocked", message: err.message } };
    }
    return { ok: false, refusal: { kind: "network", message: String(err).slice(0, 200) } };
  }
}

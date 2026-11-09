/**
 * Domains that can never be an oil-spec source (web-search-source-adapter D3).
 *
 * This is the hard floor under the searching model's judgement. The model decides *what kind
 * of document* a page is, and that decides its tier — but no classification lets a forum
 * thread or a marketplace listing through, because `prompt.md` names those as
 * non-authoritative outright. A page still has to be classified into one of the five
 * document classes to be accepted; this list only ever subtracts.
 *
 * `db:seed` and the API both read it; it opens no network.
 */
import { createRequire } from "node:module";

/** One blocked domain pattern and why it is blocked, for the rejection log. */
export type BlockedDomain = {
  /** Registrable domain, optionally with a `*` wildcard label, e.g. `*.blogspot.com`. */
  pattern: string;
  /** Short reason shown in the log when this pattern rejects a candidate. */
  reason: string;
};

const require = createRequire(import.meta.url);

/**
 * Reads the committed blocklist.
 *
 * @returns Every blocked pattern with its reason.
 */
export function oilSourceBlocklist(): BlockedDomain[] {
  const file = require("../../../fixtures/oil-source-blocklist.json") as {
    patterns: BlockedDomain[];
  };
  return file.patterns;
}

/**
 * Reduces a URL to the host used for matching, lowercased and without a leading `www.`.
 *
 * @param url - Candidate URL.
 * @returns The host, or `null` when the URL cannot be parsed.
 */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * Whether a pattern matches a host, on the registrable domain plus any subdomain.
 *
 * `example.com` matches `example.com` and `parts.example.com` but never `notexample.com` —
 * the boundary is a label, not a substring, so a blocked name cannot be evaded by prefixing
 * it and an innocent domain that merely ends in the same letters is not caught by accident.
 * A `*` in the pattern matches within one label only.
 *
 * @param host - Host from {@link hostOf}.
 * @param pattern - A {@link BlockedDomain} pattern.
 */
export function matchesDomain(host: string, pattern: string): boolean {
  const normalized = pattern.toLowerCase().replace(/^www\./, "");
  const escaped = normalized
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^.]*");
  // Either the host IS the pattern, or it is a subdomain of it.
  return new RegExp(`^(?:.+\\.)?${escaped}$`).test(host);
}

/**
 * Finds the blocklist entry that rejects a URL.
 *
 * @param url - Candidate URL.
 * @param blocklist - Committed patterns; defaults to the shipped list.
 * @returns The matching entry, or `null` when nothing blocks it. An unparseable URL is
 * treated as blocked, since a source we cannot address is not a source.
 */
export function findBlock(
  url: string,
  blocklist: BlockedDomain[] = oilSourceBlocklist(),
): BlockedDomain | null {
  const host = hostOf(url);
  if (host == null) {
    return { pattern: url, reason: "unparseable URL" };
  }
  return blocklist.find((entry) => matchesDomain(host, entry.pattern)) ?? null;
}

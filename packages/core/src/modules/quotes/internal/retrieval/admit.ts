/**
 * The one gate every web candidate passes before anything is fetched
 * (web-search-source-adapter D3).
 *
 * Order matters and is deliberate: the blocklist is checked FIRST, so no classification the
 * model produces can talk a forum thread past it. Only then is the class turned into a tier.
 * A candidate the model could not place (`other`), or gave no class at all, is rejected —
 * there is no default tier, because a default is exactly how a content farm ends up ranked
 * beside a manufacturer.
 */
import { findBlock, tierForClassification, type BlockedDomain } from "@select-lub/core/db";
import type { SourceClassification } from "../../../../shared/web/source-classification.js";

/** One result as the searching model reported it. */
export type SearchCandidate = {
  url: string;
  /** One of the five classes, or `other`. Anything else is treated as no class. */
  classification?: string;
  /** The model's one-line justification, kept for the log and for human review. */
  reason?: string;
  /** Page title, when the search returned one; used as the citation's `page`. */
  title?: string;
};

/** A candidate that may be fetched, with the tier its class earned. */
export type AdmittedCandidate = {
  url: string;
  tier: 1 | 2 | 3 | 4 | 5;
  classification: SourceClassification;
  reason: string;
  title: string | null;
};

/** Why a candidate will not be fetched. */
export type RejectedCandidate = {
  url: string;
  rejection: string;
};

/** The gate's verdict. */
export type AdmissionResult =
  | ({ admitted: true } & AdmittedCandidate)
  | ({ admitted: false } & RejectedCandidate);

/** An index file a server answers for its own root: `/index.html`, `/default.aspx`. */
const INDEX_FILE = /^\/(?:index|default)\.(?:html?|php|aspx?)$/i;

/**
 * Whether a URL is a site's front page: an empty path, `/`, or only an index file. A query
 * string or fragment does not make it a deeper page.
 *
 * @param url - A search result's URL.
 * @returns False for a URL that does not parse; the blocklist check already rejects those.
 */
export function isSiteRoot(url: string): boolean {
  try {
    const path = new URL(url).pathname.replace(/\/+$/, "");
    return path === "" || INDEX_FILE.test(path);
  } catch {
    return false;
  }
}

/**
 * Decides whether one search result may become a source, and at what tier.
 *
 * @param candidate - The result as the model reported it.
 * @param blocklist - Committed patterns; defaults to the shipped list.
 * @returns An admission carrying the derived tier, or a rejection carrying the reason.
 * Never throws, and never returns a tier the model supplied — any `tier` field on the
 * candidate is ignored by construction, since this function does not read one.
 */
export function admitCandidate(
  candidate: SearchCandidate,
  blocklist?: BlockedDomain[],
): AdmissionResult {
  const url = candidate.url?.trim() ?? "";
  if (url === "") {
    return { admitted: false, url, rejection: "no URL" };
  }

  // Blocklist first: a classification must never be able to override it.
  const block = findBlock(url, blocklist);
  if (block) {
    return { admitted: false, url, rejection: `blocked (${block.reason})` };
  }

  // A site's front page states no vehicle's oil specification, whatever the model calls it
  // (oil-research-web-retrieval D2): rejecting it here spends no attempt, no read, no model call.
  if (isSiteRoot(url)) {
    return { admitted: false, url, rejection: "site root" };
  }

  const tier = tierForClassification(candidate.classification);
  if (tier == null) {
    const said = candidate.classification ?? "none";
    return { admitted: false, url, rejection: `not a usable document class (${said})` };
  }

  return {
    admitted: true,
    url,
    tier,
    classification: candidate.classification as SourceClassification,
    reason: candidate.reason?.trim() || "no reason given",
    title: candidate.title?.trim() || null,
  };
}

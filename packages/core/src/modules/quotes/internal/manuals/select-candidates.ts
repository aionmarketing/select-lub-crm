/**
 * Which recorded manual candidates an identity queues for reading (ingest-harvested-manuals D1).
 *
 * Deterministic, not a model: the label judgement already happened once, when the gateway
 * page's links were chosen, and repeating it would spend tokens to re-decide the same thing.
 *
 * - Only a manufacturer manual or manufacturer technical information (tier 1–2) qualifies.
 * - It must name the vehicle's model. When the candidate has a label, the LABEL decides; the
 *   URL decides only for an unlabelled one. Q5 found "Manual Voyage 2015" served from
 *   `.../manual-gol/...`, and it is not a Gol manual.
 * - Ranking: a year match; then the workshop country's manufacturer domain (`.com.br`) before a
 *   foreign one of the same tier; then labelled before unlabelled; then the recorded order.
 * - At most `limit` per identity, each URL once.
 */
import { concernsModel, decodedUrl, hasWord } from "../model-named.js";

/** A recorded candidate, as the selection reads it. */
export type ManualCandidateRow = {
  url: string;
  label: string | null;
  classification: string;
  tier: number;
  foundAt: Date;
};

/** The identity a manual is chosen for. */
export type ManualIdentity = { make: string; year: number; model: string; version: string };

const QUALIFYING_CLASSES = new Set(["manufacturer_manual", "manufacturer_technical"]);

/** Whether a candidate carries a label; a whitespace-only one is no label. */
function hasLabel(candidate: ManualCandidateRow): candidate is ManualCandidateRow & { label: string } {
  return candidate.label != null && candidate.label.trim() !== "";
}

/** The text that decides a candidate: its label when it has one, otherwise its URL, decoded. */
function decidingText(candidate: ManualCandidateRow): string {
  return hasLabel(candidate) ? candidate.label : decodedUrl(candidate.url);
}

function isHomeDomain(url: string): boolean {
  try {
    return new URL(url).hostname.endsWith(".com.br");
  } catch {
    return false;
  }
}

/**
 * @param candidates - Every candidate recorded for the identity, in any order; duplicates of
 *   one URL (a repeat find) count once, at their earliest record.
 * @param identity - The vehicle.
 * @param limit - How many manuals an identity may queue.
 * @returns The URLs to queue, best first.
 */
export function chooseManuals(candidates: readonly ManualCandidateRow[], identity: ManualIdentity, limit: number): string[] {
  const earliest = new Map<string, ManualCandidateRow>();
  for (const candidate of candidates) {
    const seen = earliest.get(candidate.url);
    if (!seen || candidate.foundAt < seen.foundAt) earliest.set(candidate.url, candidate);
  }
  const year = String(identity.year);
  const qualifying = [...earliest.values()].filter(
    (c) => c.tier <= 2 && QUALIFYING_CLASSES.has(c.classification) && concernsModel(c, identity.model),
  );
  const rank = (c: ManualCandidateRow) => [
    hasWord(decidingText(c), year) ? 0 : 1,
    isHomeDomain(c.url) ? 0 : 1,
    hasLabel(c) ? 0 : 1,
    c.foundAt.getTime(),
  ];
  qualifying.sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < ra.length; i += 1) if (ra[i] !== rb[i]) return ra[i]! - rb[i]!;
    return 0;
  });
  return qualifying.slice(0, limit).map((c) => c.url);
}

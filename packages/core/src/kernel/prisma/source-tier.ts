/**
 * Turns the searching model's document classification into an authority tier
 * (web-search-source-adapter D3).
 *
 * The split matters: the model says *what a page is*, code says *what that is worth*. That
 * keeps `prompt.md`'s "do not treat a model-generated confidence score as evidence" while
 * still letting the model's judgement about the document decide the ranking — its own
 * `authority_level` is a category of publisher, which is exactly what is being asked for.
 *
 * Pure, and deliberately next to the blocklist (formerly in `packages/db`, now `kernel/prisma`) so the seed and the API read
 * one definition.
 */
import type { SourceClassification } from "../../shared/web/source-classification.js";

/**
 * What the searching model may answer. `other` is a real answer — "I cannot place this" —
 * and it is the reason this type is wider than {@link SourceClassification}, which only
 * describes classes a stored source may have.
 */
export type CandidateClassification = SourceClassification | "other";

/**
 * The prompt.md source hierarchy, as a total map from class to tier.
 *
 * 1 manufacturer owner/service manual · 2 manufacturer technical information ·
 * 3 licensed professional automotive-service database · 4 reputable lubricant manufacturer
 * application guide · 5 reputable aftermarket technical catalog.
 */
export const CLASSIFICATION_TIER: Record<SourceClassification, 1 | 2 | 3 | 4 | 5> = {
  manufacturer_manual: 1,
  manufacturer_technical: 2,
  licensed_database: 3,
  lubricant_maker_guide: 4,
  aftermarket_catalog: 5,
};

/**
 * The tier for a classification the model returned.
 *
 * @param classification - What the model said the page is.
 * @returns The tier, or `null` for `other` and for anything not in the closed set — both of
 * which mean the page has no place in the hierarchy and must be rejected rather than ranked.
 */
export function tierForClassification(
  classification: string | null | undefined,
): 1 | 2 | 3 | 4 | 5 | null {
  if (classification == null || classification === "other") {
    return null;
  }
  return CLASSIFICATION_TIER[classification as SourceClassification] ?? null;
}

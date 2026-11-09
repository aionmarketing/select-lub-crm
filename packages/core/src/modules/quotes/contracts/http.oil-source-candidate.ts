/**
 * Zod contracts for the two insert-only ledgers the oil-spec retrieval writes.
 *
 * A *candidate* is a document the search found and deliberately did not read — a PDF the
 * content-type gate refused, or a document linked from a page it did read. A *miss* is the
 * memory that searching for one vehicle found nothing, so the next quote for the same car
 * does not buy the same empty search again.
 *
 * Neither is a spec. A candidate carries no viscosity and no litres, and a miss carries no
 * result at all: they are what the retrieval SAW, kept so a later change can act on it.
 *
 * Moved from `packages/shared-types/src/oil-source-candidate.ts` (5.1d) with declarations unchanged.
 */
import { z } from "zod";
import { sourceClassificationSchema } from "../../../shared/web/source-classification.js";

/** The vehicle identity both ledgers are keyed by — the same four fields the cache uses. */
const identityFields = {
  make: z.string().trim().min(1),
  year: z.number().int(),
  model: z.string().trim().min(1),
  version: z.string().trim().min(1),
};

/**
 * A document the retrieval found and did not open.
 *
 * `discoveredVia` is the field that matters most to a reader: absent, the searching model
 * classified this document itself; present, the document merely inherited the class of the
 * page at that URL. An inherited candidate is a *lead* — whoever opens it must confirm the
 * vehicle and model year from the document, because nothing here did.
 */
export const sourceCandidateSchema = z.object({
  id: z.string(),
  ...identityFields,
  url: z.string().trim().min(1),
  /** Domain serving the document, as shown to a reader. */
  publisher: z.string().trim().min(1),
  classification: sourceClassificationSchema,
  /** Derived from `classification` by the fixed map; never supplied by a model. */
  tier: z.number().int().min(1).max(5),
  /** The accepted page that linked this document. Absent when the search returned it directly. */
  discoveredVia: z.string().nullable().optional(),
  /** The label the linking page gave the document, e.g. "Manual Novo Polo 2021". */
  label: z.string().nullable().optional(),
  /** Why this document survived the per-page cap. */
  selectionReason: z.string().nullable().optional(),
  foundAt: z.string(),
});

/** A candidate as it is written, before the store assigns an id. */
export const sourceCandidateInsertSchema = sourceCandidateSchema.omit({ id: true });

/**
 * A search for one identity that found nothing usable.
 *
 * Deliberately not a cache row: it records an absence, so it must never be offered to the
 * attendant as a previous result, and it never carries a spec to be reused.
 */
export const searchMissSchema = z.object({
  id: z.string(),
  ...identityFields,
  /** Why nothing was usable, for tuning the blocklist and the window. */
  reason: z.string().trim().min(1),
  searchedAt: z.string(),
});

/** A miss as it is written, before the store assigns an id. */
export const searchMissInsertSchema = searchMissSchema.omit({ id: true });

/** A document the retrieval found and deliberately did not read. */
export type SourceCandidateRow = z.infer<typeof sourceCandidateSchema>;

/** A candidate before the store assigns an id. */
export type SourceCandidateInsert = z.infer<typeof sourceCandidateInsertSchema>;

/** A search for one identity that found nothing usable. */
export type SearchMissRow = z.infer<typeof searchMissSchema>;

/** A miss before the store assigns an id. */
export type SearchMissInsert = z.infer<typeof searchMissInsertSchema>;

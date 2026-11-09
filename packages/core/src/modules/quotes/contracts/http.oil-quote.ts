/**
 * Zod contracts for oil-change quote records and their line items.
 *
 * Moved from `packages/shared-types/src/oil-quote.ts` (5.1d) with declarations unchanged.
 */
import { z } from "zod";
import { catalogItemSchema, filterDetailSchema, lubricantDetailSchema } from "./http.catalog.js";
import { sourceClassificationSchema } from "../../../shared/web/source-classification.js";
import { fillKindSchema, pricedFillConditionSchema, unusableFillConditionSchema } from "./http.motul-compatibility.js";
import { attendantFillSchema } from "./http.oil-attendant-fill.js";
import {
  ENGINE_MATCHES_PATH,
  engineMatchesPath,
  researchIdentityFieldSchema,
  newerAttemptSchema,
  researchTimingFields,
  researchTimingSchema,
} from "./http.oil-research.js";
import { tecfilApplicationSchema } from "./http.tecfil-compatibility.js";

/**
 * One offerable card in the quote panel: a catalog item plus the lubricant-detail that
 * made it match. Only lubricants are ever offered, so `lubricant` is always present.
 */
export const quoteOptionCardSchema = catalogItemSchema.extend({
  lubricant: lubricantDetailSchema,
});

/**
 * One offerable filter in the quote panel: a catalog item plus the filter-detail whose
 * part number matched a fitted Tecfil number or one of its cross-references. Only filters
 * are ever offered in a filter slot, so `filter` is always present.
 */
export const quoteFilterCardSchema = catalogItemSchema.extend({
  filter: filterDetailSchema,
});

/**
 * One filter type's outcome for this vehicle. `matched` is the only state that prices
 * anything; the other three each name a different reason the type contributes nothing, so
 * the dialog can warn precisely without inventing a part number. `no_catalog_match` carries
 * the Tecfil numbers that were looked for, which is what the warning names.
 */
export const quoteFilterSlotSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("matched"),
    candidates: z.array(quoteFilterCardSchema).min(1),
  }),
  z.object({
    status: z.literal("no_catalog_match"),
    tecfilNumbers: z.array(z.string().trim().min(1)),
  }),
  z.object({ status: z.literal("no_fitment") }),
  z.object({ status: z.literal("unavailable") }),
]);

/**
 * Where this quote's filter slots came from, read from the stored fitment and the identity's
 * Tecfil state (background-oil-research D15) — the quote never calls Tecfil: `cached` a stored
 * row, `pending` Tecfil not yet consulted for the identity (with `stopped`), `unavailable` the
 * background consultation failed and is retried, `unmatched` Tecfil has no such vehicle. Only
 * `unmatched` sets `unmatchedField`.
 */
export const quoteFiltersSourceSchema = z.enum(["cached", "pending", "unavailable", "unmatched"]);

/** Which Tecfil identity field failed to match, named on an `unmatched` source. */
export const quoteFiltersUnmatchedFieldSchema = z.enum([
  "manufacturer",
  "vehicle",
  "engine",
  "year",
]);

/**
 * The filter half of a quote-options response. Always present on an `options` result, even
 * when nothing resolved — a Tecfil failure changes these slots and never the spec-level
 * status. `consultedAt` and `application` are null when no fitment was ever obtained. A
 * `pending` source carries `stopped`: true when background research is not running, so the
 * client knows whether waiting can resolve it.
 */
export const quoteFiltersSchema = z
  .object({
    source: quoteFiltersSourceSchema,
    stopped: z.boolean().optional(),
    consultedAt: z.string().nullable(),
    application: tecfilApplicationSchema.nullable(),
    unmatchedField: quoteFiltersUnmatchedFieldSchema.optional(),
    oil: quoteFilterSlotSchema,
    fuel: quoteFilterSlotSchema,
  })
  .refine((filters) => filters.source !== "pending" || filters.stopped !== undefined, {
    message: "a pending Tecfil source carries stopped",
    path: ["stopped"],
  });

/** One priced lubricant line inside a quote, frozen from catalog data at quote time. */
export const oilQuoteLineSchema = z.object({
  catalogItemId: z.string(),
  brand: z.string().trim().min(1),
  description: z.string().trim().min(1),
  price: z.number().nonnegative(),
});

/** Response body for a persisted oil-change quote, including the WhatsApp-ready proposal text. */
export const oilQuoteSchema = z.object({
  id: z.string(),
  customerId: z.string(),
  vehicleId: z.string(),
  conversationId: z.string().nullable(),
  lines: z.array(oilQuoteLineSchema).min(1),
  generatedMessageText: z.string().trim().min(1),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** Request body for `POST /vehicles/:id/quotes`. */
export const createOilQuoteBodySchema = z.object({
  conversationId: z.string().min(1).nullable().optional(),
  generatedMessageText: z.string().trim().min(1),
  lines: z
    .array(
      z.object({
        catalogItemId: z.string().min(1),
        price: z.number(),
      }),
    )
    .min(1),
});

/** A cited source as the dialog shows it. */
export const quoteCitedSourceSchema = z.object({
  sourcePublisher: z.string().trim().min(1),
  sourceDocument: z.string().trim().min(1),
  sourcePage: z.string().trim().min(1),
  sourceAuthority: z.number().int().min(1).max(5).nullable(),
  sourceUrl: z.string().nullable(),
});

/** One SAE grade and the source it is cited to. */
export const quoteGradeSourceSchema = quoteCitedSourceSchema.extend({
  grade: z.string().trim().min(1),
});

/**
 * The grounded spec every `options` result carries: every SAE grade the cited source listed,
 * the service-fill liters the dialog multiplies the catalog unit price by, and where that came
 * from. Liters are always > 0 here — a verified grade with no parseable capacity is
 * `no_capacity`, not an `options` result with zero liters.
 */
export const quoteSpecFieldsSchema = z.object({
  viscosityGrades: z.array(z.string().trim().min(1)).min(1),
  viscosity: z.string().min(1),
  /**
   * The API/ACEA class the cited source stated, or "" when it stated none.
   *
   * Empty is a truthful reading, not missing data: plenty of owner manuals give SAE grades
   * and a capacity without naming a class, and every row in `fixtures/oil-sources.json` is
   * one of those. `lubricantDetailSchema` has always said so — "`classification` may be
   * empty, which matches on viscosity alone" — and the dialog already renders it as
   * `classification === "" ? "" : ...`. A `.min(1)` here contradicted both and made every
   * reuse click in the demo fail serialization with the cards already computed.
   */
  classification: z.string(),
  fillLiters: z.number().positive(),
  fillKind: fillKindSchema,
  /**
   * What `fillLiters` is (D5): `with_filter`, or `unlabeled` when it is the single volume its
   * source gives. The card caption shows it.
   */
  fillCondition: pricedFillConditionSchema,
  sourcePublisher: z.string().trim().min(1),
  sourceDocument: z.string().trim().min(1),
  sourcePage: z.string().trim().min(1),
  /** prompt.md source tier, 1 (best) to 5. Optional: older cache rows never recorded it. */
  sourceAuthority: z.number().int().min(1).max(5).nullable().optional(),
  sourceUrl: z.string().nullable().optional(),
  /**
   * Each grade with its own source, in `viscosityGrades` order (D11, owner 2026-09-25): a
   * card shows its grade's source, and the header lists them when they differ. The fields
   * above stay the primary (highest-authority) source. No excerpt: that stays in the cache.
   */
  gradeSources: z.array(quoteGradeSourceSchema).min(1),
  /**
   * The source that stated `fillLiters`. An `options` result carries exactly one of it and
   * `attendantFill` (D24): a volume is either cited or the attendant's, never both.
   */
  litersSource: quoteCitedSourceSchema.optional(),
  /**
   * The stored attendant volume the cards are priced from, when the row has no usable liters and
   * one was kept for the identity (`quotes/oil-attendant-fill`, D24). With it, `fillLiters` is its
   * `liters`, `fillKind` `em_servico` and `fillCondition` `with_filter`: the field asked for the
   * in-service volume.
   */
  attendantFill: attendantFillSchema.optional(),
});

/** An `options` result carries exactly one of `litersSource` and `attendantFill`, and a stored volume prices as in-service. */
function oneVolumeSource(row: {
  litersSource?: unknown;
  attendantFill?: { liters: number } | undefined;
  fillLiters: number;
  fillKind: string;
  fillCondition: string;
}): boolean {
  if ((row.litersSource === undefined) === (row.attendantFill === undefined)) return false;
  if (!row.attendantFill) return true;
  return row.fillLiters === row.attendantFill.liters && row.fillKind === "em_servico" && row.fillCondition === "with_filter";
}
const ONE_VOLUME_SOURCE = {
  message: "an options result carries exactly one of litersSource and attendantFill; a stored volume prices as em_servico with_filter",
  path: ["attendantFill"],
};

/**
 * A disputed card's source (D24 F1, F3): publisher, document, page, nullable URL, nullable tier and
 * nullable class, so the card's citation suffix is the class label, else the tier's label, and is
 * omitted when both are null; a null URL shows no link.
 */
export const quoteConflictSourceSchema = quoteCitedSourceSchema.extend({
  sourceClassification: sourceClassificationSchema.nullable(),
});

/** One disputed grade with the highest-authority source that lists it (never one that does not). */
export const quoteConflictGradeSourceSchema = quoteConflictSourceSchema.extend({
  grade: z.string().trim().min(1),
});

/** One card of a grade in dispute: a stocked oil of that grade, citing its grade's source. */
export const quoteConflictCardSchema = quoteOptionCardSchema.extend({
  gradeSource: quoteConflictSourceSchema,
});

/** One source's volume in a volume conflict: a priced fill condition only, never dry or without the filter. */
export const quoteVolumeChoiceSchema = z.object({
  liters: z.number().positive(),
  fillCondition: pricedFillConditionSchema,
  source: quoteConflictSourceSchema,
});

/** One source's answer for a disputed field, with where it came from. */
export const conflictValueSchema = z.object({
  /** Grades joined by ", ", or the litre figure as text. The dialog formats by field. */
  value: z.string().min(1),
  sourcePublisher: z.string().min(1),
  sourceDocument: z.string().min(1),
  sourcePage: z.string().min(1),
  /** prompt.md tier, 1 best. Null when the source never declared one. */
  sourceAuthority: z.number().int().min(1).max(5).nullable(),
});

/**
 * Two or more validated sources disagreeing on a field. `values` is ordered highest
 * authority first, so the first entry is the one to prefer — shown, never silently chosen.
 */
export const sourceConflictSchema = z.object({
  field: z.enum(["viscosityGrades", "fillLiters"]),
  values: z.array(conflictValueSchema).min(2),
});

/**
 * What the shown cache row carries beside its own fields (D15): its date, and at most one of a
 * research under way that someone waits on or that runs (`refresh`) and a newer attempt that
 * found no source or failed (`newerAttempt`).
 */
const shownRowFields = {
  consultedAt: z.string().min(1),
  refresh: researchTimingSchema.optional(),
  newerAttempt: newerAttemptSchema.optional(),
};

/** `refresh` and `newerAttempt` never travel together. */
function refreshOrNewer(row: { refresh?: unknown; newerAttempt?: unknown }): boolean {
  return row.refresh === undefined || row.newerAttempt === undefined;
}
const REFRESH_OR_NEWER = { message: "refresh and newerAttempt are exclusive", path: ["newerAttempt"] };

/**
 * A conflict is in one of two shapes (D24 F1): the old one, `conflicts` only; or with its card
 * data — the grades, their sources, the classification, the cards and the filters — and at most
 * one volume: the agreed volume (liters, type, condition and source together), `volumeChoices`,
 * or, when no source stated a usable volume (orchestrator, 2026-10-01), none, which the attendant
 * types as on `no_capacity`; a kept `attendantFill` then prices it, and only then.
 */
function conflictShape(row: {
  viscosityGrades?: unknown;
  classification?: unknown;
  gradeSources?: unknown;
  options?: unknown;
  filters?: unknown;
  fillLiters?: unknown;
  fillKind?: unknown;
  fillCondition?: unknown;
  litersSource?: unknown;
  volumeChoices?: unknown;
  attendantFill?: unknown;
}): boolean {
  const card = [row.viscosityGrades, row.classification, row.gradeSources, row.options, row.filters];
  const agreed = [row.fillLiters, row.fillKind, row.fillCondition, row.litersSource];
  const present = (values: unknown[]) => values.filter((value) => value !== undefined).length;
  const typed = row.attendantFill !== undefined;
  if (present(card) === 0) return present(agreed) === 0 && row.volumeChoices === undefined && !typed;
  if (present(card) !== card.length) return false;
  const hasAgreed = present(agreed) === agreed.length;
  if (!hasAgreed && present(agreed) !== 0) return false;
  return [hasAgreed, row.volumeChoices !== undefined, typed].filter(Boolean).length <= 1;
}
const CONFLICT_SHAPE = {
  message: "a conflict carries conflicts only, or its card data with at most one of the agreed volume, volumeChoices and attendantFill",
  path: ["volumeChoices"],
};

/**
 * The quote-options result (background-oil-research D15): what the identity's latest cache row
 * yields, or its research state. `GET /vehicles/:id/quote-options` and
 * `POST /vehicles/:id/oil-research/refetch` both answer with it, and neither calls a provider.
 */
export const quoteOptionsResultSchema = z.discriminatedUnion("status", [
  /**
   * Research under way and no row to show, or a later conflict or clarification. No cards. On the
   * `engine_pick` path it names the engine and carries the fixed 1–2 minutes (D24).
   */
  researchTimingFields.extend({ status: z.literal("researching") }).refine(engineMatchesPath, ENGINE_MATCHES_PATH),
  quoteSpecFieldsSchema
    .extend({
      status: z.literal("options"),
      ...shownRowFields,
      options: z.array(quoteOptionCardSchema),
      filters: quoteFiltersSchema,
    })
    .refine(refreshOrNewer, REFRESH_OR_NEWER)
    .refine(oneVolumeSource, ONE_VOLUME_SOURCE),
  z
    .object({
      status: z.literal("empty"),
      viscosityGrades: z.array(z.string().trim().min(1)).min(1),
      viscosity: z.string().min(1),
      /** Empty when the cited source stated no class; see `quoteSpecFieldsSchema`. */
      classification: z.string(),
      ...shownRowFields,
    })
    .refine(refreshOrNewer, REFRESH_OR_NEWER),
  /**
   * At least one SAE grade was verified and no service-fill liters were parseable (D24): the
   * offerable cards, with their per-liter catalog price, and the filters, as `options` carries
   * them, and no `fillLiters` — the client prices the cards from a volume the attendant types. A
   * row with no offerable card answers `empty` instead.
   */
  z
    .object({
      status: z.literal("no_capacity"),
      viscosityGrades: z.array(z.string().trim().min(1)).min(1),
      viscosity: z.string().min(1),
      /** Empty when the cited source stated no class; see `quoteSpecFieldsSchema`. */
      classification: z.string(),
      options: z.array(quoteOptionCardSchema).min(1),
      filters: quoteFiltersSchema,
      /** Never present: a missing volume carries no volume. */
      fillLiters: z.never().optional(),
      /**
       * The volume the source did give, when it is one a change does not use (without the
       * filter, or dry): the dialog says so instead of only "no volume found" (D5). Absent
       * otherwise.
       */
      unusableFill: z
        .object({ liters: z.number().positive(), condition: unusableFillConditionSchema })
        .nullable()
        .optional(),
      ...shownRowFields,
    })
    .refine(refreshOrNewer, REFRESH_OR_NEWER),
  /**
   * No spec to quote from: the identity is incomplete (`missingFields` names what, and no research
   * is queued), or its research found no citable source. Two reasons, so the dialog never says
   * "no source" for a car that was never researched.
   */
  z
    .object({
      status: z.literal("no_spec"),
      reason: z.enum(["incomplete_identity", "no_source"]),
      missingFields: z.array(researchIdentityFieldSchema).min(1).optional(),
    })
    .refine((row) => row.reason !== "incomplete_identity" || row.missingFields !== undefined, {
      message: "an incomplete identity names its missing fields",
      path: ["missingFields"],
    }),
  /**
   * The source names more than one engine for the vehicle (`several`), or describes another
   * one (`mismatch`). The dialog asks in Portuguese and offers no cards; picking the first
   * option in silence is exactly what this forbids. `options` are the engines the source
   * named, verbatim: none, one or several (background-oil-research D10).
   */
  z.object({
    status: z.literal("needs_clarification"),
    coverage: z.enum(["several", "mismatch"]),
    options: z.array(z.string().trim().min(1)),
  }),
  /**
   * Authoritative sources disagree and the escalation read (when configured) could not settle it
   * within what they said; every value is shown with its source. Recorded with its card data
   * (D24 F1), it also carries the disputed grades with their sources, the classification, the
   * cards of every stocked oil of any listed grade (each citing its grade's source; empty when no
   * disputed grade is stocked), the filters, and the agreed volume, `volumeChoices`, or — when no
   * source stated a usable volume — no volume, for the attendant to type (or a kept
   * `attendantFill`). An old-shape conflict carries `conflicts` only, and no cards.
   */
  z
    .object({
      status: z.literal("conflicting_sources"),
      conflicts: z.array(sourceConflictSchema).min(1),
      viscosityGrades: z.array(z.string().trim().min(1)).min(1).optional(),
      classification: z.string().optional(),
      /** Each grade in `viscosityGrades` with the highest-authority source that lists it. */
      gradeSources: z.array(quoteConflictGradeSourceSchema).min(1).optional(),
      options: z.array(quoteConflictCardSchema).optional(),
      filters: quoteFiltersSchema.optional(),
      /** The volume the sources agree on, with its type and source. */
      fillLiters: z.number().positive().optional(),
      fillKind: fillKindSchema.optional(),
      fillCondition: pricedFillConditionSchema.optional(),
      litersSource: quoteConflictSourceSchema.optional(),
      /** Each source's volume when they disagree on it, highest authority first. */
      volumeChoices: z.array(quoteVolumeChoiceSchema).min(2).optional(),
      /**
       * When no source stated a usable volume (neither of the above): the identity's stored
       * attendant volume, which prices the chosen grade's cards; absent, the attendant types one.
       */
      attendantFill: attendantFillSchema.optional(),
    })
    .refine(conflictShape, CONFLICT_SHAPE),
  /** The identity's research failed: its attempts ran out on outages. */
  z.object({ status: z.literal("error") }),
]);

/** Grounded spec fields carried by an `options` result. */
export type QuoteSpecFields = z.infer<typeof quoteSpecFieldsSchema>;

/** A cited source as the dialog shows it. */
export type QuoteCitedSource = z.infer<typeof quoteCitedSourceSchema>;

/** One SAE grade and the source the dialog shows for it. */
export type QuoteGradeSource = z.infer<typeof quoteGradeSourceSchema>;

/** A disputed card's source, with its class. */
export type QuoteConflictSource = z.infer<typeof quoteConflictSourceSchema>;

/** One disputed grade with its source. */
export type QuoteConflictGradeSource = z.infer<typeof quoteConflictGradeSourceSchema>;

/** One card of a grade in dispute. */
export type QuoteConflictCard = z.infer<typeof quoteConflictCardSchema>;

/** One source's volume in a volume conflict. */
export type QuoteVolumeChoice = z.infer<typeof quoteVolumeChoiceSchema>;

/** One source's value for a disputed field. */
export type ConflictValue = z.infer<typeof conflictValueSchema>;

/** Sources disagreeing on one field, highest authority first. */
export type SourceConflict = z.infer<typeof sourceConflictSchema>;

/** One offerable quote card: catalog item plus its lubricant-detail. */
export type QuoteOptionCard = z.infer<typeof quoteOptionCardSchema>;

/** One offerable filter: catalog item plus its filter-detail. */
export type QuoteFilterCard = z.infer<typeof quoteFilterCardSchema>;

/** One filter type's outcome for this vehicle. */
export type QuoteFilterSlot = z.infer<typeof quoteFilterSlotSchema>;

/** Where a quote's filter slots came from. */
export type QuoteFiltersSource = z.infer<typeof quoteFiltersSourceSchema>;

/** Which Tecfil identity field failed to match. */
export type QuoteFiltersUnmatchedField = z.infer<typeof quoteFiltersUnmatchedFieldSchema>;

/** The filter half of a quote-options response. */
export type QuoteFilters = z.infer<typeof quoteFiltersSchema>;

/** Priced lubricant line inside a quote, frozen from catalog data at quote time. */
export type OilQuoteLine = z.infer<typeof oilQuoteLineSchema>;

/** Persisted oil-change quote, including the WhatsApp-ready proposal text. */
export type OilQuote = z.infer<typeof oilQuoteSchema>;

/** Request body for creating an oil-change quote. */
export type CreateOilQuoteBody = z.infer<typeof createOilQuoteBodySchema>;

/** What the quote panel shows for one vehicle: a stored row's options, or the research state. */
export type QuoteOptionsResult = z.infer<typeof quoteOptionsResultSchema>;

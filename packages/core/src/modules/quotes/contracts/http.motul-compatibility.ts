/**
 * Zod contract for the cached verified oil spec keyed by vehicle identity.
 *
 * The row is the CRM's cache of a *grounded* spec — every SAE grade a cited source listed,
 * the service-fill liters the quote multiplies by, and the provenance of that source. A Motul
 * Oil Advisor payload is one such source among reputable sources, not a product to sell.
 *
 * Moved from `packages/shared-types/src/motul-compatibility.ts` (5.1d) with declarations unchanged.
 */
import { z } from "zod";
import { sourceClassificationSchema } from "../../../shared/web/source-classification.js";

/**
 * Which capacity legend produced {@link motulCompatibilitySchema}'s `fillLiters`.
 * Dry fill (`Volume seco`) is never a quote multiplier, so it is not a member here.
 */
export const fillKindSchema = z.enum(["em_servico", "unlabeled"]);

/**
 * What a volume is (ingest-harvested-manuals D5): with the filter (the in-service volume a change
 * uses), without the filter, dry, or unlabeled. It refines {@link fillKindSchema}: `with_filter`
 * is `em_servico`. Only `with_filter`, or an unlabeled volume that is the single one its source
 * gives, multiplies the per-liter price (owner, 2026-09-26).
 */
export const fillConditionSchema = z.enum(["with_filter", "without_filter", "dry", "unlabeled"]);

/** The capacity types a quote multiplies by. */
export const pricedFillConditionSchema = z.enum(["with_filter", "unlabeled"]);

/** The capacity types recorded but never priced: a change uses neither. */
export const unusableFillConditionSchema = z.enum(["without_filter", "dry"]);

/**
 * One cited source, as a grade or the liters is attributed to it (D11, owner 2026-09-25).
 * The same fields the row's primary `source*` columns carry.
 */
export const citedSourceSchema = z.object({
  sourcePublisher: z.string(),
  sourceDocument: z.string(),
  sourcePage: z.string(),
  sourceAuthority: z.number().int().min(1).max(5).nullable(),
  sourceUrl: z.string().nullable(),
  sourceClassification: sourceClassificationSchema.nullable().optional(),
  /** The passage read, kept per source so a secondary source stays auditable too. */
  sourceExcerpt: z.string().nullable().optional(),
});

/** One SAE grade and the source it is cited to. */
export const gradeSourceSchema = citedSourceSchema.extend({
  grade: z.string().trim().min(1),
});

/** Cached verified oil spec for one make/year/model/version identity. */
export const motulCompatibilitySchema = z
  .object({
    id: z.string(),
    make: z.string().trim().min(1),
    year: z.number().int(),
    model: z.string().trim().min(1),
    version: z.string().trim().min(1),
    /** Every SAE grade the cited source listed, in source order. Never collapsed to one. */
    viscosityGrades: z.array(z.string().trim().min(1)).min(1),
    /** The first listed grade, kept so reuse headlines and older readers still have one value. */
    viscosity: z.string().trim().min(1),
    /**
     * API/ACEA class when the cited source states one, and **legally empty when
     * it does not** — matching on viscosity alone, the same contract
     * `lubricantDetailSchema` in `catalog.ts` already documents.
     *
     * Empty is not merely tolerated here. Every row in
     * `packages/core/fixtures/oil-sources.json` carries `""` truthfully: those
     * sources state grades and capacity and no class. A `min(1)` here would
     * force the seed to invent one, fabricating exactly the provenance the
     * verified-spec requirement exists to demand.
     *
     * `.trim()` is kept so a whitespace-only value normalises to empty rather
     * than passing as a class that matching code would treat as real.
     */
    classification: z.string().trim(),
    /** Service-fill liters; null when a grade was verified and capacity was not. */
    fillLiters: z.number().nonnegative().nullable(),
    /** Null exactly when `fillLiters` is null. */
    fillKind: fillKindSchema.nullable(),
    /**
     * The capacity type of `fillLiters` (`with_filter` or `unlabeled`), or, when a change's volume
     * was not found, of `unusableFillLiters` (`without_filter` or `dry`). Null when no volume was
     * found. Absent on rows written before it: the store reads it from `fillKind`.
     */
    fillCondition: fillConditionSchema.nullable().optional(),
    /** A volume found that a change does not use (without filter, or dry): recorded, never priced. */
    unusableFillLiters: z.number().positive().nullable().optional(),
    consultedAt: z.string(),
    rawPayload: z.unknown().nullable(),
    /** Provenance of the cited source. Empty only on historical, Motul-adapter-era rows. */
    sourcePublisher: z.string(),
    sourceDocument: z.string(),
    sourcePage: z.string(),
    /**
     * The source's tier in the prompt.md hierarchy: 1 manufacturer manual, 2 manufacturer
     * technical info, 3 licensed workshop database, 4 lubricant-maker application guide,
     * 5 reputable aftermarket catalog. This is what lets "a lower-priority source must not
     * silently override a higher-priority one" be enforced at all. Absent on rows written
     * before the column existed.
     */
    sourceAuthority: z.number().int().min(1).max(5).nullable().optional(),
    /** Where the passage was read from, so a reviewer can check it. Absent on older rows. */
    sourceUrl: z.string().nullable().optional(),
    /**
     * The searching model's document class for a web-found source, and the input the tier
     * was derived from. Absent for fixture and Motul sources, which are their own record.
     */
    sourceClassification: sourceClassificationSchema.nullable().optional(),
    /**
     * The passage the extractor actually read, for a web-found source.
     *
     * A committed fixture keeps its excerpt in the fixture file and a Motul payload is
     * reproducible from the API, but a web page can be edited or disappear — without this
     * a quote grounded on one cannot be audited afterwards.
     */
    sourceExcerpt: z.string().nullable().optional(),
    /**
     * Each grade with the source it is cited to, in `viscosityGrades` order: the
     * highest-authority source that lists it, never one that does not. The store always
     * fills it on read — a row written before the column cites every grade to its primary
     * source above. Optional so an insert may omit it, which records the same.
     */
    gradeSources: z.array(gradeSourceSchema).optional(),
    /** The source that stated `fillLiters`; null exactly when there are no liters. */
    litersSource: citedSourceSchema.nullable().optional(),
  })
  .superRefine((row, ctx) => {
    if ((row.fillLiters == null) !== (row.fillKind == null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fillKind"],
        message: "fillKind must be null exactly when fillLiters is null",
      });
    }
    const condition = row.fillCondition ?? null;
    if (row.fillLiters != null && condition !== null && !pricedFillConditionSchema.safeParse(condition).success) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["fillCondition"], message: "priced liters must be with_filter or unlabeled" });
    }
    if (row.unusableFillLiters != null && (row.fillLiters != null || !unusableFillConditionSchema.safeParse(condition).success)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["unusableFillLiters"],
        message: "an unusable volume is recorded only without priced liters, as without_filter or dry",
      });
    }
  });

/** Cached verified oil spec for a make/year/model/version identity. */
export type MotulCompatibility = z.infer<typeof motulCompatibilitySchema>;

/** One cited source for a grade or the liters. */
export type CitedSource = z.infer<typeof citedSourceSchema>;

/** One SAE grade and the source it is cited to. */
export type GradeSource = z.infer<typeof gradeSourceSchema>;

/** Which capacity legend produced a cached row's fill liters. */
export type FillKind = z.infer<typeof fillKindSchema>;

/** What a volume is: with filter, without filter, dry, or unlabeled (D5). */
export type FillCondition = z.infer<typeof fillConditionSchema>;

/** A capacity type a quote multiplies by. */
export type PricedFillCondition = z.infer<typeof pricedFillConditionSchema>;

/** A capacity type recorded but never priced. */
export type UnusableFillCondition = z.infer<typeof unusableFillConditionSchema>;

/**
 * Zod contract for cached Tecfil filter-fitment results keyed by vehicle identity.
 *
 * A row answers "which oil filter and fuel filter fit this make / year / model / version",
 * never "what does the workshop charge for it": it carries Tecfil's own numbers and labels
 * and no price, catalog item id, or vehicle id. Tecfil HTTP wire shapes stay in
 * the Tecfil client (`packages/core`'s `kernel/clients/tecfil`); only the cached result crosses into the shared contracts.
 *
 * Moved from `packages/shared-types/src/tecfil-compatibility.ts` (5.1d) with declarations unchanged.
 */
import { z } from "zod";

/** One equivalent part another brand sells, as Tecfil lists it on a fitted product. */
export const tecfilCrossReferenceSchema = z.object({
  brand: z.string(),
  number: z.string(),
});

/**
 * One part Tecfil fits for the matched application, of whichever type the list it sits in
 * names. `crossReferences` may be empty when the product search did not return that part.
 */
export const tecfilFilterCandidateSchema = z.object({
  tecfilNumber: z.string().trim().min(1),
  tecfilProductCode: z.number().int(),
  description: z.string(),
  crossReferences: z.array(tecfilCrossReferenceSchema),
});

/**
 * How one Tecfil application name was reached: `exact` after normalized equality,
 * `unanimous` when every engine variant fit the same parts so no engine was needed,
 * or `picked` when the injected option picker chose from Tecfil's own list.
 */
export const tecfilMatchKindSchema = z.enum(["exact", "unanimous", "picked"]);

/**
 * The Tecfil catalogue labels the fitment was read from. `engine` is null exactly when
 * the engine was settled by unanimity rather than by naming one variant.
 */
export const tecfilApplicationSchema = z.object({
  manufacturer: z.string(),
  vehicle: z.string(),
  engine: z.string().nullable(),
});

/**
 * Cached Tecfil fitment for one make/year/model/version identity, shared across customers
 * and units. Insert-only: a refetch adds a row, and reuse reads the latest `consultedAt`.
 * An empty `oilFilters` or `fuelFilters` is a valid cached answer meaning Tecfil lists no
 * such filter, not a failed lookup.
 */
export const tecfilCompatibilitySchema = z.object({
  id: z.string(),
  make: z.string().trim().min(1),
  year: z.number().int(),
  model: z.string().trim().min(1),
  version: z.string().trim().min(1),
  application: tecfilApplicationSchema,
  matchedBy: z.object({
    manufacturer: tecfilMatchKindSchema,
    vehicle: tecfilMatchKindSchema,
    engine: tecfilMatchKindSchema,
  }),
  oilFilters: z.array(tecfilFilterCandidateSchema),
  fuelFilters: z.array(tecfilFilterCandidateSchema),
  consultedAt: z.string(),
  rawPayload: z.unknown().nullable(),
});

/** Equivalent part another brand sells, as Tecfil lists it. */
export type TecfilCrossReference = z.infer<typeof tecfilCrossReferenceSchema>;

/** One part Tecfil fits for the matched application. */
export type TecfilFilterCandidate = z.infer<typeof tecfilFilterCandidateSchema>;

/** How one Tecfil application name was reached. */
export type TecfilMatchKind = z.infer<typeof tecfilMatchKindSchema>;

/** Tecfil catalogue labels a fitment was read from. */
export type TecfilApplication = z.infer<typeof tecfilApplicationSchema>;

/** Cached Tecfil filter fitment for a make/year/model/version identity. */
export type TecfilCompatibility = z.infer<typeof tecfilCompatibilitySchema>;

/**
 * Zod contracts for the attendant's own way out of three dead ends (background-oil-research D24):
 * the fill volume typed on a missing-volume quote and kept per identity (`quotes/oil-attendant-fill`),
 * and the engine chosen in a clarification.
 *
 * - `POST /vehicles/:id/oil-fill-volume` takes {@link oilFillVolumeBodySchema} and answers 201 with
 *   {@link attendantFillSchema}; 422 {@link highVolumeWarningSchema} for a volume above
 *   {@link HIGH_FILL_VOLUME_LITERS} sent without `confirmHighVolume`; 409
 *   {@link incompleteIdentityRefusalSchema}; 404 `{}` outside the caller's units.
 * - `POST /vehicles/:id/oil-research/engine-pick` takes {@link enginePickBodySchema} and answers 200
 *   with the quote-options union; 409 {@link enginePickRefusalSchema}; 422
 *   {@link versionTooLongSchema}; 404 `{}`.
 */
import { z } from "zod";

/** Above this many liters a typed volume is kept only with `confirmHighVolume: true` (owner, 2026-09-30). */
export const HIGH_FILL_VOLUME_LITERS = 30;

/** The largest volume the store holds (`oil_attendant_fill.liters` is DECIMAL(6,2)); above it the body is a 400. */
export const MAX_FILL_VOLUME_LITERS = 9999.99;

/** Whether a number has at most two decimals, read as the attendant typed it (4,25 yes; 4,255 no). */
export function hasAtMostTwoDecimals(value: number): boolean {
  return Number.isFinite(value) && Math.abs(Math.round(value * 100) - value * 100) < 1e-6;
}

/** A typed fill volume: a number of liters greater than zero, with at most two decimals. */
export const fillVolumeLitersSchema = z
  .number()
  .positive()
  // The column is DECIMAL(6,2): 9999.99 is the largest value it holds (orchestrator, 2026-10-01).
  .max(MAX_FILL_VOLUME_LITERS)
  .refine(hasAtMostTwoDecimals, { message: "at most two decimals" });

/** Request body for `POST /vehicles/:id/oil-fill-volume`. */
export const oilFillVolumeBodySchema = z.object({
  liters: fillVolumeLitersSchema,
  /** Required, true, for a volume above {@link HIGH_FILL_VOLUME_LITERS}: the dialog's warning was confirmed. */
  confirmHighVolume: z.boolean().optional(),
});

/**
 * A stored attendant volume, as the quote carries it and the store route answers it: `recordedBy`
 * is the user's display name, `recordedAt` an ISO instant.
 */
export const attendantFillSchema = z.object({
  liters: z.number().positive(),
  recordedBy: z.string().trim().min(1),
  recordedAt: z.string().min(1),
});

/** 422: a volume above {@link HIGH_FILL_VOLUME_LITERS} sent without its confirmation; nothing is stored. */
export const highVolumeWarningSchema = z.object({ warning: z.literal("high_volume") });

/** 409: the vehicle's identity is incomplete, so there is nothing to key a volume by. */
export const incompleteIdentityRefusalSchema = z.object({ reason: z.literal("incomplete_identity") });

/** Request body for `POST /vehicles/:id/oil-research/engine-pick`: one engine the clarification named, verbatim. */
export const enginePickBodySchema = z.object({ engine: z.string().trim().min(1) });

/**
 * 409 from the engine pick: the identity does not rest in a clarification (a second pick after the
 * identity changed included), or the engine is not one it named — nothing is written or queued —
 * or the vehicle's version changed between the check and the write (`version_changed`: the
 * version is not written; orchestrator, 2026-10-01). The client reads the quote again.
 */
export const enginePickRefusalSchema = z.object({ reason: z.enum(["not_clarification", "engine_not_named", "version_changed"]) });

/** 422 from the engine pick: the corrected version does not fit the version field; nothing is written. */
export const versionTooLongSchema = z.object({ error: z.literal("version_too_long") });

/** Request body for `POST /vehicles/:id/oil-fill-volume`. */
export type OilFillVolumeBody = z.infer<typeof oilFillVolumeBodySchema>;

/** A stored attendant volume. */
export type AttendantFill = z.infer<typeof attendantFillSchema>;

/** Request body for `POST /vehicles/:id/oil-research/engine-pick`. */
export type EnginePickBody = z.infer<typeof enginePickBodySchema>;

/** Why an engine pick was refused with 409. */
export type EnginePickRefusal = z.infer<typeof enginePickRefusalSchema>;

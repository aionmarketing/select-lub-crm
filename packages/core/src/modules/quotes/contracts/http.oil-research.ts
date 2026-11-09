/**
 * Zod contracts for the background oil research state a quote shows (background-oil-research
 * D14, D15, D18): the timing of a research under way, its pause, a newer attempt that did not
 * confirm the shown row, and the identity fields a research needs. The Veículo's own research
 * flag is the customers contract's (`vehicleSchema.oilResearch`).
 */
import { z } from "zod";

/**
 * A research pause, exactly one reason (D15): `retrying` while the next attempt's `retryAt` is
 * in the future, `stopped` while background research is not running. There is no budget reason:
 * the daily budget holds only the backfill, and a quote-options or refetch response concerns
 * research someone is waiting on.
 */
export const researchPauseSchema = z.discriminatedUnion("reason", [
  z.object({ reason: z.literal("retrying"), retryAt: z.string().min(1) }),
  z.object({ reason: z.literal("stopped") }),
]);

/** Whole minutes, a total counted from `requestedAt` (D14): `min` ≥ 1 and `max` > `min`. */
export const expectedMinutesSchema = z
  .object({ min: z.number().int().min(1), max: z.number().int() })
  .refine((range) => range.max > range.min, { message: "max must be above min", path: ["max"] });

/**
 * The path a research under way takes (D14): a stage-1 `search`, a `manual` wait or re-resolve,
 * or an `engine_pick` re-read of the passages a clarification kept, for one engine (D24).
 */
export const researchPathSchema = z.enum(["search", "manual", "engine_pick"]);

/** An engine re-read's fixed estimate (D14, D24): one to two minutes; the dialog shows no range. */
export const ENGINE_PICK_EXPECTED_MINUTES = { min: 1, max: 2 } as const;

/**
 * The timing fields of a research under way (D14, D15), shared by `researching` and an options
 * result's `refresh`. `requestedAt` is when someone started waiting on the current research —
 * the anchor of both the time searching and the estimate; `now` is the server's clock, so the
 * dialog ticks from the server's time, not the browser's. Unrefined, so `researching` can extend
 * it; {@link engineMatchesPath} is the rule every use applies.
 */
export const researchTimingFields = z.object({
  requestedAt: z.string().min(1),
  now: z.string().min(1),
  expectedMinutes: expectedMinutesSchema,
  /** Research claims ahead of this one, counting a run in progress. */
  queuePosition: z.number().int().min(0),
  path: researchPathSchema,
  /** The engine being re-read for: present exactly on the `engine_pick` path (D24). */
  engine: z.string().trim().min(1).optional(),
  paused: researchPauseSchema.nullable(),
});

/**
 * An `engine_pick` timing names its engine and carries the fixed 1–2 minutes; no other path names
 * an engine (shared-types "Quote options carry the research state").
 */
export function engineMatchesPath(timing: { path: string; engine?: string | undefined; expectedMinutes: { min: number; max: number } }): boolean {
  if (timing.path !== "engine_pick") return timing.engine === undefined;
  return (
    timing.engine !== undefined &&
    timing.expectedMinutes.min === ENGINE_PICK_EXPECTED_MINUTES.min &&
    timing.expectedMinutes.max === ENGINE_PICK_EXPECTED_MINUTES.max
  );
}

/** The refinement's message and path, for every schema that applies {@link engineMatchesPath}. */
export const ENGINE_MATCHES_PATH = {
  message: "an engine_pick timing names its engine and the fixed 1–2 minutes; no other path names one",
  path: ["engine"],
};

/** The timing of a research under way, with {@link engineMatchesPath} applied. */
export const researchTimingSchema = researchTimingFields.refine(engineMatchesPath, ENGINE_MATCHES_PATH);

/** A research newer than the shown row that did not confirm a source (D15). */
export const newerAttemptSchema = z.object({
  outcome: z.enum(["no_spec", "failed"]),
  finishedAt: z.string().min(1),
});

/** The identity fields a research needs, in the order the dialog names them (D17). */
export const researchIdentityFieldSchema = z.enum(["make", "model", "version", "year"]);

/** The timing of a research under way. */
export type ResearchTiming = z.infer<typeof researchTimingSchema>;

/** A research pause. */
export type ResearchPause = z.infer<typeof researchPauseSchema>;

/** A newer attempt that did not confirm the shown row. */
export type NewerAttempt = z.infer<typeof newerAttemptSchema>;

/** An identity field a research needs. */
export type ResearchIdentityField = z.infer<typeof researchIdentityFieldSchema>;

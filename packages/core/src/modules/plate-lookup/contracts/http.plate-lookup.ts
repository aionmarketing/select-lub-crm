/**
 * Zod contracts for `POST /plate-lookups`.
 *
 * Moved from `packages/shared-types/src/plate-lookup.ts` (5.1d) with declarations unchanged.
 */
import { z } from "zod";

/** Veículo keys a confirmed lookup may mark as plate-sourced. */
export const plateSourcedFieldKeySchema = z.enum(["make", "model", "version", "year"]);

/** Suggested vehicle fields returned by a lookup; omitted keys were not supplied. */
export const plateSuggestionFieldsSchema = z
  .object({
    make: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    version: z.string().min(1).optional(),
    year: z.number().int().positive().optional(),
    displacementCc: z.number().int().positive().optional(),
    fuel: z.string().min(1).optional(),
  })
  .strict();

/** Request body for `POST /plate-lookups`. `retry` skips a stored miss and bills again. */
export const plateLookupBodySchema = z
  .object({
    plate: z.string().min(1),
    retry: z.boolean().optional(),
  })
  .strict();

/** Discriminated lookup response the vehicle form branches on. */
export const plateLookupResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("found"),
    source: z.enum(["provider", "mock"]),
    provider: z.string(),
    cached: z.boolean(),
    fields: plateSuggestionFieldsSchema,
  }),
  z.object({
    status: z.literal("not_found"),
    source: z.enum(["provider", "mock"]),
    provider: z.string(),
    cached: z.boolean(),
    lookedUpAt: z.string().optional(),
    recordedOutcome: z.literal("miss").optional(),
  }),
  z.object({
    status: z.literal("failed"),
    reason: z.enum(["provider_error", "exhausted_balance", "not_configured"]),
  }),
  z.object({
    status: z.literal("unavailable"),
  }),
]);

/** 422 body when the plate fails format validation before any provider call. */
export const invalidPlateErrorSchema = z.object({
  code: z.literal("invalid_plate"),
});

/** Veículo keys a confirmed lookup may mark as plate-sourced. */
export type PlateSourcedFieldKey = z.infer<typeof plateSourcedFieldKeySchema>;

/** Suggested vehicle fields returned by a lookup. */
export type PlateSuggestionFields = z.infer<typeof plateSuggestionFieldsSchema>;

/** Request body for `POST /plate-lookups`. */
export type PlateLookupBody = z.infer<typeof plateLookupBodySchema>;

/** Discriminated lookup response the vehicle form branches on. */
export type PlateLookupResponse = z.infer<typeof plateLookupResponseSchema>;

/** 422 body when the plate fails format validation. */
export type InvalidPlateError = z.infer<typeof invalidPlateErrorSchema>;

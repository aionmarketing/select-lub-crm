/**
 * Zod contracts for AI-assisted registration prefill suggestions on a conversation.
 *
 * Moved from `packages/shared-types/src/prefill.ts` (5.1d) with declarations unchanged.
 */
import { z } from "zod";

/** Lifecycle state of the prefill job for a conversation. */
export const prefillStatusSchema = z.enum([
  "empty",
  "extracting",
  "pending",
  "failed",
]);

/** Customer or vehicle field the prefill agent may suggest for human review. */
export const prefillFieldKeySchema = z.enum([
  "name",
  "taxId",
  "plate",
  "make",
  "model",
  "version",
  "year",
  "odometerKm",
]);

const presentString = z.string().trim().min(1);

/** Map of suggested field values; only keys present in the extraction are included. */
export const prefillFieldsSchema = z
  .object({
    name: presentString.optional(),
    taxId: presentString.optional(),
    plate: presentString.optional(),
    make: presentString.optional(),
    model: presentString.optional(),
    version: presentString.optional(),
    year: z.number().int().optional(),
    odometerKm: z.number().optional(),
  })
  .strict();

/** Response body for the current prefill suggestion on a conversation. */
export const prefillSuggestionSchema = z.object({
  status: prefillStatusSchema,
  fields: prefillFieldsSchema.optional(),
  extractEnabled: z.boolean(),
});

/** Request body for turning language-model extraction on or off for one conversation. */
export const prefillExtractEnabledBodySchema = z
  .object({
    extractEnabled: z.boolean(),
  })
  .strict();

/** Request body for accepting one suggested field and writing it to the customer or vehicle. */
export const prefillAcceptBodySchema = z.discriminatedUnion("field", [
  z.object({ field: z.literal("name"), value: presentString }),
  z.object({ field: z.literal("taxId"), value: presentString }),
  z.object({ field: z.literal("plate"), value: presentString }),
  z.object({ field: z.literal("make"), value: presentString }),
  z.object({ field: z.literal("model"), value: presentString }),
  z.object({ field: z.literal("version"), value: presentString }),
  z.object({ field: z.literal("year"), value: z.number().int() }),
  z.object({ field: z.literal("odometerKm"), value: z.number() }),
]);

/** Request body for dismissing one suggested field without persisting it. */
export const prefillRejectBodySchema = z.object({
  field: prefillFieldKeySchema,
});

/** Empty request body for `POST /conversations/:id/prefill/accept-all`. */
export const prefillAcceptAllBodySchema = z.object({}).strict();

/** Lifecycle state of the prefill job for a conversation. */
export type PrefillStatus = z.infer<typeof prefillStatusSchema>;

/** Customer or vehicle field the prefill agent may suggest for human review. */
export type PrefillFieldKey = z.infer<typeof prefillFieldKeySchema>;

/** Map of suggested field values; only keys present in the extraction are included. */
export type PrefillFields = z.infer<typeof prefillFieldsSchema>;

/** Current prefill suggestion on a conversation. */
export type PrefillSuggestion = z.infer<typeof prefillSuggestionSchema>;

/** Request body for `PATCH /conversations/:id/prefill/extract-enabled`. */
export type PrefillExtractEnabledBody = z.infer<typeof prefillExtractEnabledBodySchema>;

/** Request body for accepting one suggested field and writing it to the customer or vehicle. */
export type PrefillAcceptBody = z.infer<typeof prefillAcceptBodySchema>;

/** Request body for dismissing one suggested field without persisting it. */
export type PrefillRejectBody = z.infer<typeof prefillRejectBodySchema>;

/** Empty request body for `POST /conversations/:id/prefill/accept-all`; the response is {@link PrefillSuggestion}. */
export type PrefillAcceptAllBody = z.infer<typeof prefillAcceptAllBodySchema>;

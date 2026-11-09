/**
 * Zod contracts for conversation tags and tag CRUD request bodies.
 *
 * Moved from `packages/shared-types/src/tag.ts` (5.1d) with declarations unchanged.
 */
import { z } from "zod";

/** Allowed MUI palette token names for tag chip color; null means the default theme color. */
export const tagColorSchema = z.enum([
  "primary",
  "secondary",
  "error",
  "warning",
  "info",
]);

/** Response body for a tag row in list and detail endpoints. */
export const tagSchema = z.object({
  id: z.string(),
  name: z.string().trim().min(1),
  color: tagColorSchema.nullable(),
  sortOrder: z.number().int(),
  active: z.boolean(),
});

/** Request body for `POST /tags`. */
export const tagCreateBodySchema = z.object({
  name: z.string().trim().min(1),
  color: tagColorSchema.nullable().optional(),
  sortOrder: z.number().int().optional(),
});

/** Request body for `PATCH /tags/:id`; only supplied fields are updated. */
export const tagPatchBodySchema = z.object({
  name: z.string().trim().min(1).optional(),
  color: tagColorSchema.nullable().optional(),
  sortOrder: z.number().int().optional(),
  active: z.boolean().optional(),
});

/** Tag row in list and detail API responses. */
export type Tag = z.infer<typeof tagSchema>;

/** Request body for `POST /tags`. */
export type TagCreateBody = z.infer<typeof tagCreateBodySchema>;

/** Request body for `PATCH /tags/:id`; only supplied fields are updated. */
export type TagPatchBody = z.infer<typeof tagPatchBodySchema>;

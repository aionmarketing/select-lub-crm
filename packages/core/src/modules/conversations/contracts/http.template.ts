/**
 * Zod contracts for parameterized WhatsApp reply templates and their preview output.
 *
 * Moved from `packages/shared-types/src/template.ts` (5.1d) with declarations unchanged.
 */
import { z } from "zod";

/** Closed set of placeholder names that templates may declare and the preview endpoint may substitute. */
export const templateVariableSchema = z.enum(["nome_cliente", "placa"]);

/** Declared variables on a template; duplicates are rejected at validation time. */
export const templateAllowedVariablesSchema = z
  .array(templateVariableSchema)
  .refine((variables) => new Set(variables).size === variables.length);

/** Response body for a template row in list and detail endpoints. */
export const templateSchema = z.object({
  id: z.string(),
  name: z.string().trim().min(1),
  text: z.string().trim().min(1),
  allowedVariables: templateAllowedVariablesSchema,
  status: z.enum(["active", "inactive"]),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** Request body for `POST /templates`. */
export const templateCreateBodySchema = z.object({
  name: z.string().trim().min(1),
  text: z.string().trim().min(1),
  allowedVariables: templateAllowedVariablesSchema.optional(),
});

/** Request body for `PATCH /templates/:id`; only supplied fields are updated. */
export const templatePatchBodySchema = z.object({
  name: z.string().trim().min(1).optional(),
  text: z.string().trim().min(1).optional(),
  allowedVariables: templateAllowedVariablesSchema.optional(),
  status: z.enum(["active", "inactive"]).optional(),
});

/** Response body for template preview with placeholders resolved for a given conversation context. */
export const templatePreviewSchema = z.object({
  text: z.string(),
});

/** Template row in list and detail API responses. */
export type Template = z.infer<typeof templateSchema>;

/** Request body for `POST /templates`. */
export type TemplateCreateBody = z.infer<typeof templateCreateBodySchema>;

/** Request body for `PATCH /templates/:id`; only supplied fields are updated. */
export type TemplatePatchBody = z.infer<typeof templatePatchBodySchema>;

/** Rendered template preview with placeholders resolved for a conversation context. */
export type TemplatePreview = z.infer<typeof templatePreviewSchema>;

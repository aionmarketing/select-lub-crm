/**
 * Path params and small bodies the conversation, tag and follow-up slices share.
 *
 * Copied from `apps/api/src/http/schemas.ts` and `http/multipart.ts` (4A), which
 * stay for the api folders not yet moved (cadastro, prefill); the same pattern
 * as scheduling's `internal/params.ts`. Wave 5 removes the api copies.
 */
import { z } from "zod";
import { tagSchema, templateSchema } from "../contracts/http.js";

/** Path `{ id }` for a conversation. */
export const conversationIdParams = z.object({ id: z.string().min(1) });

/** Path `{ id }` for a tag or template. */
export const tagIdParams = z.object({ id: z.string().min(1) });

/** Path `{ id, tagId }` for apply/remove tag on a conversation. */
export const conversationTagParams = z.object({
  id: z.string().min(1),
  tagId: z.string().min(1),
});

/** Path `{ id, templateId }` for template preview. */
export const conversationTemplateParams = z.object({
  id: z.string().min(1),
  templateId: z.string().min(1),
});

/** Path `{ id, messageId }` for media GET. */
export const mediaParams = z.object({
  id: z.string().min(1),
  messageId: z.string().min(1),
});

/** An empty object: the 404/401/403/400 bodies. */
export const emptyBody = z.object({});

/** A list of tags. */
export const tagListSchema = z.array(tagSchema);

/** A list of templates. */
export const templateListSchema = z.array(templateSchema);

/**
 * Reads one text field from a multipart request.
 *
 * @param fields - `file.fields` from `@fastify/multipart`.
 * @param name - The field name.
 * @returns The string value, or undefined when absent or not text.
 */
export function multipartField(fields: unknown, name: string) {
  if (!fields || typeof fields !== "object") {
    return undefined;
  }
  const raw = (fields as Record<string, unknown>)[name];
  const entry = Array.isArray(raw) ? raw[0] : raw;
  if (!entry || typeof entry !== "object") {
    return undefined;
  }
  const value = (entry as { value?: unknown }).value;
  return typeof value === "string" ? value : undefined;
}

/**
 * The `content-disposition` for a media download: a document as an attachment,
 * everything else inline, with a filename that cannot break the header.
 *
 * @param messageType - The media kind.
 * @param fileName - The stored name, or null.
 * @returns The header value.
 */
export function contentDisposition(
  messageType: "image" | "audio" | "document" | "video",
  fileName: string | null,
) {
  const kind = messageType === "document" ? "attachment" : "inline";
  const safe = (fileName ?? "file").replace(/[\r\n"]/g, "_");
  return `${kind}; filename="${safe}"`;
}

/**
 * Tag and template catalog HTTP.
 */
import {
  tagSchema,
  templatePreviewSchema,
  templateSchema,
  type Tag,
  type TagCreateBody,
  type TagPatchBody,
  type Template,
  type TemplateCreateBody,
  type TemplatePatchBody,
} from "@select-lub/shared-types";
import { apiBase, apiRead, headers, parse } from "./http.js";

const tagListSchema = tagSchema.array();
const templateListSchema = templateSchema.array();

/**
 * Lists all conversation tags for settings and inbox filters.
 * @returns Parsed `Tag[]` from `GET /tags`.
 */
export async function fetchTags(): Promise<Tag[]> {
  const body = await parse(await apiRead(`${apiBase}/tags`));
  return tagListSchema.parse(body);
}

/**
 * Lists tags the current user may apply to a conversation.
 * @returns Parsed `Tag[]` from `GET /tags/apply-options` (subset of {@link fetchTags}).
 */
export async function fetchTagApplyOptions(): Promise<Tag[]> {
  const body = await parse(await apiRead(`${apiBase}/tags/apply-options`));
  return tagListSchema.parse(body);
}

/**
 * Creates a conversation tag in settings.
 * @param input - Tag name and optional MUI chip color; null color means default styling.
 * @returns Parsed `Tag` from `POST /tags`.
 */
export async function createTag(input: TagCreateBody): Promise<Tag> {
  const body = await parse(
    await fetch(`${apiBase}/tags`, {
      method: "POST",
      headers: { ...headers(), "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  return tagSchema.parse(body);
}

/**
 * Updates label, color, or active flag of an existing tag.
 * @param id - Tag id used in the path segment.
 * @param input - Partial patch; omitted keys are left unchanged on the server.
 * @returns Parsed `Tag` from `PATCH /tags/:id`.
 */
export async function patchTag(id: string, input: TagPatchBody): Promise<Tag> {
  const body = await parse(
    await fetch(`${apiBase}/tags/${id}`, {
      method: "PATCH",
      headers: { ...headers(), "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  return tagSchema.parse(body);
}

/**
 * Lists message templates for the settings screen.
 * @returns Parsed `Template[]` from `GET /templates`.
 */
export async function fetchTemplates(): Promise<Template[]> {
  const body = await parse(await apiRead(`${apiBase}/templates`));
  return templateListSchema.parse(body);
}

/**
 * Creates a parameterized message template in settings.
 * @param input - Template name, body text, and allowed variable placeholders.
 * @returns Parsed `Template` from `POST /templates`.
 */
export async function createTemplate(input: TemplateCreateBody): Promise<Template> {
  const body = await parse(
    await fetch(`${apiBase}/templates`, {
      method: "POST",
      headers: { ...headers(), "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  return templateSchema.parse(body);
}

/**
 * Updates an existing message template.
 * @param id - Template id used in the path segment.
 * @param input - Partial patch; omitted keys are left unchanged on the server.
 * @returns Parsed `Template` from `PATCH /templates/:id`.
 */
export async function patchTemplate(id: string, input: TemplatePatchBody): Promise<Template> {
  const body = await parse(
    await fetch(`${apiBase}/templates/${id}`, {
      method: "PATCH",
      headers: { ...headers(), "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  return templateSchema.parse(body);
}

/**
 * Applies a tag to the conversation.
 * @param conversationId - CRM conversation id used in the path segment.
 * @param tagId - Tag id to attach; must be in the user's apply-options set.
 * @returns Resolves with no body on `POST /conversations/:conversationId/tags/:tagId` success.
 */
export async function applyConversationTag(conversationId: string, tagId: string): Promise<void> {
  await parse(
    await fetch(`${apiBase}/conversations/${conversationId}/tags/${tagId}`, {
      method: "POST",
      headers: headers(),
    }),
  );
}

/**
 * Removes a tag from the conversation.
 * @param conversationId - CRM conversation id used in the path segment.
 * @param tagId - Tag id to detach; no-op on the server when the tag is not applied.
 * @returns Resolves with no body on `DELETE /conversations/:conversationId/tags/:tagId` success.
 */
export async function removeConversationTag(conversationId: string, tagId: string): Promise<void> {
  await parse(
    await fetch(`${apiBase}/conversations/${conversationId}/tags/${tagId}`, {
      method: "DELETE",
      headers: headers(),
    }),
  );
}

/**
 * Renders a template with conversation context for the compose field.
 * @param conversationId - CRM conversation id whose customer/vehicle placeholders are interpolated.
 * @param templateId - Template id to preview.
 * @returns Interpolated message text from `POST /conversations/:conversationId/templates/:templateId/preview`.
 */
export async function previewTemplate(conversationId: string, templateId: string): Promise<string> {
  const body = await parse(
    await fetch(`${apiBase}/conversations/${conversationId}/templates/${templateId}/preview`, {
      method: "POST",
      headers: headers(),
    }),
  );
  return templatePreviewSchema.parse(body).text;
}

/**
 * Tags, templates and the tags on a conversation: the queries the tag and
 * template slices, and the inbox list's chips and tag filter, run.
 *
 * Moved from `apps/api/src/tags/{prisma,store}.ts` (4A) with the queries
 * unchanged. Each operation runs in `db.tx("conversations", …)`. Where the old
 * code caught a unique-constraint conflict (`P2002`), the catch now sits OUTSIDE
 * the transaction: a failed statement aborts the transaction (in production) or
 * its savepoint (under the harness), so it is caught after `db.tx` has rolled
 * back, never inside the callback.
 */
import { Prisma } from "@prisma/client";
import { tagColorSchema, templateAllowedVariablesSchema, type Tag, type TagCreateBody, type TagPatchBody, type TagSummary, type Template, type TemplateCreateBody, type TemplatePatchBody } from "../contracts/http.js";
import type { Db } from "../../../kernel/db.js";
import { interpolateTemplate } from "./interpolate.js";

/** Result of a tag write. */
export type TagWriteResult = { status: "ok"; tag: Tag } | { status: "conflict" } | { status: "not_found" };

/** Result of a template write. */
export type TemplateWriteResult =
  | { status: "ok"; template: Template }
  | { status: "conflict" }
  | { status: "not_found" };

/** Result of applying a tag to a conversation. */
export type ApplyTagResult = "ok" | "not_found" | "inactive";

/** Result of removing a tag from a conversation. */
export type RemoveTagResult = "ok" | "not_found";

/** Result of a template preview. */
export type PreviewTemplateResult = { status: "ok"; text: string } | { status: "not_found" };

function isUniqueConflict(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/**
 * Stable tag ordering for API lists: `sortOrder`, then name.
 *
 * @param rows - Tag DTOs to sort.
 * @returns A new array sorted ascending by `sortOrder`, then locale name.
 */
export function sortTags(rows: Tag[]) {
  return [...rows].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

/**
 * Minimal tag shape embedded on conversation summaries.
 *
 * @param tag - Tag fields to expose on list rows.
 * @returns {@link TagSummary} with id, name, and color only.
 */
export function toTagSummary(tag: Pick<Tag, "id" | "name" | "color">): TagSummary {
  return { id: tag.id, name: tag.name, color: tag.color };
}

function toTagDto(row: { id: string; name: string; color: string | null; sortOrder: number; active: boolean }): Tag {
  return {
    id: row.id,
    name: row.name,
    color: tagColorSchema.nullable().parse(row.color),
    sortOrder: row.sortOrder,
    active: row.active,
  };
}

function toTemplateDto(row: {
  id: string;
  name: string;
  text: string;
  allowedVariables: unknown;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}): Template {
  const status = row.status === "inactive" ? "inactive" : "active";
  return {
    id: row.id,
    name: row.name,
    text: row.text,
    allowedVariables: templateAllowedVariablesSchema.parse(row.allowedVariables),
    status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** All tag definitions of a loja, for the admin screen. */
export async function listTags(db: Db, unitId: string): Promise<Tag[]> {
  const rows = await db.tx("conversations", (tx) => tx.tag.findMany({ where: { unitId } }));
  return sortTags(rows.map(toTagDto));
}

/** The active tags a loja's picker offers. */
export async function listApplyOptions(db: Db, unitId: string): Promise<Tag[]> {
  const rows = await db.tx("conversations", (tx) => tx.tag.findMany({ where: { unitId, active: true } }));
  return sortTags(rows.map(toTagDto));
}

/** Creates a tag; `conflict` when the name is taken in the loja. */
export async function createTag(db: Db, unitId: string, body: TagCreateBody): Promise<TagWriteResult> {
  try {
    const row = await db.tx("conversations", (tx) =>
      tx.tag.create({
        data: { unitId, name: body.name, color: body.color ?? null, sortOrder: body.sortOrder ?? 0, active: true },
      }),
    );
    return { status: "ok", tag: toTagDto(row) };
  } catch (error) {
    if (isUniqueConflict(error)) {
      return { status: "conflict" };
    }
    throw error;
  }
}

/** Patches a tag of the loja; `not_found` for another loja's, `conflict` on a taken name. */
export async function patchTag(db: Db, unitId: string, id: string, body: TagPatchBody): Promise<TagWriteResult> {
  const existing = await db.tx("conversations", (tx) => tx.tag.findFirst({ where: { id, unitId } }));
  if (!existing) {
    return { status: "not_found" };
  }
  try {
    const row = await db.tx("conversations", (tx) =>
      tx.tag.update({
        where: { id },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.color !== undefined ? { color: body.color } : {}),
          ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
          ...(body.active !== undefined ? { active: body.active } : {}),
        },
      }),
    );
    return { status: "ok", tag: toTagDto(row) };
  } catch (error) {
    if (isUniqueConflict(error)) {
      return { status: "conflict" };
    }
    throw error;
  }
}

/** A loja's templates, by name. */
export async function listTemplates(db: Db, unitId: string): Promise<Template[]> {
  const rows = await db.tx("conversations", (tx) =>
    tx.template.findMany({ where: { unitId }, orderBy: { name: "asc" } }),
  );
  return rows.map(toTemplateDto);
}

/** Creates a template; `conflict` when the name is taken in the loja. */
export async function createTemplate(
  db: Db,
  unitId: string,
  body: TemplateCreateBody,
): Promise<TemplateWriteResult> {
  try {
    const row = await db.tx("conversations", (tx) =>
      tx.template.create({
        data: {
          unitId,
          name: body.name,
          text: body.text,
          allowedVariables: body.allowedVariables ?? [],
          status: "active",
        },
      }),
    );
    return { status: "ok", template: toTemplateDto(row) };
  } catch (error) {
    if (isUniqueConflict(error)) {
      return { status: "conflict" };
    }
    throw error;
  }
}

/** Patches a template of the loja; `not_found` for another loja's, `conflict` on a taken name. */
export async function patchTemplate(
  db: Db,
  unitId: string,
  id: string,
  body: TemplatePatchBody,
): Promise<TemplateWriteResult> {
  const existing = await db.tx("conversations", (tx) => tx.template.findFirst({ where: { id, unitId } }));
  if (!existing) {
    return { status: "not_found" };
  }
  try {
    const row = await db.tx("conversations", (tx) =>
      tx.template.update({
        where: { id },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.text !== undefined ? { text: body.text } : {}),
          ...(body.allowedVariables !== undefined ? { allowedVariables: body.allowedVariables } : {}),
          ...(body.status !== undefined ? { status: body.status } : {}),
        },
      }),
    );
    return { status: "ok", template: toTemplateDto(row) };
  } catch (error) {
    if (isUniqueConflict(error)) {
      return { status: "conflict" };
    }
    throw error;
  }
}

/**
 * Applies a tag to a conversation of the loja. Idempotent: an open assignment,
 * or a concurrent apply that wins the unique index, is `ok`.
 */
export async function applyTag(db: Db, unitId: string, conversationId: string, tagId: string): Promise<ApplyTagResult> {
  const found = await db.tx("conversations", async (tx) => {
    const conversation = await tx.conversation.findFirst({
      where: { id: conversationId, whatsappConnection: { unitId } },
      select: { id: true },
    });
    if (!conversation) {
      return "not_found" as const;
    }
    const tag = await tx.tag.findFirst({ where: { id: tagId, unitId } });
    if (!tag) {
      return "not_found" as const;
    }
    if (!tag.active) {
      return "inactive" as const;
    }
    const open = await tx.conversationTag.findFirst({ where: { conversationId, tagId, removedAt: null } });
    return open ? ("ok" as const) : ("apply" as const);
  });
  if (found !== "apply") {
    return found;
  }
  try {
    await db.tx("conversations", (tx) =>
      tx.conversationTag.create({ data: { conversationId, tagId, assignedByUserId: null } }),
    );
  } catch (error) {
    if (isUniqueConflict(error)) {
      return "ok";
    }
    throw error;
  }
  return "ok";
}

/** Removes a tag from a conversation of the loja; `not_found` when nothing is open. */
export async function removeTag(
  db: Db,
  unitId: string,
  conversationId: string,
  tagId: string,
): Promise<RemoveTagResult> {
  return db.tx("conversations", async (tx) => {
    const conversation = await tx.conversation.findFirst({
      where: { id: conversationId, whatsappConnection: { unitId } },
      select: { id: true },
    });
    if (!conversation) {
      return "not_found";
    }
    const tag = await tx.tag.findFirst({ where: { id: tagId, unitId } });
    if (!tag) {
      return "not_found";
    }
    const open = await tx.conversationTag.findFirst({ where: { conversationId, tagId, removedAt: null } });
    if (!open) {
      return "not_found";
    }
    await tx.conversationTag.update({ where: { id: open.id }, data: { removedAt: new Date() } });
    return "ok";
  });
}

/** The open tags of each conversation, as the inbox list's chips. */
export async function openTagsByConversation(
  db: Db,
  unitId: string,
  conversationIds: string[],
): Promise<Map<string, TagSummary[]>> {
  const map = new Map(conversationIds.map((id) => [id, [] as TagSummary[]]));
  if (conversationIds.length === 0) {
    return map;
  }
  const rows = await db.tx("conversations", (tx) =>
    tx.conversationTag.findMany({
      where: { conversationId: { in: conversationIds }, removedAt: null, tag: { unitId } },
      include: { tag: true },
    }),
  );
  for (const row of rows) {
    const list = map.get(row.conversationId);
    if (!list) {
      continue;
    }
    list.push(toTagSummary(toTagDto(row.tag)));
  }
  return map;
}

/**
 * The loja's conversations carrying EVERY given tag. An unknown tag id yields
 * nothing, never the unfiltered list.
 */
export async function conversationIdsWithAllTags(db: Db, unitId: string, tagIds: string[]): Promise<string[]> {
  if (tagIds.length === 0) {
    return [];
  }
  return db.tx("conversations", async (tx) => {
    const known = await tx.tag.count({ where: { unitId, id: { in: tagIds } } });
    if (known !== tagIds.length) {
      return [];
    }
    const rows = await tx.conversation.findMany({
      where: {
        whatsappConnection: { unitId },
        AND: tagIds.map((tagId) => ({ conversationTags: { some: { tagId, removedAt: null } } })),
      },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  });
}

/** Renders an active template of the loja with the thread's values. */
export async function previewTemplate(
  db: Db,
  unitId: string,
  templateId: string,
  values: { nome_cliente: string | null; placa: string | null },
): Promise<PreviewTemplateResult> {
  const row = await db.tx("conversations", (tx) =>
    tx.template.findFirst({ where: { id: templateId, unitId, status: "active" } }),
  );
  if (!row) {
    return { status: "not_found" };
  }
  return { status: "ok", text: interpolateTemplate(toTemplateDto(row).text, values) };
}

/**
 * Test design (testing-strategy)
 *
 * Setup: zod parse / safeParse on Tag/Template write bodies and the
 * conversation-list query. No HTTP.
 *
 * Oracle: openspec/changes/tags-and-templates-crud/specs/shared-types/spec.md
 *   Create Tag color is palette enum or null; free hex fails.
 *   Template allowedVariables is a closed set (nome_cliente | placa).
 *   List query MAY repeat tagId. Inbox TagSummary has no catalog fields.
 *
 * Axes
 *   A1 Tag create.color — primary (valid enum) / null / omitted /
 *      "#F2B705" (invalid hex) / "success" (not in the write set)
 *   A2 Template create.allowedVariables — [nome_cliente] / [modelo] /
 *      duplicate placa
 *   A3 List query.tagId — omitted / one string / two strings
 *   A4 Inbox chip — TagSummary only (id, name, color); no sortOrder/active
 *
 * BVA: none ordered beyond trim().min(1) already sampled in remainder.test.ts.
 *
 * Outputs
 *   O1 parse succeeds
 *   O2 safeParse.success === false
 *
 * Sampled-cell
 *   create color primary          | A1 primary | O1 | parse throws
 *   create color hex              | A1 hex     | O2 | success
 *   create color success          | A1 other   | O2 | success
 *   create color null             | A1 null    | O1 | parse throws
 *   template modelo variable      | A2 invalid | O2 | success
 *   template nome_cliente only    | A2 valid   | O1 | parse throws
 *   list query two tag ids        | A3 two     | O1 | parse throws
 *   list query omitted tagId      | A3 omit    | O1 | parse throws
 *   conversationListTagIds coerce | A3 one/two | — | array shape wrong
 *   inbox chip without catalog    | A4         | O1 | sortOrder present
 *
 * Decision map
 *   D1 tagColorSchema enum member T: primary; F: hex and success (own its)
 *   D2 color null vs omitted — both valid on create (null sampled; omitted
 *      is the default body `{ name }` in the primary it)
 *   D3 templateVariableSchema member T: nome_cliente; F: modelo
 *   D4 tagId union string vs array T: two-id array; F: omitted undefined
 *   D5 conversationListTagIds Array.isArray T: two ids; F: one string
 *
 * Out of scope: HTTP 409 duplicate names; Prisma partial unique indexes;
 * every palette key (warning/info/error/secondary) — same enum partition
 * as primary.
 */
import { describe, expect, it } from "vitest";
import { conversationListQuerySchema, conversationListTagIds, conversationSummarySchema } from "./http.conversation.js";
import { tagCreateBodySchema } from "./http.tag.js";
import { templateCreateBodySchema } from "./http.template.js";

describe("Tag create body", () => {
  it("parses a create with color primary", () => {
    const parsed = tagCreateBodySchema.parse({ name: "Retorno", color: "primary" });
    expect(parsed.color).toBe("primary");
  });

  it("rejects a create with free hex color", () => {
    expect(
      tagCreateBodySchema.safeParse({ name: "Retorno", color: "#F2B705" }).success,
    ).toBe(false);
  });

  it("rejects a create with color success", () => {
    expect(
      tagCreateBodySchema.safeParse({ name: "Retorno", color: "success" }).success,
    ).toBe(false);
  });

  it("parses a create with color null", () => {
    expect(tagCreateBodySchema.parse({ name: "Retorno", color: null }).color).toBe(null);
  });
});

describe("Template create body", () => {
  it("rejects an unknown allowed variable", () => {
    expect(
      templateCreateBodySchema.safeParse({
        name: "Aviso",
        text: "Oi",
        allowedVariables: ["modelo"],
      }).success,
    ).toBe(false);
  });

  it("parses a create with nome_cliente only", () => {
    const parsed = templateCreateBodySchema.parse({
      name: "Aviso",
      text: "Oi {{nome_cliente}}",
      allowedVariables: ["nome_cliente"],
    });
    expect(parsed.allowedVariables).toEqual(["nome_cliente"]);
  });
});

describe("conversation list query", () => {
  it("parses a list query with two tag ids", () => {
    const parsed = conversationListQuerySchema.parse({
      tagId: ["tag-1", "tag-2"],
    });
    expect(parsed.tagId).toEqual(["tag-1", "tag-2"]);
  });

  it("parses a list query with tagId omitted", () => {
    expect(conversationListQuerySchema.parse({})).toEqual({});
  });

  it("coerces one or two tagId values into an array", () => {
    expect(conversationListTagIds({})).toEqual([]);
    expect(conversationListTagIds({ tagId: "tag-1" })).toEqual(["tag-1"]);
    expect(conversationListTagIds({ tagId: ["tag-1", "tag-2"] })).toEqual([
      "tag-1",
      "tag-2",
    ]);
  });
});

describe("inbox summary chips", () => {
  it("parses a conversation-list fixture whose chips have no catalog fields", () => {
    const parsed = conversationSummarySchema.parse({
      id: "conv-1",
      contactLabel: "11999999999",
      phone: "11999999999",
      lastSnippet: "oi",
      lastMessageAt: "2026-08-26T12:00:00.000Z",
      tags: [{ id: "tag-1", name: "Retorno", color: "primary" }],
      sourceType: "UNKNOWN",
      unanswered: false,
      pipelineStage: "novosContatos",
    });
    expect(parsed.tags[0]).toEqual({ id: "tag-1", name: "Retorno", color: "primary" });
    expect(parsed.tags[0]).not.toHaveProperty("sortOrder");
    expect(parsed.tags[0]).not.toHaveProperty("active");
  });
});

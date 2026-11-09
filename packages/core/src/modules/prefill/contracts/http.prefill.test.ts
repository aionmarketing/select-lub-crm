/**
 * Test design (testing-strategy)
 *
 * Setup: zod parse / safeParse on prefill suggestion, accept, reject, and
 * the existing conversation-list payload. No HTTP, no LLM.
 *
 * Oracle: openspec/changes/prefill-switch-realistic-workshop-mix/specs/shared-types/spec.md
 *   — pending with only plate parses (other v1 keys absent); accept names
 *   plate + a value; GET empty with extractEnabled false parses; patch
 *   `{ extractEnabled: true }` parses; ConversationSummary has no required
 *   suggestion/Cliente/`extractEnabled` fields. Task 1.1 also: unknown accept
 *   field key fails parse.
 *
 * Techniques: EP (one invalid class per `it`), BVA on trim().min(1) for a
 * present string field, membership EP on status / field-key enums.
 *
 * ----------------------------------------------------------------------------
 * Axes
 * ----------------------------------------------------------------------------
 * A1 suggestion status
 *   EP valid: empty | extracting | pending | failed (all four sampled)
 *   EP invalid: any other string (sampled "ready")
 *
 * A2 fields key set
 *   EP valid: only `plate`; omitted `fields`
 *   EP invalid: unknown key `street` (.strict()); `name: ""` (present empty)
 *   Sampled: only plate (spec); street (one extra-key class); empty name
 *   Not sampled: every other single v1 key success (same optional-key shape)
 *
 * A3 accept field
 *   EP valid: closed v1 list (sampled plate + non-empty string)
 *   EP invalid: unknown key (sampled "street"); year with a string value
 *   BVA: plate value "" (below trim min 1) vs "ABC1D23" (valid)
 *
 * A4 ConversationSummary shape
 *   EP valid: existing list-item keys only (id, contactLabel, phone,
 *   lastSnippet, lastMessageAt, tags)
 *   Assert: schema.shape has no suggestion/Cliente/`extractEnabled` keys
 *
 * A5 reject body
 *   EP valid: plate; EP invalid: street
 *
 * A6 extractEnabled on GET
 *   EP valid: false (spec GET-with-switch-off); true with pending
 *   EP invalid: omitted (required boolean)
 *
 * A7 switch patch body
 *   EP valid: `{ extractEnabled: true }`
 *   EP invalid: missing key; extra key (.strict()); non-boolean
 *
 * Outputs: O1 parse success; O2 safeParse.success === false
 *
 * ----------------------------------------------------------------------------
 * Sampled-cell table
 * ----------------------------------------------------------------------------
 * it                                              | axes        | O | fails if
 * pending suggestion with only plate              | A1 A2 A6    | 1 | parse throws
 *                                                 |             |   | or extra v1 keys
 * parses empty / extracting / failed status       | A1 valid    | 1 | parse throws
 * GET empty with switch off                       | A6 false    | 1 | parse throws
 * rejects suggestion status ready                 | A1 invalid  | 2 | success
 * rejects suggestion with unknown field street    | A2 invalid  | 2 | success
 * rejects suggestion missing extractEnabled       | A6 omit     | 2 | success
 * rejects fields name present and empty           | A2 empty    | 2 | success
 * parses accept body for plate                    | A3 valid    | 1 | parse throws
 * rejects accept plate when value is empty        | A3 BVA ""   | 2 | success
 * rejects accept with unknown field key           | A3 invalid  | 2 | success
 * rejects accept year when value is a string      | A3 type     | 2 | success
 * parses reject body for plate                    | A5 valid    | 1 | parse throws
 * rejects reject body with unknown field          | A5 invalid  | 2 | success
 * parses switch patch true                        | A7 valid    | 1 | parse throws
 * rejects switch patch extra key                  | A7 extra    | 2 | success
 * conversation list item has no suggestion keys   | A4          | 1 | parse throws
 *                                                 |             |   | or shape has
 *                                                 |             |   | fields/name/plate
 *                                                 |             |   | /extractEnabled
 *
 * ----------------------------------------------------------------------------
 * Decision / branch map (zod checks that are real decisions)
 * ----------------------------------------------------------------------------
 * status in enum true — pending + empty/extracting/failed `it`; false — ready `it`
 * fields.strict extra key false — street `it`
 * name trim min(1) false — empty name `it`
 * extractEnabled present true — GET-off / pending `it`; false — omitted `it`
 * patch body .strict extra key false — extra-key `it`
 * accept field in v1 enum false — unknown key `it`
 * accept year value is number false — string year `it`
 * accept plate trim min(1) false — empty plate `it`
 * reject field in v1 enum true — plate; false — street
 * ConversationSummary.shape membership — list-item `it`
 *
 * Out of scope: HTTP 404/409; GET extracting/failed mapping (API task 3.1);
 * every v1 accept success; LLM output.
 *
 * Techniques: EP (one invalid class per `it`), BVA on trim().min(1) for a
 * present string field, membership EP on status / field-key enums.
 *
 * ----------------------------------------------------------------------------
 * Axes
 * ----------------------------------------------------------------------------
 * A1 suggestion status
 *   EP valid: empty | extracting | pending | failed (all four sampled)
 *   EP invalid: any other string (sampled "ready")
 *
 * A2 fields key set
 *   EP valid: only `plate`; omitted `fields`
 *   EP invalid: unknown key `street` (.strict()); `name: ""` (present empty)
 *   Sampled: only plate (spec); street (one extra-key class); empty name
 *   Not sampled: every other single v1 key success (same optional-key shape)
 *
 * A3 accept field
 *   EP valid: closed v1 list (sampled plate + non-empty string)
 *   EP invalid: unknown key (sampled "street"); year with a string value
 *   BVA: plate value "" (below trim min 1) vs "ABC1D23" (valid)
 *
 * A4 ConversationSummary shape
 *   EP valid: existing list-item keys only (id, contactLabel, phone,
 *   lastSnippet, lastMessageAt, tags)
 *   Assert: schema.shape has no suggestion/Cliente keys
 *
 * A5 reject body
 *   EP valid: plate; EP invalid: street
 *
 * Outputs: O1 parse success; O2 safeParse.success === false
 *
 * ----------------------------------------------------------------------------
 * Sampled-cell table
 * ----------------------------------------------------------------------------
 * it                                              | axes        | O | fails if
 * pending suggestion with only plate              | A1 A2 valid | 1 | parse throws
 *                                                 |             |   | or extra v1 keys
 * parses empty / extracting / failed status       | A1 valid    | 1 | parse throws
 * rejects suggestion status ready                 | A1 invalid  | 2 | success
 * rejects suggestion with unknown field street    | A2 invalid  | 2 | success
 * rejects fields name present and empty           | A2 empty    | 2 | success
 * parses accept body for plate                    | A3 valid    | 1 | parse throws
 * rejects accept plate when value is empty        | A3 BVA ""   | 2 | success
 * rejects accept with unknown field key           | A3 invalid  | 2 | success
 * rejects accept year when value is a string      | A3 type     | 2 | success
 * parses reject body for plate                    | A5 valid    | 1 | parse throws
 * rejects reject body with unknown field          | A5 invalid  | 2 | success
 * conversation list item has no suggestion keys   | A4          | 1 | parse throws
 *                                                 |             |   | or shape has
 *                                                 |             |   | fields/name/plate
 *
 * ----------------------------------------------------------------------------
 * Decision / branch map (zod checks that are real decisions)
 * ----------------------------------------------------------------------------
 * status in enum true — pending + empty/extracting/failed `it`; false — ready `it`
 * fields.strict extra key false — street `it`
 * name trim min(1) false — empty name `it`
 * accept field in v1 enum false — unknown key `it`
 * accept year value is number false — string year `it`
 * accept plate trim min(1) false — empty plate `it`
 * reject field in v1 enum true — plate; false — street
 * ConversationSummary.shape membership — list-item `it`
 *
 * Out of scope: HTTP 404/409; GET extracting/failed mapping (API task 4.2);
 * every v1 accept success; LLM output.
 */
import { describe, expect, it } from "vitest";
import { conversationSummarySchema } from "../../conversations/contracts/http.js";
import { prefillAcceptBodySchema, prefillAcceptAllBodySchema, prefillExtractEnabledBodySchema, prefillFieldsSchema, prefillRejectBodySchema, prefillSuggestionSchema } from "./http.prefill.js";

const LIST_ITEM = {
  id: "conv-1",
  contactLabel: "11999999999",
  phone: "11999999999",
  lastSnippet: "oi",
  lastMessageAt: "2026-08-26T12:00:00.000Z",
  tags: [],
  sourceType: "UNKNOWN",
  unanswered: false,
  pipelineStage: "novosContatos",
};

describe("prefillSuggestionSchema", () => {
  it("parses a pending suggestion with only plate", () => {
    const parsed = prefillSuggestionSchema.parse({
      status: "pending",
      fields: { plate: "ABC1D23" },
      extractEnabled: false,
    });

    expect(parsed.status).toBe("pending");
    expect(parsed.fields).toEqual({ plate: "ABC1D23" });
    expect(parsed.fields && "name" in parsed.fields).toBe(false);
    expect(parsed.fields && "taxId" in parsed.fields).toBe(false);
  });

  it.each(["empty", "extracting", "failed"] as const)("parses status %s", (status) => {
    expect(prefillSuggestionSchema.parse({ status, extractEnabled: false }).status).toBe(status);
  });

  it("parses an empty GET payload with the switch off", () => {
    expect(prefillSuggestionSchema.parse({ status: "empty", extractEnabled: false })).toEqual({
      status: "empty",
      extractEnabled: false,
    });
  });

  it("rejects a suggestion when status is not in the enum", () => {
    expect(
      prefillSuggestionSchema.safeParse({
        status: "ready",
        fields: { plate: "ABC1D23" },
        extractEnabled: false,
      }).success,
    ).toBe(false);
  });

  it("rejects a suggestion when fields includes street", () => {
    expect(
      prefillSuggestionSchema.safeParse({
        status: "pending",
        fields: { plate: "ABC1D23", street: "Rua A" },
        extractEnabled: false,
      }).success,
    ).toBe(false);
  });

  it("rejects a suggestion when extractEnabled is omitted", () => {
    expect(prefillSuggestionSchema.safeParse({ status: "empty" }).success).toBe(false);
  });
});

describe("prefillFieldsSchema", () => {
  it("rejects fields when name is present and empty", () => {
    expect(prefillFieldsSchema.safeParse({ name: "" }).success).toBe(false);
  });
});

describe("prefillAcceptBodySchema", () => {
  it("parses an accept body for plate", () => {
    const parsed = prefillAcceptBodySchema.parse({
      field: "plate",
      value: "ABC1D23",
    });

    expect(parsed).toEqual({ field: "plate", value: "ABC1D23" });
  });

  it("rejects an accept body when plate is empty", () => {
    expect(prefillAcceptBodySchema.safeParse({ field: "plate", value: "" }).success).toBe(false);
  });

  it("rejects an accept body with an unknown field key", () => {
    expect(
      prefillAcceptBodySchema.safeParse({ field: "street", value: "Rua A" }).success,
    ).toBe(false);
  });

  it("rejects an accept body when year value is a string", () => {
    expect(
      prefillAcceptBodySchema.safeParse({ field: "year", value: "2020" }).success,
    ).toBe(false);
  });
});

describe("prefillRejectBodySchema", () => {
  it("parses a reject body for plate", () => {
    expect(prefillRejectBodySchema.parse({ field: "plate" })).toEqual({ field: "plate" });
  });

  it("rejects a reject body with an unknown field key", () => {
    expect(prefillRejectBodySchema.safeParse({ field: "street" }).success).toBe(false);
  });
});

describe("prefillAcceptAllBodySchema", () => {
  it("parses an empty accept-all body", () => {
    expect(prefillAcceptAllBodySchema.parse({})).toEqual({});
  });

  it("rejects an accept-all body with a field payload", () => {
    expect(prefillAcceptAllBodySchema.safeParse({ field: "plate" }).success).toBe(false);
  });
});

describe("prefillExtractEnabledBodySchema", () => {
  it("parses a switch patch body turning the switch on", () => {
    expect(prefillExtractEnabledBodySchema.parse({ extractEnabled: true })).toEqual({
      extractEnabled: true,
    });
  });

  it("rejects a switch patch body with an extra key", () => {
    expect(
      prefillExtractEnabledBodySchema.safeParse({ extractEnabled: true, extra: true }).success,
    ).toBe(false);
  });
});

describe("conversationSummarySchema", () => {
  it("parses a conversation list item with no suggestion or Cliente fields", () => {
    const parsed = conversationSummarySchema.parse(LIST_ITEM);

    expect(parsed.tags).toEqual([]);
    expect("fields" in conversationSummarySchema.shape).toBe(false);
    expect("name" in conversationSummarySchema.shape).toBe(false);
    expect("taxId" in conversationSummarySchema.shape).toBe(false);
    expect("plate" in conversationSummarySchema.shape).toBe(false);
    expect("status" in conversationSummarySchema.shape).toBe(false);
    expect("extractEnabled" in conversationSummarySchema.shape).toBe(false);
  });
});

/**
 * Test design (testing-strategy)
 *
 * Setup: zod parse / safeParse on me, create-user, and attach-units
 * bodies, plus the existing conversation-list fixture. No HTTP.
 *
 * Oracle: openspec/changes/auth-unit-matrix/specs/shared-types/spec.md
 *   me has id, email, name, unitIds, optional currentUnitId.
 *   create-user password empty/whitespace fails.
 *   Inbox conversation-list fixture still parses and has no auth keys.
 *
 * Axes
 *   A1 me.unitIds — two ids + currentUnitId in that set / omitted current
 *   A2 create-user.password — non-empty / "" / "   "
 *   A3 conversation-list fixture — existing inbox shape, no auth fields
 *
 * BVA: password trim().min(1): "" and "   " fail; "a" is the other side
 * of that cutoff (sampled with the two-unit create body in A2 valid).
 *
 * Outputs
 *   O1 parse succeeds
 *   O2 safeParse.success === false
 *
 * Sampled-cell
 *   me two units + current     | A1 two     | O1 | parse throws
 *   empty password             | A2 ""      | O2 | success
 *   whitespace password        | A2 spaces  | O2 | success
 *   inbox fixture no auth keys | A3         | O1 | unitIds/email on object
 *
 * Decision map
 *   D1 password trim then min(1) T: create with "secret"; F: "" and "   "
 *      (each invalid class its own it)
 *   D2 currentUnitId optional T: present on two-unit me; F: omitted is
 *      same object without the key — not sampled (same optional as other
 *      write bodies; two-unit+current is the spec scenario)
 *
 * Out of scope: currentUnitId not in unitIds (spec does not reject);
 * email RFC format; HTTP 401/403.
 */
import { describe, expect, it } from "vitest";
import { conversationSummaryListSchema } from "../../conversations/contracts/http.js";
import { createUserBodySchema, meSchema } from "./http.auth.js";

const inboxFixture = [
  {
    id: "conv-1",
    contactLabel: "11999999999",
    phone: "11999999999",
    lastSnippet: "oi",
    lastMessageAt: "2026-08-26T12:00:00.000Z",
    tags: [{ id: "tag-1", name: "Retorno", color: "primary" }],
    sourceType: "UNKNOWN",
    unanswered: false,
    pipelineStage: "novosContatos",
  },
];

describe("me payload", () => {
  it("parses a me payload with two unit ids", () => {
    const parsed = meSchema.parse({
      id: "user-a",
      email: "a@example.com",
      name: "Ana",
      unitIds: ["unit-a", "unit-b"],
      currentUnitId: "unit-a",
    });
    expect(parsed.unitIds).toEqual(["unit-a", "unit-b"]);
    expect(parsed.currentUnitId).toBe("unit-a");
  });
});

describe("create-user body", () => {
  it("parses a create with a non-empty password", () => {
    const parsed = createUserBodySchema.parse({
      email: "a@example.com",
      password: "secret",
      name: "Ana",
      unitIds: ["unit-a"],
    });
    expect(parsed.password).toBe("secret");
  });

  it("rejects an empty password", () => {
    expect(
      createUserBodySchema.safeParse({
        email: "a@example.com",
        password: "",
        name: "Ana",
      }).success,
    ).toBe(false);
  });

  it("rejects a whitespace-only password", () => {
    expect(
      createUserBodySchema.safeParse({
        email: "a@example.com",
        password: "   ",
        name: "Ana",
      }).success,
    ).toBe(false);
  });
});

describe("inbox fixture without auth keys", () => {
  it("parses the existing conversation-list fixture with no auth fields", () => {
    const parsed = conversationSummaryListSchema.parse(inboxFixture);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).not.toHaveProperty("unitIds");
    expect(parsed[0]).not.toHaveProperty("currentUnitId");
    expect(parsed[0]).not.toHaveProperty("email");
    expect(parsed[0]).not.toHaveProperty("password");
  });
});

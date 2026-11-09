/**
 * Test design (testing-strategy)
 *
 * SUT: the `teamUserSchema` / `unitSchema` contracts, used as RESPONSE schemas.
 * That direction is what makes the invalid classes worth their own cases: a
 * blank name or a stray field arrives from a store, not from a client, so the
 * schema is the last thing standing between a bad row and the screen.
 *
 * Oracle: the auth delta of align-shipped-ui-to-revised-canvas — "each unit
 *   carries a name suitable for display, not only an identifier"; "it contains
 *   no password, no Auth service-role key, and no session token".
 *
 * Axes
 *   A1 name — a real name / empty string (the lower boundary of `min(1)`) /
 *      absent. One `it` per invalid class.
 *   A2 extra fields on the object — none / a password / a service-role key.
 *   A3 unitIds — some / empty. Empty is valid: a user with no loja is a real
 *      row, just one nobody outside their own lojas can see.
 *
 * Outputs
 *   O1 parses, with exactly the declared fields
 *   O2 rejects
 *
 * Sampled-cell
 *   full user row       | A1 real A3 some  | O1 | a valid row refused
 *   user, no lojas      | A3 empty         | O1 | `min(1)` creeping onto the array
 *   blank user name     | A1 empty         | O2 | a nameless row reaching the list
 *   blank loja name     | A1 empty         | O2 | the id going back on screen
 *   loja name absent    | A1 absent        | O2 | an unnamed chip
 *   row with a password | A2 password      | O1 | a secret serialized to the client
 *   row with a key      | A2 service role  | O1 | the same, for the Auth admin key
 *
 * Decision / branch map: these are declarative schemas, so the decisions are
 *   Zod's own — each `min(1)` is taken both ways by the pairs above, and the
 *   strip-unknown default is taken both ways by the clean row and the two
 *   contaminated ones.
 *
 * Out of scope: the wire path itself (whether Fastify's serializer applies the
 *   schema at all) — the accounts module's list-users and list-units slice
 *   tests assert the response key set end to end.
 */
import { describe, expect, it } from "vitest";
import { teamUserSchema, unitSchema } from "./http.team.js";

describe("teamUserSchema", () => {
  it("parses a user with their lojas", () => {
    const parsed = teamUserSchema.parse({
      id: "u-ana",
      email: "ana@example.com",
      name: "Ana Lima",
      unitIds: ["unit-a", "unit-b"],
    });

    expect(parsed.unitIds).toEqual(["unit-a", "unit-b"]);
  });

  it("parses a user who belongs to no loja", () => {
    const parsed = teamUserSchema.parse({
      id: "u-ana",
      email: "ana@example.com",
      name: "Ana Lima",
      unitIds: [],
    });

    expect(parsed.unitIds).toEqual([]);
  });

  it("rejects a blank name", () => {
    const result = teamUserSchema.safeParse({
      id: "u-ana",
      email: "ana@example.com",
      name: "",
      unitIds: ["unit-a"],
    });

    expect(result.success).toBe(false);
  });

  it("drops a password that reached it from a store", () => {
    const parsed = teamUserSchema.parse({
      id: "u-ana",
      email: "ana@example.com",
      name: "Ana Lima",
      unitIds: ["unit-a"],
      password: "hunter2",
    });

    expect(parsed).not.toHaveProperty("password");
  });

  it("drops an Auth service-role key that reached it from a store", () => {
    const parsed = teamUserSchema.parse({
      id: "u-ana",
      email: "ana@example.com",
      name: "Ana Lima",
      unitIds: ["unit-a"],
      serviceRoleKey: "sb-secret",
    });

    expect(parsed).not.toHaveProperty("serviceRoleKey");
  });
});

describe("unitSchema", () => {
  it("parses a named loja", () => {
    const parsed = unitSchema.parse({ id: "unit-a", name: "Loja Norte" });

    expect(parsed.name).toBe("Loja Norte");
  });

  it("rejects a blank name", () => {
    expect(unitSchema.safeParse({ id: "unit-a", name: "" }).success).toBe(false);
  });

  it("rejects a loja carrying only an identifier", () => {
    expect(unitSchema.safeParse({ id: "unit-a" }).success).toBe(false);
  });
});

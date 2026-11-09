/**
 * Test design (testing-strategy)
 *
 * Setup: zod parse / safeParse. No HTTP.
 *
 * Oracle: openspec/changes/crm-n-vehicles/specs/shared-types/spec.md
 * (vehicle write payloads + conversation GET wrapper).
 *
 * Axis 6 — Contract parse (design.md)
 *   EP valid: empty create {}; field-edit { plate }; conversation GET
 *     { customerId: null, vehicles: [] }
 *   EP invalid: year 2020.5 (not an integer) — own `it`
 *   ConversationSummary stays without customerId / vehicles (index.test P2)
 *
 * Outputs: O1 parse success; O2 safeParse fails
 *
 * Sampled-cell
 *   empty create {}                         | O1 | throws
 *   field-edit { plate }                    | O1 | throws
 *   conversation GET null customer          | O1 | throws
 *   year 2020.5 on field-edit               | O2 | success
 *   create body with id is stripped/fails   | —  | id kept as required
 *     (zod object strips unknown `id`; sampled as parse success without id)
 *   create plateSourcedKeys make+model      | O1 | throws
 *   field-edit plateSourcedKeys ["plate"]   | O2 | success
 *
 * Added (align-shipped-ui-to-pdf-artboards retrofit): each of
 *   vehicleCreateBodySchema and vehicleFieldEditSchema had only one
 *   direction of plateSourcedKeys sampled (create: accept only; field-edit:
 *   reject only) — plateSourcedFieldKeySchema's own bidirectional sample
 *   lives in plate-lookup.test.ts; these two close the missing direction on
 *   each integration point.
 *   field-edit plateSourcedKeys ["make"]    | O1 | throws (was untested)
 *   create plateSourcedKeys ["plate"]       | O2 | success (was untested)
 *
 * Added (Session 7's omitted-vs-null finding, vehicle-plate.ts): a PATCH
 *   that started omitting blanks instead of sending explicit null would
 *   silently discard an attendant clearing a field. That distinction is
 *   this schema's job to preserve, since every field-edit key is
 *   `.nullable().optional()`. Pinned directly rather than trusted from the
 *   `.optional()` behaviour `conversation list item stays without cadastro
 *   keys` below already demonstrates for a different schema.
 *   field-edit {} (all omitted)             | — | no key present (no opinion)
 *   field-edit { plate: null } (explicit)   | — | key present, value null
 *
 * Decision map: year .int() T integer/null/omit; F 2020.5
 *
 * Out of scope: HTTP 404/409; extra-car Omie isolation.
 */
import { describe, expect, it } from "vitest";
import { conversationSummarySchema } from "../../conversations/contracts/http.js";
import { conversationVehiclesSchema, vehicleCreateBodySchema, vehicleFieldEditSchema } from "./http.vehicle.js";

describe("vehicle write payloads", () => {
  it("parses an empty create-vehicle body", () => {
    expect(vehicleCreateBodySchema.parse({})).toEqual({});
  });

  it("parses a field-edit body with only plate", () => {
    expect(vehicleFieldEditSchema.parse({ plate: "ABC1D23" })).toEqual({ plate: "ABC1D23" });
  });

  it("parses a conversation-vehicles GET with a null customer", () => {
    expect(conversationVehiclesSchema.parse({ customerId: null, vehicles: [] })).toEqual({
      customerId: null,
      vehicles: [],
    });
  });

  it("rejects a non-integer year on a field-edit body", () => {
    expect(vehicleFieldEditSchema.safeParse({ year: 2020.5 }).success).toBe(false);
  });

  it("strips unknown id from a create body", () => {
    const parsed = vehicleCreateBodySchema.parse({ id: "veh-1", plate: "ABC1D23" });
    expect(parsed).toEqual({ plate: "ABC1D23" });
    expect("id" in parsed).toBe(false);
  });

  it("parses plateSourcedKeys on a create body", () => {
    expect(
      vehicleCreateBodySchema.parse({ make: "VW", plateSourcedKeys: ["make", "model"] }),
    ).toEqual({ make: "VW", plateSourcedKeys: ["make", "model"] });
  });

  it("rejects an unknown plateSourcedKeys entry on a field-edit body", () => {
    expect(
      vehicleFieldEditSchema.safeParse({ plateSourcedKeys: ["plate"] }).success,
    ).toBe(false);
  });

  it("rejects an unknown plateSourcedKeys entry on a create body", () => {
    expect(
      vehicleCreateBodySchema.safeParse({ plateSourcedKeys: ["odometerKm"] }).success,
    ).toBe(false);
  });

  it("parses plateSourcedKeys on a field-edit body", () => {
    expect(
      vehicleFieldEditSchema.parse({ make: "VW", plateSourcedKeys: ["make"] }),
    ).toEqual({ make: "VW", plateSourcedKeys: ["make"] });
  });

  it("omits a field-edit key entirely when the attendant expressed no opinion on it", () => {
    // The distinction a PATCH must preserve: an omitted key means "leave this
    // field alone," never sent by the caller — not "clear it," which is what
    // an explicit null means. Losing this at the schema layer would make the
    // two indistinguishable by the time cadastro applies the patch.
    const parsed = vehicleFieldEditSchema.parse({});
    expect(parsed).toEqual({});
    expect("plate" in parsed).toBe(false);
  });

  it("keeps an explicit null on a field-edit body distinct from omitting the key", () => {
    const parsed = vehicleFieldEditSchema.parse({ plate: null });
    expect("plate" in parsed).toBe(true);
    expect(parsed.plate).toBeNull();
  });
});

describe("conversation list item stays without cadastro keys", () => {
  it("parses an inbox list item without customerId or vehicles", () => {
    const parsed = conversationSummarySchema.parse({
      id: "conv-1",
      contactLabel: "11999999999",
      phone: "11999999999",
      lastSnippet: "oi",
      lastMessageAt: "2026-08-26T12:00:00.000Z",
      tags: [],
      sourceType: "UNKNOWN",
      unanswered: false,
      pipelineStage: "novosContatos",
    });
    expect("customerId" in parsed).toBe(false);
    expect("vehicles" in parsed).toBe(false);
  });
});

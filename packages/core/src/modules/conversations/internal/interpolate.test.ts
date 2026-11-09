/**
 * Test design (testing-strategy)
 *
 * Moved from apps/api/src/tags/interpolate.test.ts (4A), assertions unchanged. Pure;
 * module role: none.
 *
 * Setup: interpolateTemplate as a pure function. No HTTP, no store.
 *
 * Oracle: tags-templates spec — Template insert does not send.
 *   {{nome_cliente}} replaced with display name when present;
 *   {{placa}} replaced with titular plate when present;
 *   missing values leave the {{…}} placeholder.
 *
 * Axes (design.md Axis 4)
 *   A1 nome_cliente — present "Ana" / missing null / empty ""
 *   A2 placa — present "ABC1D23" / missing null
 *
 * Outputs
 *   O1 both placeholders substituted
 *   O2 {{nome_cliente}} remains
 *   O3 {{placa}} remains
 *
 * Sampled-cell
 *   both present     | A1 Ana A2 plate | O1 | leftover {{
 *   missing name     | A1 null A2 plate | O2 | name wiped
 *   missing plate    | A1 Ana A2 null | O3 | plate invented
 *   empty name       | A1 ""  A2 plate | O2 | treated as present
 *
 * Decision map (interpolate.ts)
 *   D1 if (nome_cliente) T: both-present / missing-plate; F: null and ""
 *   D2 if (placa) T: both-present / missing-name; F: missing-plate
 *
 * Out of scope: HTTP preview route (tags.test.ts); outbox side effects.
 */
import { describe, expect, it } from "vitest";
import { interpolateTemplate } from "./interpolate.js";

const body = "Ola {{nome_cliente}}, placa {{placa}}";

describe("interpolateTemplate", () => {
  it("substitutes both placeholders when name and plate are present", () => {
    expect(
      interpolateTemplate(body, { nome_cliente: "Ana", placa: "ABC1D23" }),
    ).toBe("Ola Ana, placa ABC1D23");
  });

  it("leaves {{nome_cliente}} when the name is missing", () => {
    expect(
      interpolateTemplate(body, { nome_cliente: null, placa: "ABC1D23" }),
    ).toBe("Ola {{nome_cliente}}, placa ABC1D23");
  });

  it("leaves {{placa}} when the plate is missing", () => {
    expect(
      interpolateTemplate(body, { nome_cliente: "Ana", placa: null }),
    ).toBe("Ola Ana, placa {{placa}}");
  });

  it("treats an empty name as missing", () => {
    expect(
      interpolateTemplate(body, { nome_cliente: "", placa: "ABC1D23" }),
    ).toBe("Ola {{nome_cliente}}, placa ABC1D23");
  });
});

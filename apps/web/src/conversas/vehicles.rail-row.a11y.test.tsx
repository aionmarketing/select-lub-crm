/**
 * Test design (testing-strategy)
 *
 * Setup: each build-time variant's `VehicleRailRow` rendered directly, with no
 * providers. The row needs none, and importing the two concrete modules rather
 * than the `UI_VARIANT` switch is deliberate: the defect existed in BOTH files,
 * so a test that exercised only the active variant would let the other rot.
 *
 * Oracle: found by the exploratory tour of 2026-09-10 —
 * `apps/e2e/test/tours/runs/2026-09-10-conversas-cadastro.md` (finding 4),
 * rolled up as **D3**. External standard: WCAG 2.5.3 *Label in Name* — the
 * accessible name must contain the text presented visually.
 *
 * THE DEFECT, now fixed. The row renders its plate as the visible label
 * (`ABC1D23 ›`) but carried `aria-label={`Ver ${drillLabel}`}`, computing to
 * `"Ver Volkswagen Gol 2019"`. An `aria-label` REPLACES the element's text for
 * name computation, so the plate — the field that tells one of a customer's
 * cars from another — was absent from the accessible name entirely. A
 * screen-reader user heard only make/model/year, ambiguous between two
 * same-model cars; a speech-input user saying "Ver ABC1D23" could not activate
 * the row at all.
 *
 * THE FIX, and why this shape rather than a better label. It was held open
 * because no scenario in `conversas` or `design-system` said what the name
 * should be, and inventing wording inside a testing change would have been
 * inventing the requirement. The owner's decision on 2026-09-12 was to remove
 * the `aria-label` outright rather than reword it, which is the option that
 * needs no new wording at all: with the override gone the name falls back to
 * the visible text, so the two can no longer drift apart. The chevron stays
 * `aria-hidden` and contributes nothing.
 *
 * Axes
 *   A1 UI variant — cursor / antigravity
 *   A2 vehicle identity — plate present / plate absent (unidentified vehicle)
 *
 * Outputs
 *   O1 accessible name of the drill-in control contains the visible plate
 *   O2 the name is not the old make/model/year-only string
 *
 * Sampled-cell
 *   cursor + plate      | A1 cursor, A2 present | O1,O2 | name omitted the plate
 *   antigravity + plate | A1 antigravity, A2 present | O1,O2 | same, second file
 *   plate absent        | A2 absent             | O1    | an empty or "undefined" name
 *
 * Out of scope: the row's other controls (`Editar veículo`, `Montar orçamento`),
 * whose names are unambiguous, and `schedule.tsx`, which has an `aria-label` of
 * the same shape on a different control that no tour has examined.
 */
import type { Vehicle } from "@select-lub/shared-types";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { VehicleRailRow as VehicleRailRowAntigravity } from "./vehicles.rail-row.antigravity.js";
import { VehicleRailRow as VehicleRailRowCursor } from "./vehicles.rail-row.cursor.js";

const PLATE = "ABC1D23";

const VEHICLE: Vehicle = {
  id: "veh-1",
  customerId: "cus-1",
  plate: PLATE,
  make: "Volkswagen",
  model: "Gol",
  year: 2019,
} as Vehicle;

const VARIANTS = [
  { name: "cursor", Row: VehicleRailRowCursor },
  { name: "antigravity", Row: VehicleRailRowAntigravity },
] as const;

/** Renders one variant's row with inert handlers; only the naming matters here. */
function renderRow(Row: (typeof VARIANTS)[number]["Row"], vehicle: Vehicle) {
  return render(
    <Row
      vehicle={vehicle}
      pendings={[]}
      editing={false}
      busy={false}
      onOpenDrillIn={() => {}}
      onMontarOrcamento={() => {}}
      onStartEdit={() => {}}
      onSave={() => {}}
      onResolve={() => {}}
    />,
  );
}

describe("vehicle rail row accessible name", () => {
  it.each(VARIANTS)(
    "$name: the drill-in control is named with the plate it visibly shows",
    ({ Row }) => {
      renderRow(Row, VEHICLE);

      // `toContain`, not equality, on purpose: the requirement is that the
      // visible label is PART of the name, which leaves the variants free to
      // keep make/model/year alongside it — antigravity does, cursor does not.
      const drillIn = screen
        .getAllByRole("button")
        .find((button) => (button.textContent ?? "").includes(PLATE));
      expect(drillIn).toBeDefined();
      expect(drillIn).toHaveAccessibleName(expect.stringContaining(PLATE) as unknown as string);
    },
  );

  it.each(VARIANTS)("$name: no control is named for the vehicle without its plate", ({ Row }) => {
    renderRow(Row, VEHICLE);

    // The exact string the defect produced. Asserting its absence is what
    // stops a future `aria-label` quietly reintroducing the same shape —
    // "contains the plate" alone would still pass if someone added a SECOND
    // control named this way.
    expect(
      screen.queryByRole("button", { name: "Ver Volkswagen Gol 2019" }),
    ).not.toBeInTheDocument();
  });

  it.each(VARIANTS)("$name: a vehicle with no plate still has a non-empty name", ({ Row }) => {
    // The case the wording decision used to block. With no `aria-label` there
    // is nothing to decide: the fallback the row already renders becomes the
    // name, so this asserts only that it is not blank — an unnamed control is
    // worse than an imprecise one.
    renderRow(Row, { ...VEHICLE, plate: null } as Vehicle);

    const buttons = screen.getAllByRole("button");
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      expect(button).not.toHaveAccessibleName("");
    }
  });
});

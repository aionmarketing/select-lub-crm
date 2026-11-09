/**
 * Selects the vehicle rail row for the build-time UI variant.
 *
 * Only this row differs between the variants — the dialog, the drill-in and the
 * Omie copy in `vehicles.tsx` are shared, so the split is taken here rather
 * than around the whole module.
 */
import { UI_VARIANT } from "../uiVariant.js";
import { VehicleRailRow as VehicleRailRowAntigravity } from "./vehicles.rail-row.antigravity.js";
import { VehicleRailRow as VehicleRailRowCursor } from "./vehicles.rail-row.cursor.js";

/** The vehicle rail row of the active variant. */
export const VehicleRailRow =
  UI_VARIANT === "antigravity" ? VehicleRailRowAntigravity : VehicleRailRowCursor;

/**
 * The rail's "Pesquisando lubrificante…" line (background-oil-research D18).
 *
 * Shown under a vehicle while its identity's research is attended and not stopped, as the
 * server says through `vehicle.oilResearch` on the vehicle list the rail already polls — no
 * request of its own. Shared by both variants' rail rows and by the Veículo drill-in.
 *
 * - The icon is static and hidden from assistive technology: nothing animates, for days or
 *   against `prefers-reduced-motion`.
 * - It is not a live region: the quote dialog carries the announcement, and the rail repaints
 *   every 3 s.
 * - Callers place it OUTSIDE the drill-in button, so that button's accessible name stays the
 *   plate (WCAG 2.5.3).
 */
import Box from "@mui/material/Box";
import SvgIcon from "@mui/material/SvgIcon";
import type { Vehicle } from "@select-lub/shared-types";

/** The line's text, identical in both variants. */
export const VEHICLE_RESEARCH_LINE = "Pesquisando lubrificante…";

/**
 * Whether the rail shows the line for a vehicle. An `oilResearch` whose status this bundle does
 * not know already parses as absent (the contract's `.catch(undefined)`); the status check here
 * keeps that true for any value that reaches the component some other way.
 */
export function vehicleIsResearched(vehicle: Vehicle): boolean {
  return vehicle.oilResearch?.status === "researching";
}

/** The line, or nothing when the vehicle is not being researched. */
export function VehicleResearchLine({ vehicle }: { vehicle: Vehicle }) {
  if (!vehicleIsResearched(vehicle)) return null;
  return (
    <Box
      component="div"
      sx={{ display: "flex", alignItems: "center", gap: 0.75, typography: "caption", color: "tertiary" }}
    >
      <SvgIcon
        aria-hidden
        viewBox="0 0 24 24"
        sx={{ fontSize: 12, fill: "none", stroke: "currentColor", strokeWidth: 2 }}
      >
        <circle cx="11" cy="11" r="7" />
        <path d="M20 20l-4-4" />
      </SvgIcon>
      <span>{VEHICLE_RESEARCH_LINE}</span>
    </Box>
  );
}

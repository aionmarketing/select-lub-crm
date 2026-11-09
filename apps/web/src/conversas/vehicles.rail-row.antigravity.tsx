/**
 * Antigravity vehicle rail row — an outlined card.
 *
 * Imported from antigravity/redesign 7952305. The inline editor it opens is the
 * shared `VehicleRailEditor`, so only the row chrome is variant-specific.
 */
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Paper from "@mui/material/Paper";
import type {
  PendingResolveBody,
  ReconciliationPending,
  Vehicle,
  VehicleFieldEdit,
} from "@select-lub/shared-types";
import { joinDot, vehicleIdentity } from "./helpers.js";
import { TOUCH_TARGET_PX } from "../theme.js";
import { PendingFieldActions } from "./prefill.js";
import { VehicleRailEditor } from "./vehicle-rail-editor.js";
import { VehicleResearchLine } from "./vehicle-research-line.js";

export function VehicleRailRow({
  vehicle,
  pendings,
  editing,
  busy,
  onOpenDrillIn,
  onMontarOrcamento,
  onStartEdit,
  onSave,
  onResolve,
}: {
  vehicle: Vehicle;
  pendings: ReconciliationPending[];
  editing: boolean;
  busy: boolean;
  onOpenDrillIn: () => void;
  onMontarOrcamento: () => void;
  onStartEdit: () => void;
  onSave: (patch: VehicleFieldEdit) => void;
  onResolve: (body: PendingResolveBody) => void;
}) {
  const identity = vehicleIdentity(vehicle);
  const displayTitle =
    joinDot([identity, vehicle.plate]) || vehicle.plate || identity || "Sem placa";
  return (
    <Paper
      variant="outlined"
      sx={{
        p: 1,
        borderRadius: 1,
        borderColor: "divider",
        display: "flex",
        flexDirection: "column",
        gap: 0.75,
      }}
    >
      <Box
        sx={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}
      >
        {/* No `aria-label` — see the same decision in
            `vehicles.rail-row.cursor.tsx`. The accessible name is `displayTitle`,
            which already carries the plate, so it satisfies WCAG 2.5.3 Label in
            Name; the previous label replaced it with make/model/year and dropped
            the plate entirely. */}
        <Button
          size="small"
          onClick={onOpenDrillIn}
          sx={{
            p: 0,
            justifyContent: "space-between",
            textAlign: "left",
            textTransform: "none",
            color: "text.primary",
            fontWeight: 600,
            fontSize: "13px",
            flex: 1,
            "&:hover": { bgcolor: "transparent", textDecoration: "underline" },
          }}
        >
          <Box component="span">{displayTitle}</Box>
          <Box
            component="span"
            aria-hidden
            sx={{ opacity: 0.6, fontSize: "16px", pl: 0.5 }}
          >
            {"›"}
          </Box>
        </Button>
        {editing ? null : (
          <Button
            size="small"
            variant="text"
            onClick={onStartEdit}
            sx={{
              textTransform: "none",
              fontSize: "11px",
              // Antigravity drew this at 2px/6px padding. The accessibility
              // floor applies on every variant, so the box grows to 44px while
              // the label keeps the rail's compact type.
              px: 1,
              minWidth: TOUCH_TARGET_PX,
              minHeight: TOUCH_TARGET_PX,
              color: "text.secondary",
              ml: 1,
            }}
          >
            Editar veículo
          </Button>
        )}
      </Box>
      {/* Outside the drill-in button, so its name stays the title with the plate (D18). */}
      <VehicleResearchLine vehicle={vehicle} />
      {editing ? (
        <VehicleRailEditor vehicle={vehicle} busy={busy} onSave={onSave} />
      ) : (
        <Button
          size="small"
          variant="outlined"
          onClick={onMontarOrcamento}
          sx={{
            alignSelf: "flex-start",
            textTransform: "none",
            fontSize: "11px",
            borderRadius: 999,
            px: 1.5,
            minHeight: TOUCH_TARGET_PX,
            borderColor: "divider",
            color: "text.primary",
          }}
        >
          Montar orçamento
        </Button>
      )}
      {pendings.map((pending) => (
        <PendingFieldActions
          key={pending.fieldKey}
          pending={pending}
          busy={busy}
          onResolve={onResolve}
        />
      ))}
    </Paper>
  );
}

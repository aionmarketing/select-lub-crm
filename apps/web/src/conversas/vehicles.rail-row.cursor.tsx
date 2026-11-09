/**
 * Cursor vehicle rail row — the artboard's stacked row.
 */
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Stack from "@mui/material/Stack";
import type {
  PendingResolveBody,
  ReconciliationPending,
  Vehicle,
  VehicleFieldEdit,
} from "@select-lub/shared-types";
import { vehicleIdentity } from "./helpers.js";
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
  return (
    <Stack spacing={0.5}>
      <Stack
        direction="row"
        sx={{ alignItems: "center", justifyContent: "space-between" }}
      >
        {/* No `aria-label`. The button's accessible name is its visible text —
            the plate — because an `aria-label` REPLACES that text for name
            computation, and the one here read "Ver <make> <model> <year>". A
            screen-reader user never heard the plate the row leads with, and a
            speech-input user saying "Ver ABC1D23" could not activate it (WCAG
            2.5.3 Label in Name). Found by the exploratory tour of 2026-09-10,
            recorded as D3 in `apps/e2e/test/tours/runs/`. The chevron beside it
            stays `aria-hidden`, so it contributes nothing to the name. */}
        <Button size="small" onClick={onOpenDrillIn}>
          <Box component="span">{vehicle.plate ?? (identity || "Sem placa")}</Box>
          <Box component="span" aria-hidden>
            {" ›"}
          </Box>
        </Button>
        {editing ? null : (
          <Button size="small" variant="outlined" onClick={onStartEdit}>
            Editar veículo
          </Button>
        )}
      </Stack>
      {/* Outside the drill-in button, so its name stays the plate (D18). */}
      <VehicleResearchLine vehicle={vehicle} />
      {editing ? (
        <VehicleRailEditor vehicle={vehicle} busy={busy} onSave={onSave} />
      ) : (
        <Button size="small" variant="outlined" onClick={onMontarOrcamento}>
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
    </Stack>
  );
}

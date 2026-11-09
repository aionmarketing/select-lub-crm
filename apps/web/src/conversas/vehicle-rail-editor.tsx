/**
 * The inline plate/identity editor a vehicle rail row opens on "Editar veículo".
 *
 * Shared by both UI variants: the row around it is presentational and differs
 * per variant, but the draft state, the plate-sourced key bookkeeping and the
 * save patch are behaviour and must exist once.
 */
import Button from "@mui/material/Button";
import Stack from "@mui/material/Stack";
import { useState } from "react";
import type { Vehicle, VehicleFieldEdit } from "@select-lub/shared-types";
import { VehiclePlateFields } from "./vehicle-plate-fields.js";
import {
  draftFromVehicle,
  patchFromDraft,
  type IdentityFieldKey,
} from "./vehicle-plate.js";

export function VehicleRailEditor({
  vehicle,
  busy,
  onSave,
  autoFocusKey,
}: {
  vehicle: Vehicle;
  busy: boolean;
  onSave: (patch: VehicleFieldEdit) => void;
  /** The field focused on mount: the version, when the quote's "Corrigir versão do veículo" opened the form. */
  autoFocusKey?: "version";
}) {
  const [draft, setDraft] = useState(() => draftFromVehicle(vehicle));
  const [plateSourcedKeys, setPlateSourcedKeys] = useState<IdentityFieldKey[]>([
    ...vehicle.plateSourcedKeys,
  ]);
  const [changedKeys, setChangedKeys] = useState<IdentityFieldKey[]>([]);
  const [declinedSuggestionKeys, setDeclinedSuggestionKeys] = useState<
    IdentityFieldKey[]
  >([]);
  return (
    <Stack spacing={1}>
      <VehiclePlateFields
        draft={draft}
        onDraftChange={setDraft}
        storedPlate={vehicle.plate}
        plateSourcedKeys={plateSourcedKeys}
        onPlateSourcedKeysChange={setPlateSourcedKeys}
        changedKeys={changedKeys}
        onChangedKeysChange={setChangedKeys}
        declinedSuggestionKeys={declinedSuggestionKeys}
        onDeclinedSuggestionKeysChange={setDeclinedSuggestionKeys}
        disabled={busy}
        dense
        {...(autoFocusKey ? { autoFocusKey } : {})}
      />
      <Button
        size="small"
        variant="contained"
        disabled={busy}
        onClick={() => onSave(patchFromDraft(draft, plateSourcedKeys))}
      >
        Salvar veículo
      </Button>
    </Stack>
  );
}

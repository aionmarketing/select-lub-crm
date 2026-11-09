/**
 * Vehicle list rows, the Adicionar veículo dialog, and the Veículo drill-in on
 * the Conversas rail.
 */
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Paper from "@mui/material/Paper";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { Vehicle, VehicleCreateBody, VehicleFieldEdit } from "@select-lub/shared-types";
import { fetchVehicleServices } from "../api.js";
import {
  formatAmount,
  formatOdometer,
  formatPerformedAt,
  joinDot,
  vehicleIdentity,
} from "./helpers.js";
import { VehiclePlateFields } from "./vehicle-plate-fields.js";
import { VehicleRailEditor } from "./vehicle-rail-editor.js";
import { VehicleResearchLine } from "./vehicle-research-line.js";
import {
  createBodyFromDraft,
  emptyVehicleDraft,
  type IdentityFieldKey,
} from "./vehicle-plate.js";

export { VehicleRailRow } from "./vehicles.rail-row.js";

/**
 * What the Adicionar veículo dialog says about the Omie while GitHub #29 is
 * open. It is deliberately not a promise: `Vehicle.omieId` exists on the model
 * but the field-level mapping to the Omie is a guess, so the dialog claims only
 * the write it can actually make.
 */
export const VEHICLE_OMIE_UNCONFIRMED =
  "O espelhamento de veículo no Omie ainda não foi confirmado (GitHub #29). O veículo é gravado no CRM.";

/**
 * Adicionar veículo — the destination the rail's create control opens.
 *
 * A creation flow, so a dialog rather than a rail view (design D4): it is a
 * short form that ends, and nothing in the conversation needs to stay readable
 * while it is filled in. Plate lookup fills identity as suggestions; nothing
 * is written to cadastro until Salvar veículo.
 *
 * @param customerName - Cliente the vehicle is being added to, shown so the operator can see whose car this is
 * @param busy - True while the create request is in flight
 * @param failed - True when the last create attempt errored, so the dialog can say so in Portuguese
 * @param onSave - Receives the create body built from the six typeable fields
 * @param onClose - Dismisses the dialog without creating anything
 */
export function AddVehicleDialog({
  customerName,
  busy,
  failed,
  onSave,
  onClose,
}: {
  customerName: string;
  busy: boolean;
  failed: boolean;
  onSave: (body: VehicleCreateBody) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(emptyVehicleDraft);
  const [plateSourcedKeys, setPlateSourcedKeys] = useState<IdentityFieldKey[]>([]);
  const [changedKeys, setChangedKeys] = useState<IdentityFieldKey[]>([]);
  const [declinedSuggestionKeys, setDeclinedSuggestionKeys] = useState<
    IdentityFieldKey[]
  >([]);
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>Adicionar veículo</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Typography variant="body2" color="text.secondary">
            {customerName}
          </Typography>
          <VehiclePlateFields
            draft={draft}
            onDraftChange={setDraft}
            storedPlate={null}
            plateSourcedKeys={plateSourcedKeys}
            onPlateSourcedKeysChange={setPlateSourcedKeys}
            changedKeys={changedKeys}
            onChangedKeysChange={setChangedKeys}
            declinedSuggestionKeys={declinedSuggestionKeys}
            onDeclinedSuggestionKeysChange={setDeclinedSuggestionKeys}
            disabled={busy}
          />
          <Alert severity="warning">{VEHICLE_OMIE_UNCONFIRMED}</Alert>
          {failed ? (
            <Alert severity="error">Não foi possível salvar o veículo</Alert>
          ) : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancelar</Button>
        <Button
          variant="contained"
          disabled={busy}
          onClick={() =>
            onSave(createBodyFromDraft(draft, plateSourcedKeys, declinedSuggestionKeys))
          }
        >
          Salvar veículo
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/**
 * The Veículo drill-in: the vehicle's details and its service history.
 *
 * @param vehicle - The vehicle as it was when the attendant opened the drill-in.
 * @param vehicles - The rail's polled vehicle list. The drill-in reads its vehicle from it by id,
 * so a poll that ends the research drops "Pesquisando lubrificante…" here too (D18); the snapshot
 * is only the fallback while the list does not hold it.
 * @param onBack - Returns to the rail stack.
 */
export function VehicleDrillIn({
  vehicle: snapshot,
  vehicles,
  onBack,
  edit,
}: {
  vehicle: Vehicle;
  vehicles?: readonly Vehicle[];
  onBack: () => void;
  /**
   * The vehicle's form, open in the drill-in with the version focused: how the quote's
   * "Corrigir versão do veículo" lands (background-oil-research D24; conversas "Correcting the
   * version opens the form"). The save is the rail's own vehicle update.
   */
  edit?: { busy: boolean; onSave: (patch: VehicleFieldEdit) => void };
}) {
  const vehicle = vehicles?.find((row) => row.id === snapshot.id) ?? snapshot;
  const query = useQuery({
    queryKey: ["vehicle-services", vehicle.id],
    queryFn: () => fetchVehicleServices(vehicle.id),
  });
  const title = joinDot([vehicleIdentity(vehicle), vehicle.plate]);
  const rows = query.data ?? [];
  return (
    <Stack spacing={2} component="section" aria-label="Veículo">
      <Stack direction="row" sx={{ alignItems: "center", gap: 1 }}>
        <Button size="small" onClick={onBack}>
          ← Voltar
        </Button>
        <Typography variant="subtitle1">{title || "Veículo"}</Typography>
      </Stack>
      <VehicleResearchLine vehicle={vehicle} />
      {edit ? (
        <VehicleRailEditor vehicle={vehicle} busy={edit.busy} onSave={edit.onSave} autoFocusKey="version" />
      ) : null}
      {query.isLoading ? (
        <Stack spacing={1} role="status">
          <Skeleton variant="rounded" height={48} />
          <Typography>Carregando veículo</Typography>
        </Stack>
      ) : query.isError ? (
        <Stack spacing={1}>
          <Alert severity="error">
            Não foi possível carregar os dados deste veículo
          </Alert>
          <Button variant="contained" onClick={() => void query.refetch()}>
            Tentar de novo
          </Button>
        </Stack>
      ) : (
        <>
          {vehicle.odometerKm != null ? (
            <Stack>
              <Typography variant="caption" color="text.secondary">
                Quilometragem atual
              </Typography>
              <Typography sx={{ fontWeight: 600 }}>
                {formatOdometer(vehicle.odometerKm)}
              </Typography>
            </Stack>
          ) : null}
          {vehicle.year != null ? (
            <Stack>
              <Typography variant="caption" color="text.secondary">
                Ano
              </Typography>
              <Typography sx={{ fontWeight: 600 }}>{vehicle.year}</Typography>
            </Stack>
          ) : null}
          {vehicle.plate ? (
            <Stack>
              <Typography variant="caption" color="text.secondary">
                Placa
              </Typography>
              <Typography sx={{ fontWeight: 600 }}>{vehicle.plate}</Typography>
            </Stack>
          ) : null}
          <Typography variant="subtitle2">Histórico de serviços</Typography>
          {rows.length === 0 ? (
            <Typography>Nenhum serviço registrado para este veículo</Typography>
          ) : (
            rows.map((service) => (
              <Paper key={service.id} variant="outlined" sx={{ p: 1, borderRadius: 1 }}>
                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                  {joinDot([
                    formatPerformedAt(service.performedAt),
                    service.description ?? service.kind,
                  ]) || "Serviço"}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {joinDot([
                    formatAmount(service.amount),
                    formatOdometer(service.odometerKm),
                  ])}
                </Typography>
              </Paper>
            ))
          )}
        </>
      )}
    </Stack>
  );
}

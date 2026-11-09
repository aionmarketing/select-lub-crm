/**
 * Shared plate + identity field stack for Adicionar veículo and the rail editor.
 *
 * Lookup runs on plate blur only. Cadastro is not written here — the parent
 * save control sends the draft.
 */
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControlLabel from "@mui/material/FormControlLabel";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useRef, useState } from "react";
import type { PlateLookupResponse, PlateSuggestionFields } from "@select-lub/shared-types";
import { lookupPlate } from "../api.js";
import { saoPauloDate } from "./helpers.js";
import {
  IDENTITY_FIELD_KEYS,
  IDENTITY_FIELD_LABELS,
  decideFoundLookup,
  identityFromDraft,
  overwriteFromSuggestion,
  parsePlate,
  shouldLookupOnPlateBlur,
  suggestionAsDraft,
  type IdentityFieldKey,
  type VehicleFormDraft,
} from "./vehicle-plate.js";

type LookupBanner =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "not_found"; lookedUpAt?: string; recordedOutcome?: "miss" }
  | { kind: "failed"; reason: "provider_error" | "exhausted_balance" | "not_configured" };

function bannerFromResponse(response: PlateLookupResponse): LookupBanner {
  if (response.status === "unavailable") {
    return { kind: "unavailable" };
  }
  if (response.status === "failed") {
    return { kind: "failed", reason: response.reason };
  }
  if (response.status === "not_found") {
    return {
      kind: "not_found",
      lookedUpAt: response.lookedUpAt,
      recordedOutcome: response.recordedOutcome,
    };
  }
  return { kind: "idle" };
}

function failedCopy(reason: "provider_error" | "exhausted_balance" | "not_configured"): string {
  if (reason === "exhausted_balance") {
    return "Saldo da consulta de placa esgotado. Preencha os dados à mão.";
  }
  return "Não foi possível consultar a placa. Tente de novo ou preencha os dados à mão.";
}

/**
 * Plate, identity, and odometer fields with blur lookup and the confirmation dialogs.
 *
 * @param draft - Current typed values.
 * @param onDraftChange - Replaces the draft; lookup fills identity through this callback.
 * @param storedPlate - Saved plate when editing, or `null` when creating.
 * @param plateSourcedKeys - Keys still marked plate-sourced in this visit.
 * @param onPlateSourcedKeysChange - Replaces the mark list.
 * @param changedKeys - Keys last overwritten, for the "Atualizado pela placa" hint.
 * @param onChangedKeysChange - Replaces the changed-key list.
 * @param declinedSuggestionKeys - Suggestion keys the attendant unchecked.
 * @param onDeclinedSuggestionKeysChange - Replaces the declined list.
 * @param disabled - True while the parent save is in flight.
 * @param dense - Tighter stack for the rail editor.
 */
export function VehiclePlateFields({
  draft,
  onDraftChange,
  storedPlate,
  plateSourcedKeys,
  onPlateSourcedKeysChange,
  changedKeys,
  onChangedKeysChange,
  declinedSuggestionKeys,
  onDeclinedSuggestionKeysChange,
  disabled,
  dense = false,
  autoFocusKey,
}: {
  /**
   * The identity field focused when the form mounts: the quote's "Corrigir versão do veículo"
   * opens the form on the version (background-oil-research D24).
   */
  autoFocusKey?: "version";
  draft: VehicleFormDraft;
  onDraftChange: (next: VehicleFormDraft) => void;
  storedPlate: string | null;
  plateSourcedKeys: IdentityFieldKey[];
  onPlateSourcedKeysChange: (next: IdentityFieldKey[]) => void;
  changedKeys: IdentityFieldKey[];
  onChangedKeysChange: (next: IdentityFieldKey[]) => void;
  declinedSuggestionKeys: IdentityFieldKey[];
  onDeclinedSuggestionKeysChange: (next: IdentityFieldKey[]) => void;
  disabled: boolean;
  dense?: boolean;
}) {
  const [banner, setBanner] = useState<LookupBanner>({ kind: "idle" });
  const [lastCompleted, setLastCompleted] = useState<{
    plate: string;
    status: "found" | "not_found" | "failed" | "unavailable";
  } | null>(null);
  const [lastSuggestion, setLastSuggestion] = useState<PlateSuggestionFields | null>(null);
  const [overwrite, setOverwrite] = useState<{
    plate: string;
    suggestion: Record<IdentityFieldKey, string>;
    changing: IdentityFieldKey[];
    fields: PlateSuggestionFields;
  } | null>(null);
  const [warn, setWarn] = useState<{ key: IdentityFieldKey; value: string } | null>(null);
  const [retryOpen, setRetryOpen] = useState(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const sourced = new Set(plateSourcedKeys);
  const changed = new Set(changedKeys);
  const declined = new Set(declinedSuggestionKeys);
  const storedNormalized = storedPlate ? parsePlate(storedPlate) : null;
  const suggestionKeys = lastSuggestion
    ? IDENTITY_FIELD_KEYS.filter((key) => suggestionAsDraft(lastSuggestion)[key] !== "")
    : [];

  async function runLookup(plate: string, retry: boolean) {
    setBanner({ kind: "loading" });
    try {
      const response = await lookupPlate(plate, retry ? { retry: true } : undefined);
      const status = response.status === "found" ? "found" : response.status;
      setLastCompleted({ plate, status });
      if (response.status !== "found") {
        onPlateSourcedKeysChange([]);
        onChangedKeysChange([]);
        setLastSuggestion(null);
        setBanner(bannerFromResponse(response));
        return;
      }
      setBanner({ kind: "idle" });
      const current = draftRef.current;
      const decision = decideFoundLookup(identityFromDraft(current), response.fields);
      if (decision.action === "noop") {
        return;
      }
      if (decision.action === "silent-fill") {
        setLastSuggestion(response.fields);
        onDraftChange({ ...current, ...decision.next });
        onPlateSourcedKeysChange(decision.sourcedKeys);
        onChangedKeysChange(decision.changedKeys);
        onDeclinedSuggestionKeysChange([]);
        return;
      }
      setOverwrite({
        plate,
        suggestion: decision.suggestion,
        changing: decision.changing,
        fields: response.fields,
      });
    } catch {
      setLastCompleted({ plate, status: "failed" });
      onPlateSourcedKeysChange([]);
      onChangedKeysChange([]);
      setBanner({ kind: "failed", reason: "provider_error" });
    }
  }

  function requestIdentityChange(key: IdentityFieldKey, value: string) {
    if (sourced.has(key) && value !== draft[key]) {
      setWarn({ key, value });
      return;
    }
    onDraftChange({ ...draft, [key]: value });
    if (declined.has(key) && value.trim() !== "") {
      onDeclinedSuggestionKeysChange(declinedSuggestionKeys.filter((item) => item !== key));
    }
  }

  const gap = dense ? 1 : 2;
  return (
    <Stack spacing={gap}>
      <TextField
        size="small"
        fullWidth
        label="Placa"
        value={draft.plate}
        disabled={disabled || banner.kind === "loading"}
        onChange={(event) => onDraftChange({ ...draft, plate: event.target.value })}
        onBlur={() => {
          const plate = shouldLookupOnPlateBlur(draft.plate, storedNormalized, lastCompleted);
          if (!plate) {
            return;
          }
          void runLookup(plate, false);
        }}
      />
      {banner.kind === "loading" ? (
        <Typography variant="body2" color="text.secondary" role="status">
          Consultando placa…
        </Typography>
      ) : null}
      {banner.kind === "unavailable" ? (
        <Alert severity="info">Consulta de placa indisponível. Preencha os dados à mão.</Alert>
      ) : null}
      {banner.kind === "not_found" ? (
        <Alert
          severity="warning"
          action={
            <Button
              color="inherit"
              size="small"
              onClick={() => setRetryOpen(true)}
              disabled={disabled}
            >
              Consultar de novo
            </Button>
          }
        >
          A consulta não devolveu dados para esta placa.
        </Alert>
      ) : null}
      {banner.kind === "failed" ? (
        <Alert severity="error">{failedCopy(banner.reason)}</Alert>
      ) : null}
      <Stack direction="row" spacing={gap}>
        <IdentityField
          fieldKey="make"
          draft={draft}
          sourced={sourced}
          changed={changed}
          storedPlate={storedPlate}
          disabled={disabled || banner.kind === "loading"}
          onChange={requestIdentityChange}
        />
        <IdentityField
          fieldKey="model"
          draft={draft}
          sourced={sourced}
          changed={changed}
          storedPlate={storedPlate}
          disabled={disabled || banner.kind === "loading"}
          onChange={requestIdentityChange}
        />
      </Stack>
      <IdentityField
        fieldKey="version"
        autoFocus={autoFocusKey === "version"}
        draft={draft}
        sourced={sourced}
        changed={changed}
        storedPlate={storedPlate}
        disabled={disabled || banner.kind === "loading"}
        onChange={requestIdentityChange}
      />
      <Stack direction="row" spacing={gap}>
        <IdentityField
          fieldKey="year"
          draft={draft}
          sourced={sourced}
          changed={changed}
          storedPlate={storedPlate}
          disabled={disabled || banner.kind === "loading"}
          onChange={requestIdentityChange}
        />
        <TextField
          size="small"
          fullWidth
          label="Quilometragem atual"
          value={draft.odometerKm}
          disabled={disabled || banner.kind === "loading"}
          onChange={(event) => onDraftChange({ ...draft, odometerKm: event.target.value })}
        />
      </Stack>
      {suggestionKeys.length > 0 ? (
        <Stack>
          {suggestionKeys.map((key) => (
            <FormControlLabel
              key={key}
              control={
                <Checkbox
                  checked={!declined.has(key)}
                  disabled={disabled}
                  onChange={(event) => {
                    if (event.target.checked) {
                      const restored = lastSuggestion ? suggestionAsDraft(lastSuggestion)[key] : "";
                      onDeclinedSuggestionKeysChange(
                        declinedSuggestionKeys.filter((item) => item !== key),
                      );
                      onDraftChange({ ...draft, [key]: restored });
                      if (restored && !sourced.has(key)) {
                        onPlateSourcedKeysChange([...plateSourcedKeys, key]);
                      }
                      return;
                    }
                    onDeclinedSuggestionKeysChange([...declinedSuggestionKeys, key]);
                    onDraftChange({ ...draft, [key]: "" });
                    onPlateSourcedKeysChange(plateSourcedKeys.filter((item) => item !== key));
                    onChangedKeysChange(changedKeys.filter((item) => item !== key));
                  }}
                />
              }
              label={`Usar ${IDENTITY_FIELD_LABELS[key].toLowerCase()} da placa`}
            />
          ))}
        </Stack>
      ) : null}
      <Dialog open={overwrite != null} onClose={() => setOverwrite(null)} fullWidth maxWidth="xs">
        <DialogTitle>
          {overwrite
            ? `Substituir dados pela placa ${overwrite.plate}?`
            : "Substituir dados pela placa?"}
        </DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            Estes campos mudariam:{" "}
            {overwrite?.changing.map((key) => IDENTITY_FIELD_LABELS[key]).join(", ")}.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              onPlateSourcedKeysChange([]);
              onChangedKeysChange([]);
              setOverwrite(null);
            }}
          >
            Manter valores atuais
          </Button>
          <Button
            variant="contained"
            onClick={() => {
              if (!overwrite) {
                return;
              }
              const current = draftRef.current;
              const { sourcedKeys } = overwriteFromSuggestion(overwrite.suggestion);
              setLastSuggestion(overwrite.fields);
              onDraftChange({ ...current, ...overwrite.suggestion });
              onPlateSourcedKeysChange(sourcedKeys);
              onChangedKeysChange(overwrite.changing);
              onDeclinedSuggestionKeysChange([]);
              setOverwrite(null);
            }}
          >
            Substituir pelos dados da placa
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog open={warn != null} onClose={() => setWarn(null)} fullWidth maxWidth="xs">
        <DialogTitle>Valor veio da placa</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            Este valor veio da placa {storedPlate || draft.plate || "consultada"}. Confirme se está
            errado e verifique a placa também.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setWarn(null)}>Cancelar</Button>
          <Button
            variant="contained"
            onClick={() => {
              if (!warn) {
                return;
              }
              onDraftChange({ ...draft, [warn.key]: warn.value });
              onPlateSourcedKeysChange(plateSourcedKeys.filter((item) => item !== warn.key));
              onChangedKeysChange(changedKeys.filter((item) => item !== warn.key));
              setWarn(null);
            }}
          >
            Continuar edição
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog open={retryOpen} onClose={() => setRetryOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>Consultar a placa de novo?</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            A última consulta
            {banner.kind === "not_found" && banner.lookedUpAt
              ? `, em ${saoPauloDate.format(new Date(banner.lookedUpAt))},`
              : ""}{" "}
            registrou: sem dados utilizáveis. Consultar de novo gasta crédito.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRetryOpen(false)}>Cancelar</Button>
          <Button
            variant="contained"
            onClick={() => {
              setRetryOpen(false);
              const plate = parsePlate(draft.plate);
              if (!plate) {
                return;
              }
              void runLookup(plate, true);
            }}
          >
            Consultar de novo
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}

function IdentityField({
  fieldKey,
  draft,
  sourced,
  changed,
  storedPlate,
  disabled,
  onChange,
  autoFocus = false,
}: {
  fieldKey: IdentityFieldKey;
  draft: VehicleFormDraft;
  autoFocus?: boolean;
  sourced: Set<IdentityFieldKey>;
  changed: Set<IdentityFieldKey>;
  storedPlate: string | null;
  disabled: boolean;
  onChange: (key: IdentityFieldKey, value: string) => void;
}) {
  const isSourced = sourced.has(fieldKey);
  const isChanged = changed.has(fieldKey);
  let helper = " ";
  if (isChanged) {
    helper = "Atualizado pela placa";
  } else if (isSourced) {
    helper = storedPlate ? `Valor da placa ${storedPlate}` : "Valor da placa";
  }
  return (
    <TextField
      size="small"
      fullWidth
      label={IDENTITY_FIELD_LABELS[fieldKey]}
      value={draft[fieldKey]}
      disabled={disabled}
      autoFocus={autoFocus}
      onChange={(event) => onChange(fieldKey, event.target.value)}
      helperText={helper}
      sx={(theme) =>
        isSourced || isChanged ? { bgcolor: theme.palette.primaryContainer } : {}
      }
    />
  );
}

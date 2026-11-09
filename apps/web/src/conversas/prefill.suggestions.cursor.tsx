/**
 * Cursor assistive-suggestion rows — the ghost/disclosure pair on the rail.
 */
import Button from "@mui/material/Button";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useState } from "react";

/**
 * An assistive suggestion attached to the field it is about.
 *
 * Two shapes, because an empty field and an occupied one pose different
 * questions. Empty: the proposed value is shown directly, since there is
 * nothing it could be confused with. Occupied: the saved value stays the one
 * on screen and the suggestion is a marker the operator opens, so a proposal
 * never reads as the record — opening it puts the two side by side.
 *
 * Both accept and reject work here, in read mode; entering the edit form is
 * not a precondition for settling a suggestion.
 *
 * @param label - Field label, used in the action names so each button says what it acts on
 * @param currentValue - Saved value; empty string means the field is unoccupied
 * @param suggested - The proposed value
 * @param busy - True while an accept/reject request is in flight
 * @param onAccept - Persists the suggestion for this field
 * @param onReject - Dismisses it without persisting
 */
export function FieldSuggestion({
  label,
  currentValue,
  suggested,
  busy,
  onAccept,
  onReject,
}: {
  label: string;
  currentValue: string;
  suggested: string;
  busy: boolean;
  onAccept: () => void;
  onReject: () => void;
}) {
  const [disclosed, setDisclosed] = useState(false);
  const occupied = currentValue.trim() !== "";
  const actions = (
    <Stack direction="row" spacing={1}>
      <Button
        size="small"
        disabled={busy}
        onClick={onAccept}
        aria-label={`Aceitar ${label}`}
      >
        ✓
      </Button>
      <Button
        size="small"
        disabled={busy}
        onClick={onReject}
        aria-label={`Recusar ${label}`}
      >
        ×
      </Button>
    </Stack>
  );
  if (!occupied) {
    return (
      <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{ fontStyle: "italic", opacity: 0.7, flex: 1 }}
        >
          {suggested}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          sugestão
        </Typography>
        {actions}
      </Stack>
    );
  }
  return (
    <Stack spacing={0.5}>
      <Button
        size="small"
        onClick={() => setDisclosed((open) => !open)}
        aria-expanded={disclosed}
        aria-label={`Ver a sugestão para ${label}`}
        sx={{ alignSelf: "flex-start", textTransform: "none" }}
      >
        sugestão
      </Button>
      {disclosed ? (
        <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ fontStyle: "italic", flex: 1 }}
          >
            sugerido: {suggested}
          </Typography>
          {actions}
        </Stack>
      ) : null}
    </Stack>
  );
}

/**
 * A vehicle the extraction proposes adding, drawn as a ghost row among the
 * saved ones so it reads as not-yet-real.
 *
 * Only additions are represented. A suggested REMOVAL has no contract behind
 * it — `prefillFieldsSchema` carries scalar field values only — so the rail
 * does not invent one.
 *
 * @param identity - Make / model / year / plate line built from the suggested fields
 * @param busy - True while an accept/reject request is in flight
 * @param onAccept - Persists every suggested vehicle field
 * @param onReject - Dismisses every suggested vehicle field
 */
export function SuggestedVehicleRow({
  identity,
  busy,
  onAccept,
  onReject,
}: {
  identity: string;
  busy: boolean;
  onAccept: () => void;
  onReject: () => void;
}) {
  return (
    <Stack
      direction="row"
      spacing={1}
      sx={{
        alignItems: "center",
        border: 1,
        borderStyle: "dashed",
        borderColor: "divider",
        borderRadius: 1,
        p: 1,
      }}
    >
      <Typography
        variant="body2"
        sx={{ fontStyle: "italic", opacity: 0.7, flex: 1 }}
        data-testid="conversas-veiculo-sugerido"
      >
        {identity}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        sugerido
      </Typography>
      <Button
        size="small"
        disabled={busy}
        onClick={onAccept}
        aria-label="Aceitar veículo sugerido"
      >
        ✓
      </Button>
      <Button
        size="small"
        disabled={busy}
        onClick={onReject}
        aria-label="Recusar veículo sugerido"
      >
        ×
      </Button>
    </Stack>
  );
}

/**
 * Antigravity assistive-suggestion rows.
 *
 * Imported from antigravity/redesign 7952305. Same props, same accessible
 * names and copy as the cursor pair — only the styling differs.
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
    <Stack direction="row" spacing={0.75} sx={{ alignItems: "center" }}>
      <Button
        size="small"
        disabled={busy}
        onClick={onAccept}
        aria-label={`Aceitar ${label}`}
        sx={{
          minWidth: 22,
          width: 22,
          height: 22,
          p: 0,
          borderRadius: "50%",
          border: 1,
          borderColor: "divider",
          bgcolor: "background.paper",
          color: "text.primary",
          fontSize: "12px",
          fontWeight: 700,
          lineHeight: 1,
          "&:hover": { bgcolor: "action.hover" },
        }}
      >
        ✓
      </Button>
      <Button
        size="small"
        disabled={busy}
        onClick={onReject}
        aria-label={`Recusar ${label}`}
        sx={{
          minWidth: 22,
          width: 22,
          height: 22,
          p: 0,
          borderRadius: "50%",
          border: 1,
          borderColor: "divider",
          bgcolor: "background.paper",
          color: "text.primary",
          fontSize: "12px",
          fontWeight: 700,
          lineHeight: 1,
          "&:hover": { bgcolor: "action.hover" },
        }}
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
        sx={{
          display: "inline-flex",
          alignItems: "center",
          gap: 0.5,
          py: 0.25,
          px: 1,
          borderRadius: 999,
          border: 1,
          borderColor: "primary.main",
          bgcolor: "primaryContainer",
          color: "onPrimaryContainer",
          fontSize: "10px",
          fontWeight: 700,
          textTransform: "none",
          minHeight: "unset",
          lineHeight: 1.4,
          alignSelf: "flex-start",
          "&:hover": { bgcolor: "primary.main" },
        }}
      >
        1 sugestão
      </Button>
      {disclosed ? (
        <Stack
          direction="row"
          spacing={1}
          sx={{
            alignItems: "center",
            mt: 0.5,
            p: "5px 8px",
            borderLeft: 2,
            borderColor: "primary.main",
            bgcolor: "primaryContainer",
            borderRadius: "0 4px 4px 0",
          }}
        >
          <Typography
            variant="caption"
            sx={{ fontStyle: "italic", flex: 1, color: "onPrimaryContainer" }}
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
        borderColor: "primary.main",
        bgcolor: "primaryContainer",
        borderRadius: 1,
        p: 1,
      }}
    >
      <Typography
        variant="body2"
        sx={{
          fontStyle: "italic",
          fontSize: "13px",
          color: "onPrimaryContainer",
          flex: 1,
        }}
        data-testid="conversas-veiculo-sugerido"
      >
        {identity}
      </Typography>
      <Typography
        variant="caption"
        sx={{ fontSize: "10px", opacity: 0.7, color: "onPrimaryContainer" }}
      >
        sugerido
      </Typography>
      <Button
        size="small"
        disabled={busy}
        onClick={onAccept}
        aria-label="Aceitar veículo sugerido"
        sx={{
          minWidth: 22,
          width: 22,
          height: 22,
          p: 0,
          borderRadius: "50%",
          border: 1,
          borderColor: "divider",
          bgcolor: "background.paper",
          color: "text.primary",
          fontSize: "12px",
          fontWeight: 700,
          lineHeight: 1,
          "&:hover": { bgcolor: "action.hover" },
        }}
      >
        ✓
      </Button>
      <Button
        size="small"
        disabled={busy}
        onClick={onReject}
        aria-label="Recusar veículo sugerido"
        sx={{
          minWidth: 22,
          width: 22,
          height: 22,
          p: 0,
          borderRadius: "50%",
          border: 1,
          borderColor: "divider",
          bgcolor: "background.paper",
          color: "text.primary",
          fontSize: "12px",
          fontWeight: 700,
          lineHeight: 1,
          "&:hover": { bgcolor: "action.hover" },
        }}
      >
        ×
      </Button>
    </Stack>
  );
}

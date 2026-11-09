/**
 * Maps API tag color strings to the chip treatment the artboards draw.
 */
import type { SxProps, Theme } from "@mui/material/styles";

/**
 * Maps an API tag color string to the `sx` a tag Chip is drawn with.
 *
 * The artboards tint a tag rather than filling it: the container token carries
 * the colour and its on-colour carries the label, which is why this returns an
 * `sx` object and not a Chip `color` — MUI resolves `color` to
 * `palette.<name>.main` / `.contrastText`, and a container token is a bare
 * string with no `.main` to resolve. Each of the six tag colours gets its own
 * tint: warning and info map to their own container pairs rather than
 * borrowing the primary and secondary ones, which used to make an Aviso tag
 * indistinguishable from a Primária tag.
 *
 * @param color - Stored tag color from the API; null or unknown values get the neutral outlined tint.
 * @returns An `sx` object with the tag's fill and label colour, and, for a tag with no colour, its border.
 */
export function tagChipSx(color: string | null): SxProps<Theme> {
  switch (color) {
    case "primary":
      return { bgcolor: "primaryContainer", color: "onPrimaryContainer" };
    case "secondary":
      return { bgcolor: "secondaryContainer", color: "onSecondaryContainer" };
    case "error":
      return { bgcolor: "errorContainer", color: "onErrorContainer" };
    case "warning":
      return { bgcolor: "warningContainer", color: "onWarningContainer" };
    case "info":
      return { bgcolor: "infoContainer", color: "onInfoContainer" };
    default:
      return {
        bgcolor: "surfaceVariant",
        color: "text.secondary",
        border: 1,
        borderColor: "divider",
      };
  }
}

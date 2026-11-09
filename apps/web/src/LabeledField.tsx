/**
 * Form fields with their label ABOVE the input, the way every canvas artboard
 * draws them (`.filter-label` + `.filter`, `.input-label` + `.input`).
 *
 * MUI's default `TextField` floats its label inside the outline, which the
 * artboards never do. These two pairs keep the accessible name intact — a
 * `label[for]` for inputs, `aria-labelledby` for selects — so a test or a
 * screen reader still reaches the control by its label. Optional `helperText`
 * is wired with `aria-describedby` so an inline error is announced with the
 * field rather than only as colour.
 */
import MenuItem from "@mui/material/MenuItem";
import OutlinedInput, { type OutlinedInputProps } from "@mui/material/OutlinedInput";
import Select, { type SelectProps } from "@mui/material/Select";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import type { ReactNode } from "react";
import { TYPE_SCALE } from "./theme.js";

export { MenuItem };

/**
 * The caption-sized label drawn above a field.
 *
 * @param htmlFor - The input's id, for a native `label`.
 * @param id - The label's own id, for a control that names itself by `aria-labelledby`.
 * @param children - The label text.
 */
export function FieldLabel({
  htmlFor,
  id,
  children,
}: {
  htmlFor?: string;
  id?: string;
  children: ReactNode;
}) {
  return (
    <Typography
      component="label"
      htmlFor={htmlFor}
      id={id}
      sx={{
        fontSize: TYPE_SCALE.caption,
        fontWeight: 600,
        lineHeight: 1.5,
        display: "block",
      }}
      color="text.secondary"
    >
      {children}
    </Typography>
  );
}

/**
 * A text or date input with its label above it.
 *
 * @param id - The input's id; the label points at it.
 * @param label - The visible label and the input's accessible name.
 * @param helperText - Caption under the input; when `error` is set this is the
 *   inline error and is referenced from the input via `aria-describedby`.
 * @param props - Anything `OutlinedInput` takes (`type`, `value`, `onChange`, `sx`, …).
 * @returns The label and a small outlined input, stacked.
 */
export function LabeledInput({
  id,
  label,
  helperText,
  error,
  "aria-describedby": describedBy,
  ...props
}: { id: string; label: string; helperText?: ReactNode } & OutlinedInputProps) {
  const helperId = helperText ? `${id}-helper` : undefined;
  const describedByValue =
    [helperId, describedBy].filter(Boolean).join(" ") || undefined;
  return (
    <Stack spacing={0.5}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <OutlinedInput
        size="small"
        {...props}
        id={id}
        error={error}
        aria-invalid={error || undefined}
        aria-describedby={describedByValue}
      />
      {helperText ? (
        <Typography
          id={helperId}
          sx={{ fontSize: TYPE_SCALE.caption, lineHeight: 1.5 }}
          color={error ? "error" : "text.secondary"}
        >
          {helperText}
        </Typography>
      ) : null}
    </Stack>
  );
}

/**
 * A select with its label above it.
 *
 * The label's id is `${id}-label`, which the select names itself by, so
 * `getByLabelText(label)` resolves to the combobox exactly as it did with
 * MUI's floating `InputLabel`.
 *
 * @param id - The select's id; the label's id derives from it.
 * @param label - The visible label and the select's accessible name.
 * @param children - The `MenuItem` options.
 * @param props - Anything `Select` takes (`value`, `onChange`, `disabled`, `sx`, …).
 * @returns The label and a small select, stacked.
 */
export function LabeledSelect<T = unknown>({
  id,
  label,
  children,
  ...props
}: { id: string; label: string; children: ReactNode } & SelectProps<T>) {
  const labelId = `${id}-label`;
  return (
    <Stack spacing={0.5}>
      <FieldLabel id={labelId}>{label}</FieldLabel>
      <Select<T> id={id} labelId={labelId} size="small" {...props}>
        {children}
      </Select>
    </Stack>
  );
}

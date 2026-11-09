/**
 * The oil-quote dialog's ways out of its three dead ends (background-oil-research D24): the
 * missing volume's input and its "keep it for the model?" prompt, the clarification's engine
 * buttons, and the single-choice groups a conflict asks the attendant to pick from.
 *
 * Shared by both UI variants with no variant code, like `quote-research.tsx`. Accessibility (D24):
 * - a choice set is a `radiogroup` whose options are `role="radio"` with `aria-checked`, one tab
 *   stop (the checked option, else the first), the arrow keys moving the choice, and the theme's
 *   focus ring (`MuiButtonBase` `.Mui-focusVisible`);
 * - every choice, engine button and action has the 44 px target (`TOUCH_TARGET_PX`), which the
 *   antigravity variant requires;
 * - the volume input is named by its visible label, with the hint and the warning or the invalid
 *   sentence tied to it by `aria-describedby`; their announcement goes through the dialog's one
 *   `role="status"` (the caller passes it to `QuoteStatusRegion`), never an alert.
 */
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import ButtonBase from "@mui/material/ButtonBase";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import type { SxProps, Theme } from "@mui/material/styles";
import { useId, useRef, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { LabeledInput } from "../LabeledField.js";
import { TOUCH_TARGET_PX } from "../theme.js";
import {
  CORRECT_VERSION,
  ENGINE_CHOICE_INTRO,
  ENGINE_PICK_FAILED,
  FILL_VOLUME_HIGH,
  FILL_VOLUME_HINT,
  FILL_VOLUME_INVALID,
  FILL_VOLUME_LABEL,
  NONE_OF_THESE_ENGINES,
  SAVE_FILL_FOR_MODEL,
  SAVE_FILL_ONLY_THIS_QUOTE,
  USE_FILL_VOLUME,
  USE_HIGH_FILL_VOLUME,
} from "./quote-copy.js";

/** One option of a {@link ChoiceGroup}. */
export type Choice = { key: string; text: string };

/** The canvas's `.vol-choice` / `.vol-choice-on` rows. */
function choiceSx(checked: boolean): SxProps<Theme> {
  return {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-start",
    gap: 1,
    width: "100%",
    minHeight: TOUCH_TARGET_PX,
    px: 1.5,
    py: 1,
    textAlign: "left",
    typography: "caption",
    borderRadius: 0.5,
    border: checked ? 2 : 1,
    borderColor: checked ? "primary.main" : "divider",
    bgcolor: checked ? "primaryContainer" : "background.paper",
    color: checked ? "onPrimaryContainer" : "text.primary",
    fontWeight: checked ? 600 : 400,
  };
}

/**
 * A single choice drawn as the canvas's choice rows: a `radiogroup` of `role="radio"` options with
 * `aria-checked`. Nothing is checked until the attendant chooses (D24.3). Arrow keys move and
 * choose, as native radios do; Space or Enter chooses the focused one.
 *
 * @param label - The visible sentence above the options, which names the group; null when the
 * dialog's status already says it, and `ariaLabel` names the group instead.
 * @param marker - "radio" draws ◉/○ before each option (the grades); "check" draws ✓ on the
 * chosen one (the volumes). Both are hidden from assistive technology: `aria-checked` says it.
 * @param after - Non-interactive content drawn under an option (the grades' card previews).
 */
export function ChoiceGroup({
  label,
  ariaLabel,
  choices,
  value,
  onChange,
  marker,
  after,
}: {
  label: ReactNode;
  ariaLabel?: string | undefined;
  choices: readonly Choice[];
  value: string | null;
  onChange: (key: string) => void;
  marker: "radio" | "check";
  after?: (key: string) => ReactNode;
}) {
  const labelId = useId();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const checkedIndex = choices.findIndex((choice) => choice.key === value);
  const tabStop = checkedIndex >= 0 ? checkedIndex : 0;

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const step = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = (index + step + choices.length) % choices.length;
    refs.current[next]?.focus();
    onChange(choices[next]!.key);
  }

  return (
    <Stack spacing={0.75}>
      {label != null ? (
        <Typography id={labelId} component="div" variant="body1">
          {label}
        </Typography>
      ) : null}
      <Stack
        role="radiogroup"
        {...(label != null ? { "aria-labelledby": labelId } : { "aria-label": ariaLabel })}
        spacing={1}
      >
        {choices.map((choice, index) => {
          const checked = choice.key === value;
          const glyph = marker === "radio" ? (checked ? "◉" : "○") : checked ? "✓" : null;
          return (
            <Stack key={choice.key} spacing={1}>
              <ButtonBase
                ref={(node: HTMLButtonElement | null) => {
                  refs.current[index] = node;
                }}
                role="radio"
                aria-checked={checked}
                tabIndex={index === tabStop ? 0 : -1}
                onClick={() => onChange(choice.key)}
                onKeyDown={(event) => onKeyDown(event, index)}
                sx={choiceSx(checked)}
              >
                {glyph ? (
                  <Box component="span" aria-hidden>
                    {glyph}
                  </Box>
                ) : null}
                <Box component="span">{choice.text}</Box>
              </ButtonBase>
              {after?.(choice.key)}
            </Stack>
          );
        })}
      </Stack>
    </Stack>
  );
}

/** The warning icon the canvas draws beside the high-volume warning: a stroke triangle. */
function WarningIcon() {
  return (
    <Box
      component="svg"
      aria-hidden
      viewBox="0 0 24 24"
      sx={{ width: 14, height: 14, flexShrink: 0, fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", color: "onWarningContainer" }}
    >
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </Box>
  );
}

/** What the field says under its input. */
export type FillVolumeProblem = "invalid" | "high" | null;

/**
 * The missing volume's input (D24.1): "Volume de óleo da troca (litros)" with "Usar este volume",
 * the invalid sentence, the high-volume warning with "Usar mesmo assim", and the hint. Controlled:
 * the dialog owns the text and the problem, because the status region announces the problem.
 *
 * @param useButtonRef - The "Usar este volume" button, where focus returns when the prompt closes.
 */
export function FillVolumeField({
  value,
  onChange,
  problem,
  onUse,
  onConfirmHigh,
  useButtonRef,
}: {
  value: string;
  onChange: (raw: string) => void;
  problem: FillVolumeProblem;
  onUse: () => void;
  onConfirmHigh: () => void;
  useButtonRef: RefObject<HTMLButtonElement | null>;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const problemId = `${id}-problem`;
  return (
    <Stack spacing={1.25} sx={{ alignSelf: "stretch" }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: "flex-end", flexWrap: "wrap" }} useFlexGap>
        <Box sx={{ width: 200 }}>
          <LabeledInput
            id={`${id}-input`}
            label={FILL_VOLUME_LABEL}
            value={value}
            inputMode="decimal"
            placeholder="ex.: 4,2"
            error={problem === "invalid"}
            aria-describedby={[problem ? problemId : null, hintId].filter(Boolean).join(" ")}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              // Consumed here, so the key does not go on to press the prompt's focused button.
              event.preventDefault();
              onUse();
            }}
            sx={problem === "high" ? { "& .MuiOutlinedInput-notchedOutline": { borderColor: "warning.main" } } : {}}
            fullWidth
          />
        </Box>
        <Button ref={useButtonRef} variant="outlined" onClick={onUse}>
          {USE_FILL_VOLUME}
        </Button>
      </Stack>
      {problem === "invalid" ? (
        <Typography id={problemId} component="div" sx={{ typography: "caption", fontWeight: 600, color: "error.main" }}>
          {FILL_VOLUME_INVALID}
        </Typography>
      ) : null}
      {problem === "high" ? (
        <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
          <Typography
            id={problemId}
            component="div"
            sx={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              gap: 0.75,
              px: 1,
              py: 0.5,
              borderRadius: 0.5,
              typography: "caption",
              fontWeight: 600,
              bgcolor: "warningContainer",
              color: "onWarningContainer",
            }}
          >
            <WarningIcon />
            <span>{FILL_VOLUME_HIGH}</span>
          </Typography>
          <Button variant="outlined" onClick={onConfirmHigh}>
            {USE_HIGH_FILL_VOLUME}
          </Button>
        </Stack>
      ) : null}
      <Typography id={hintId} component="div" sx={{ typography: "caption", color: "tertiary" }}>
        {FILL_VOLUME_HINT}
      </Typography>
    </Stack>
  );
}

/**
 * "Guardar {litros} como volume da troca para os próximos orçamentos de {veículo}?" (D24.1), asked
 * when a typed volume is used, never on "Enviar via WhatsApp". A dialog over the quote: it takes
 * focus and, on either answer, the caller returns focus to "Usar este volume".
 */
export function SaveFillPrompt({
  question,
  onSave,
  onOnlyThisQuote,
}: {
  question: string;
  onSave: () => void;
  onOnlyThisQuote: () => void;
}) {
  const questionId = useId();
  return (
    <Dialog open onClose={onOnlyThisQuote} aria-labelledby={questionId} maxWidth="xs" fullWidth disableRestoreFocus>
      <DialogContent>
        <Typography id={questionId} sx={{ typography: "body1", fontWeight: 600, lineHeight: 1.5 }}>
          {question}
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button variant="outlined" onClick={onOnlyThisQuote}>
          {SAVE_FILL_ONLY_THIS_QUOTE}
        </Button>
        <Button variant="contained" onClick={onSave} autoFocus>
          {SAVE_FILL_FOR_MODEL}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/**
 * A clarification's way out (D24.2): one button per engine the source named, labelled verbatim,
 * under the intro, and the smaller "Nenhum destes? Corrigir versão do veículo" below them — a real
 * button. With no engine named, or after a `version_too_long`, only "Corrigir versão do veículo".
 *
 * @param picking - The engine POST is in flight or done: every engine button is disabled.
 * @param versionTooLong - The corrected version would not fit (422): the form is the way out.
 */
export function EngineChoices({
  engines,
  picking,
  versionTooLong,
  failed = false,
  onPick,
  onCorrectVersion,
}: {
  engines: readonly string[];
  picking: boolean;
  versionTooLong: boolean;
  /** The pick failed with a 500 or no answer: "Não foi possível corrigir a versão. Tente de novo." */
  failed?: boolean;
  onPick: (engine: string) => void;
  onCorrectVersion: () => void;
}) {
  const correct = (
    <Button variant="contained" onClick={onCorrectVersion}>
      {CORRECT_VERSION}
    </Button>
  );
  if (engines.length === 0) return correct;
  return (
    <Stack spacing={1} sx={{ alignItems: "flex-start" }}>
      <Typography component="div" sx={{ typography: "caption", color: "tertiary" }}>
        {ENGINE_CHOICE_INTRO}
      </Typography>
      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
        {engines.map((engine) => (
          <Button key={engine} variant="outlined" disabled={picking} onClick={() => onPick(engine)}>
            {engine}
          </Button>
        ))}
      </Stack>
      {failed ? (
        <Typography
          component="div"
          sx={{ typography: "caption", px: 1.5, py: 1, borderRadius: 0.5, bgcolor: "errorContainer", color: "onErrorContainer" }}
        >
          {ENGINE_PICK_FAILED}
        </Typography>
      ) : null}
      {versionTooLong ? (
        correct
      ) : (
        <Button
          variant="text"
          size="small"
          onClick={onCorrectVersion}
          sx={{ px: 0.5, typography: "caption", fontWeight: 500, textDecoration: "underline" }}
        >
          {NONE_OF_THESE_ENGINES}
        </Button>
      )}
    </Stack>
  );
}

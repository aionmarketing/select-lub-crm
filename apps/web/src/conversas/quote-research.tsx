/**
 * The oil-quote dialog's status region (background-oil-research D17): the one sentence that says
 * where the quote stands — loading, the research under way, the new search over a shown row, the
 * row's date, a newer row held back, or the recorded outcome — with its secondary lines, the
 * ticking counter and "Buscar novamente".
 *
 * Shared by both UI variants with no variant code. Accessibility (D17):
 * - one `role="status"` element stays mounted for the dialog's lifetime and only its text
 *   changes, because a live region inserted already holding its text is often not announced;
 * - the counter is `role="timer"` (implicit `aria-live="off"`), a sibling outside that region,
 *   so the seconds are never announced;
 * - "Buscar novamente" keeps one place in the tree whatever the view, and is never `disabled`
 *   (which would drop keyboard focus) — while its POST is pending it is `aria-disabled` and its
 *   handler does nothing;
 * - no MUI `Alert`, whose default role is `alert`.
 *
 * Layout: one grid wrapper whose areas move with the view, so the canvas's arrangements (the date
 * beside the button; the grey block, the counter, then the date line under a new search; the
 * dashed outcome box with the button inside) are drawn without moving any element in the tree.
 */
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Skeleton from "@mui/material/Skeleton";
import Typography from "@mui/material/Typography";
import type { SxProps, Theme } from "@mui/material/styles";
import { useRef, type ReactNode } from "react";
import type { ResearchTiming } from "@select-lub/shared-types";
import { useServerNow } from "../useNow.js";
import {
  counterSentence,
  LOAD_FAILED_SENTENCE,
  LOADING_SENTENCE,
  MANUAL_READING_SENTENCE,
  queueSentence,
  REFETCH_FAILED_SENTENCE,
  refreshSentence,
  researchingSentence,
} from "./quote-copy.js";

/**
 * What the status region shows.
 *
 * - `loading` — the read is in flight;
 * - `load_error` — the read itself failed, with "Tentar de novo";
 * - `researching` — research under way with no row to show;
 * - `row` — a stored row is shown below (options, empty, missing volume): its date line, the new
 *   search under way for it when `refresh` is set, or — `held` — a newer row kept back because the
 *   attendant edited this one, with "Atualizar";
 * - `outcome` — a recorded outcome with no row: `text`, then any `details` below it;
 * - `notice` — a conflict with its cards below (D24.3): the sentence that asks for the choice, in
 *   plain text, with "Buscar novamente" under it.
 */
export type QuoteStatusView =
  | { kind: "loading" }
  | { kind: "load_error"; onRetry: () => void }
  | { kind: "researching"; timing: ResearchTiming }
  | { kind: "row"; dateText: string; refresh?: ResearchTiming; held?: { text: string; onUpdate: () => void } }
  | { kind: "outcome"; text: string; details?: ReactNode }
  | { kind: "notice"; text: string };

/**
 * Text read to assistive technology only. An announcement shares the status element (D24: the
 * volume warning and the save failure go through the one `role="status"`), while its visible copy
 * sits by the control it is about.
 */
const visuallyHiddenSx = {
  position: "absolute",
  // Strings: MUI reads a bare 1 as 100%.
  width: "1px",
  height: "1px",
  p: 0,
  m: "-1px",
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: 0,
} as const;

/** "Buscar novamente" and its POST's state, when the shown state offers it. */
export type QuoteRefetchControl = {
  onRefetch: () => void;
  pending: boolean;
  failed: boolean;
};

/** The grey research block (canvas `.research-block`). */
const researchBlockSx = {
  display: "flex",
  flexDirection: "column",
  gap: 0.75,
  p: 1.5,
  borderRadius: 1,
  bgcolor: "surfaceVariant",
} as const;

/** The held-row banner (canvas: "Chegaram dados novos"). */
const heldBlockSx = {
  display: "flex",
  flexDirection: "row",
  alignItems: "center",
  justifyContent: "space-between",
  flexWrap: "wrap",
  gap: 1,
  px: 1.5,
  py: 1,
  borderRadius: 0.5,
  bgcolor: "primaryContainer",
  color: "onPrimaryContainer",
} as const;

/** A recorded outcome (canvas `.outcome-block`): a dashed hairline box. */
export const outcomeBlockSx: SxProps<Theme> = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  gap: 1.25,
  p: 2,
  borderRadius: 1,
  border: 1,
  borderStyle: "dashed",
  borderColor: "divider",
};

const plainBlockSx = { display: "flex", flexDirection: "column", gap: 1, minWidth: 0 } as const;

/**
 * The time elapsed since `requestedAt` on the server's clock, ticking every second, and never
 * lower than a value already shown for the same `requestedAt`: a poll's fresh offset can be a
 * little behind the previous one, and a counter that steps back reads as broken.
 */
function useElapsed(timing: ResearchTiming | undefined, receivedAt: number): number {
  const serverNow = useServerNow(timing?.now ?? null, receivedAt);
  const shown = useRef<{ requestedAt: string; elapsedMs: number } | null>(null);
  if (timing == null) return 0;
  const requested = Date.parse(timing.requestedAt);
  const raw = Number.isNaN(requested) ? 0 : serverNow - requested;
  const previous = shown.current?.requestedAt === timing.requestedAt ? shown.current.elapsedMs : -Infinity;
  const elapsedMs = Math.max(raw, previous);
  shown.current = { requestedAt: timing.requestedAt, elapsedMs };
  return elapsedMs;
}

/** The grid areas of each arrangement, row by row. */
function gridAreas(rows: string[][]): string {
  return rows.map((row) => `"${row.join(" ")}"`).join(" ");
}

/**
 * The dialog's status region. Rendered at one place in the dialog for its whole life, so the
 * `role="status"` element inside it is never remounted — only its text and styling change.
 *
 * @param view - What to say.
 * @param receivedAt - When the shown response arrived on the browser's clock (TanStack Query's
 * `dataUpdatedAt`): with the response's `now`, it gives the server-clock offset, once per response.
 * @param refetch - "Buscar novamente", when the shown state offers it.
 * @param announcement - A sentence about a control below (the volume warning, the invalid volume,
 * the failed save; D24.1), read inside the status element and shown only where the control is.
 */
export function QuoteStatusRegion({
  view,
  receivedAt,
  refetch,
  announcement,
}: {
  view: QuoteStatusView;
  receivedAt: number;
  refetch?: QuoteRefetchControl;
  /** `key` changes for a repeat of the same sentence, so the span is replaced and read again. */
  announcement?: { text: string; key: number } | null;
}) {
  const timing = view.kind === "researching" ? view.timing : view.kind === "row" ? view.refresh : undefined;
  const held = view.kind === "row" ? view.held : undefined;
  const elapsedMs = useElapsed(timing, receivedAt);

  let sentence: string;
  let blockSx: SxProps<Theme> = plainBlockSx;
  let sentenceSx: SxProps<Theme> = { typography: "body2" };
  if (view.kind === "loading") {
    sentence = LOADING_SENTENCE;
    sentenceSx = { typography: "body2", color: "text.secondary" };
  } else if (view.kind === "load_error") {
    sentence = LOAD_FAILED_SENTENCE;
  } else if (view.kind === "researching") {
    sentence = researchingSentence(view.timing, elapsedMs);
    blockSx = researchBlockSx;
    sentenceSx = { typography: "body2", fontWeight: 600 };
  } else if (view.kind === "row") {
    if (held != null) {
      sentence = held.text;
      blockSx = heldBlockSx;
      sentenceSx = { typography: "caption", fontWeight: 600 };
    } else if (view.refresh != null) {
      sentence = refreshSentence(view.refresh, elapsedMs);
      blockSx = researchBlockSx;
      sentenceSx = { typography: "body2", fontWeight: 600 };
    } else {
      sentence = view.dateText;
      sentenceSx = { typography: "caption", color: "tertiary" };
    }
  } else {
    sentence = view.text;
  }

  // Manual and queue lines belong to a research under way (D17); the manual one not while paused.
  const lines: string[] = [];
  if (timing != null && held == null) {
    if (timing.path === "manual" && timing.paused == null) lines.push(MANUAL_READING_SENTENCE);
    if (timing.queuePosition > 0) lines.push(queueSentence(timing.queuePosition));
  }
  const showTimer = timing != null && held == null;
  // The row's date gets a line of its own whenever the status says something else.
  const separateDate = view.kind === "row" && (showTimer || held != null);

  // The arrangement. Every area that may hold an element is named here, never by moving the
  // element: the date beside the button, or the block over the counter over the date line.
  const rows: string[][] = [];
  const outcome = view.kind === "outcome" || view.kind === "load_error";
  // An outcome and a notice put the button under the sentence, at the start.
  const actionAtStart = outcome || view.kind === "notice";
  if (view.kind === "row" && !separateDate) {
    rows.push(["main", refetch ? "action" : "main"]);
  } else {
    rows.push(["main", "main"]);
    if (showTimer) rows.push(["timer", "timer"]);
    if (separateDate) rows.push(["date", refetch ? "action" : "date"]);
    else if (refetch) rows.push([actionAtStart ? "action" : ".", "action"]);
  }
  if (refetch?.failed) rows.push(["failed", "failed"]);

  const wrapperSx: SxProps<Theme> = [
    {
      display: "grid",
      gridTemplateColumns: "minmax(0, 1fr) auto",
      gridTemplateAreas: gridAreas(rows),
      alignItems: "center",
      columnGap: 1,
      rowGap: 0.75,
    },
    outcome ? { ...(outcomeBlockSx as object), display: "grid", justifyItems: "start", rowGap: 1.25 } : {},
  ] as SxProps<Theme>;

  return (
    <Box sx={wrapperSx}>
      <Box sx={[{ gridArea: "main" }, blockSx] as SxProps<Theme>}>
        {view.kind === "loading" ? <Skeleton variant="rounded" height={14} width="50%" /> : null}
        {/* The one status element: always this child, always a div, so React keeps the node. */}
        <Typography role="status" component="div" sx={sentenceSx}>
          {sentence}
          {announcement ? (
            <Box key={announcement.key} component="span" sx={visuallyHiddenSx}>
              {` ${announcement.text}`}
            </Box>
          ) : null}
        </Typography>
        {lines.map((line) => (
          <Typography key={line} component="div" sx={{ typography: "caption", color: "onTertiaryContainer" }}>
            {line}
          </Typography>
        ))}
        {view.kind === "outcome" ? view.details : null}
        {view.kind === "load_error" ? (
          <Button variant="contained" onClick={view.onRetry}>
            Tentar de novo
          </Button>
        ) : null}
        {held != null ? (
          <Button variant="contained" onClick={held.onUpdate}>
            Atualizar
          </Button>
        ) : null}
      </Box>
      {showTimer ? (
        <Typography
          role="timer"
          component="div"
          sx={{ gridArea: "timer", typography: "caption", color: "tertiary", pl: 1.5, fontVariantNumeric: "tabular-nums" }}
        >
          {counterSentence(timing, elapsedMs)}
        </Typography>
      ) : null}
      {separateDate ? (
        <Typography component="div" sx={{ gridArea: "date", typography: "caption", color: "tertiary" }}>
          {view.dateText}
        </Typography>
      ) : null}
      {/* One place for the button in every view, so its focus survives a change of view. */}
      {refetch != null ? (
        <Button
          variant="outlined"
          aria-disabled={refetch.pending || undefined}
          onClick={() => {
            if (!refetch.pending) refetch.onRefetch();
          }}
          sx={[{ gridArea: "action", justifySelf: actionAtStart ? "start" : "end" }, refetch.pending ? { opacity: 0.6 } : {}] as SxProps<Theme>}
        >
          Buscar novamente
        </Button>
      ) : null}
      {refetch?.failed ? (
        <Typography
          component="div"
          sx={{ gridArea: "failed", typography: "caption", px: 1.5, py: 1, borderRadius: 0.5, bgcolor: "errorContainer", color: "onErrorContainer" }}
        >
          {REFETCH_FAILED_SENTENCE}
        </Typography>
      ) : null}
    </Box>
  );
}

/**
 * A plain notice box, never a live region (D17: no `role="alert"` in the dialog). `warning` is
 * for a filter the quote could not price; `neutral` for one still being consulted.
 */
export function NoticeBox({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "warning" | "error" | "success";
}) {
  const colors = {
    neutral: ["tertiaryContainer", "onTertiaryContainer"],
    warning: ["warningContainer", "onWarningContainer"],
    error: ["errorContainer", "onErrorContainer"],
    success: ["successContainer", "onSuccessContainer"],
  }[tone];
  return (
    <Typography
      component="div"
      sx={{
        typography: "caption",
        px: 1.5,
        py: 1,
        borderRadius: 0.5,
        bgcolor: colors[0],
        color: colors[1],
      }}
    >
      {children}
    </Typography>
  );
}

/** A dashed outcome box for content that sits under the row line (empty, missing volume). */
export function OutcomeBox({ children, centered = false }: { children: ReactNode; centered?: boolean }) {
  return (
    <Box sx={[outcomeBlockSx, centered ? { alignItems: "center", textAlign: "center", color: "text.secondary" } : {}] as SxProps<Theme>}>
      {children}
    </Box>
  );
}

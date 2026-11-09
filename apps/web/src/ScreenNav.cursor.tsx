/**
 * The six-screen page nav, shared by every authenticated screen.
 *
 * One component rather than a copy per page, because the row is the shared
 * foundation block in the canvas: `design/mvp-screen-designs/` draws it
 * byte-identically on all six artboards, and three pages had already drifted
 * apart before this was extracted — Relatórios listed four screens plus the
 * Galeria QA page, while Configurações and Usuários each omitted Relatórios.
 * A single component makes "all six, every time" true by construction instead
 * of by six people remembering.
 *
 * The page heading deliberately sits OUTSIDE this row. Interleaving an `h1`
 * among the links, as Relatórios did, makes the current screen's name read as
 * one more navigation target.
 */
import Box from "@mui/material/Box";
import Link from "@mui/material/Link";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useQuery } from "@tanstack/react-query";
import { Link as RouterLink } from "react-router-dom";
import type { FollowUpOptionalCounts } from "@select-lub/shared-types";
import { fetchFollowUpCounts } from "./api.js";
import { SCREENS } from "./screens.js";
import { TYPE_SCALE, TOUCH_TARGET_PX } from "./theme.js";

/**
 * Total pending across the four Follow-up sections, or `null` when that total
 * cannot be stated.
 *
 * Every one of the four counts is optional on the wire, because "unavailable"
 * is deliberately distinguishable from zero. A partial answer is therefore not
 * a smaller total — it is an unknown one, so a single missing count makes the
 * whole badge absent rather than understating what is pending.
 *
 * @param counts - The contract's counts object, or undefined before it loads.
 * @returns The sum when all four are known, otherwise null.
 */
function pendingTotal(counts: FollowUpOptionalCounts | undefined) {
  if (!counts) {
    return null;
  }
  const parts = [
    counts.unansweredQuotes,
    counts.overdueReturns,
    counts.upcomingReturns,
    counts.waitingReply,
  ];
  return parts.every((n) => typeof n === "number")
    ? parts.reduce((a, b) => a + b!, 0)
    : null;
}

/**
 * The pendency badge on the Follow-up entry.
 *
 * Reads the counts-only endpoint, which is the SAME aggregation the lists come
 * from — a second reader over its own predicates is how a badge starts
 * disagreeing with the screen it points at. It draws on every page, so pulling
 * the full lists for four numbers would be waste. Zero draws nothing, and so does an
 * unavailable count: a permanent "0" teaches the eye to ignore the one place
 * the number matters.
 *
 * Gold is a fill and never a foreground here — the pill is `primary` carrying
 * `contrastText`, not `primary`-coloured numerals, which would fail AA.
 */
function PendencyBadge() {
  const query = useQuery({
    queryKey: ["follow-up-counts"],
    queryFn: fetchFollowUpCounts,
  });
  const total = pendingTotal(query.data);
  if (total === null || total === 0) {
    return null;
  }
  return (
    <Box
      component="span"
      role="status"
      aria-atomic="true"
      aria-label={`${total} pendências no Follow-up`}
      sx={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        minWidth: 18,
        height: 18,
        px: "5px",
        ml: "6px",
        borderRadius: "9px",
        bgcolor: "primary.main",
        color: "primary.contrastText",
        fontSize: TYPE_SCALE.caption,
        fontWeight: 700,
        lineHeight: 1,
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {total}
    </Box>
  );
}

/**
 * Renders the nav row with one screen marked as current.
 *
 * The current screen is marked by weight, colour and a 2px underline together,
 * never by weight alone — the canvas pairs `font-weight:700` with
 * `border-bottom-color:var(--primary)`, and weight on its own is too weak a
 * signal to locate yourself by at a glance.
 *
 * @param current - Route of the screen to mark, matched against `SCREENS[].to`.
 *   A value matching no screen renders the row with nothing marked rather than
 *   throwing, so a new route cannot break every page's navigation.
 * @returns The nav row listing all six MVP screens.
 */
export function ScreenNav({ current }: { current: string }) {
  return (
    <Stack
      component="nav"
      direction="row"
      spacing={3}
      sx={{
        px: 3,
        borderBottom: 1,
        borderColor: "divider",
        bgcolor: "background.paper",
        flexShrink: 0,
        flexWrap: "wrap",
        rowGap: 0.5,
      }}
    >
      {SCREENS.map((entry) =>
        entry.to === current ? (
          <Typography
            key={entry.to}
            aria-current="page"
            sx={{
              py: 1.5,
              minHeight: TOUCH_TARGET_PX,
              boxSizing: "border-box",
              display: "inline-flex",
              alignItems: "center",
              fontSize: TYPE_SCALE.body,
              fontWeight: 700,
              borderBottom: 2,
              borderColor: "primary.main",
            }}
          >
            {entry.label}
            {entry.to === "/follow-up" ? <PendencyBadge /> : null}
          </Typography>
        ) : (
          <Link
            key={entry.to}
            component={RouterLink}
            to={entry.to}
            underline="hover"
            sx={{
              py: 1.5,
              minHeight: TOUCH_TARGET_PX,
              boxSizing: "border-box",
              display: "inline-flex",
              alignItems: "center",
              fontSize: TYPE_SCALE.body,
              fontWeight: 500,
              color: "text.secondary",
              borderBottom: 2,
              borderColor: "transparent",
            }}
          >
            {entry.label}
            {entry.to === "/follow-up" ? <PendencyBadge /> : null}
          </Link>
        ),
      )}
    </Stack>
  );
}

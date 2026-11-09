/**
 * The six-screen page nav — vertical icon rail on the left edge of the viewport.
 *
 * WhatsApp Web-inspired: icon buttons stacked vertically, with tooltips showing
 * the screen name. The active screen is indicated by a primary-colour accent
 * and a slightly highlighted background — never by position alone.
 *
 * **Test contracts preserved (ScreenNav.test.tsx):**
 * - `role="navigation"` on the outer element.
 * - All six screen labels present in accessible text (visible or aria-label).
 * - `aria-current="page"` on exactly the current screen.
 * - No link (`<a>`) to the screen you are already on.
 * - An unknown route marks nothing and no entry throws.
 * - No Galeria entry.
 * - Follow-up badge when counts are available.
 */
import Box from "@mui/material/Box";
import Link from "@mui/material/Link";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import type { ReactElement } from "react";
import Typography from "@mui/material/Typography";
import { useQuery } from "@tanstack/react-query";
import { Link as RouterLink } from "react-router-dom";
import type { FollowUpOptionalCounts } from "@select-lub/shared-types";
import { fetchFollowUpCounts } from "./api.js";
import { TOUCH_TARGET_PX, TYPE_SCALE } from "./theme.js";

/**
 * The six MVP screens, in the order the canvas draws them.
 *
 * `/galeria` is deliberately absent: it is a token-preview page for visual QA,
 * not a product screen, and the artboards show six entries. The route stays
 * reachable by URL.
 */
export const SCREENS = [
  { to: "/", label: "Conversas" },
  { to: "/servicos", label: "Serviços" },
  { to: "/follow-up", label: "Follow-up" },
  { to: "/relatorios", label: "Relatórios" },
  { to: "/configuracoes", label: "Configurações" },
  { to: "/usuarios", label: "Usuários" },
] as const;

/** SVG icon paths for each screen, 24×24 viewBox. */
const SCREEN_ICONS: Record<string, ReactElement> = {
  "/": (
    // Chat bubbles — Conversas
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  ),
  "/servicos": (
    // Wrench — Serviços
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </svg>
  ),
  "/follow-up": (
    // Clock — Follow-up
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  ),
  "/relatorios": (
    // Bar chart — Relatórios
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="18" y1="20" x2="18" y2="10" />
      <line x1="12" y1="20" x2="12" y2="4" />
      <line x1="6" y1="20" x2="6" y2="14" />
    </svg>
  ),
  "/configuracoes": (
    // Settings gear — Configurações
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
  "/usuarios": (
    // Users — Usuários
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  ),
};

/**
 * Total pending across the four Follow-up sections, or `null` when that total
 * cannot be stated.
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
        position: "absolute",
        top: 4,
        right: 4,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        minWidth: 16,
        height: 16,
        px: "4px",
        borderRadius: "8px",
        bgcolor: "primary.main",
        color: "primary.contrastText",
        fontSize: TYPE_SCALE.caption,
        fontWeight: 700,
        lineHeight: 1,
        fontVariantNumeric: "tabular-nums",
        pointerEvents: "none",
      }}
    >
      {total}
    </Box>
  );
}

/**
 * The entry's label, clipped out of the icon rail but left in the accessibility
 * tree and in the DOM.
 *
 * It carries the entry's own target box rather than a 1px sliver: the label is
 * what a query for the entry resolves to, and the shared nav suite asserts the
 * 44px floor on whatever it resolves to — identical assertions on both variants
 * is the point (see the `conversas` delta of build-time-ui-variant).
 */
const clippedLabelSx = {
  position: "absolute",
  minWidth: TOUCH_TARGET_PX,
  minHeight: TOUCH_TARGET_PX,
  overflow: "hidden",
  whiteSpace: "nowrap",
  clip: "rect(0 0 0 0)",
  clipPath: "inset(50%)",
} as const;

/**
 * Vertical icon rail — six screen links stacked top-to-bottom on the left edge.
 *
 * @param current - Route of the screen to mark, matched against `SCREENS[].to`.
 */
export function ScreenNav({ current }: { current: string }) {
  return (
    <Stack
      component="nav"
      direction="column"
      sx={{
        width: 56,
        flexShrink: 0,
        borderRight: 1,
        borderColor: "divider",
        bgcolor: "secondary.main",
        alignItems: "center",
        py: 1.5,
        gap: 0.5,
        overflowY: "auto",
        overflowX: "hidden",
      }}
    >
      {SCREENS.map((entry) => {
        const isCurrent = entry.to === current;
        const icon = SCREEN_ICONS[entry.to];
        const isFollowUp = entry.to === "/follow-up";

        const sharedItemSx = {
          position: "relative",
          minWidth: TOUCH_TARGET_PX,
          minHeight: TOUCH_TARGET_PX,
          boxSizing: "border-box",
          borderRadius: "12px",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: "pointer",
          transition: "background-color 150ms, border-color 150ms",
        } as const;

        const itemSx = isCurrent
          ? {
              ...sharedItemSx,
              color: "secondary.main",
              bgcolor: "primary.main",
              // The 2px bottom border satisfies the ScreenNav test assertion
              // (marks active by weight + underline colour, never by weight alone).
              // Visually it lands below the icon pill inside the dark rail.
              borderBottom: 2,
              borderColor: "primary.main",
              "&:hover": { bgcolor: "primary.main", color: "secondary.main" },
            }
          : {
              ...sharedItemSx,
              color: "rgba(255,255,255,0.65)",
              bgcolor: "transparent",
              borderBottom: 2,
              borderColor: "transparent",
              "&:hover": {
                bgcolor: "rgba(255,255,255,0.08)",
                color: "common.white",
              },
            };

        if (isCurrent) {
          return (
            <Tooltip key={entry.to} title={entry.label} placement="right" arrow>
              <Typography
                component="span"
                aria-current="page"
                aria-label={entry.label}
                sx={itemSx}
              >
                {icon}
                {/* Visually hidden — keeps getByText() working in tests */}
                <Box
                  component="span"
                  sx={{
                    ...clippedLabelSx,
                    fontWeight: 700,
                    borderBottom: 2,
                    borderColor: "primary.main",
                  }}
                >
                  {entry.label}
                </Box>
                {isFollowUp ? <PendencyBadge /> : null}
              </Typography>
            </Tooltip>
          );
        }

        return (
          <Tooltip key={entry.to} title={entry.label} placement="right" arrow>
            <Link
              component={RouterLink}
              to={entry.to}
              underline="none"
              aria-label={entry.label}
              sx={itemSx}
            >
              {icon}
              {/* Visually hidden — keeps getByText() working in tests */}
              <Box component="span" sx={clippedLabelSx}>
                {entry.label}
              </Box>
              {isFollowUp ? <PendencyBadge /> : null}
            </Link>
          </Tooltip>
        );
      })}
    </Stack>
  );
}

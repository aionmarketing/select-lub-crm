/**
 * The page frame the screen pages share: the nav row, then a grey main region
 * whose content spans the width, with bands of heading-above-card sections.
 *
 * This is the canvas's shared foundation as code (design-system "Screen pages
 * share the canvas foundation"). The ground is a PAGE property rather than the
 * theme's `background.default`: the shell bar, the nav row, the login states
 * and the Conversas inbox are white on every artboard, and only the area under
 * the nav goes grey. Cards are white with no border — the ground separates
 * them, which is why a bordered card on a white page looked like a different
 * product from the design it was meant to match.
 */
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import type { ReactNode } from "react";
import { ScreenNav } from "./ScreenNav.js";
import { UI_VARIANT } from "./uiVariant.js";
import { MAIN_CONTENT_ID, shellBelowBarSx, TYPE_SCALE } from "./theme.js";

/**
 * A borderless white card on the grey ground: 16px padding, the theme's 8px
 * card radius, no outline. Spread into a `Box`/`Stack` `sx`.
 */
export const cardSx = {
  p: 2,
  bgcolor: "background.paper",
  borderRadius: 1,
} as const;

/**
 * Renders one screen page: the six-entry nav, then the grey main region with
 * the page title and the page's bands.
 *
 * @param current - Route of the screen to mark current in the nav.
 * @param title - The page title, rendered as the page's single `h1`.
 * @param titleAside - Optional node beside the title (Follow-up's unit chip).
 * @param children - The page's bands, laid out as a 24px-gapped column.
 * @returns The nav row and a `main` landmark holding the page.
 */
export function PageShell({
  current,
  title,
  titleAside,
  children,
}: {
  current: string;
  title: string;
  titleAside?: ReactNode;
  children: ReactNode;
}) {
  // The nav's axis is the variant's: cursor draws the artboard row above the
  // page, antigravity a full-height rail beside it. The shell has to agree with
  // it, or a 56px vertical rail renders as a 56px-tall strip across the top.
  const antigravity = UI_VARIANT === "antigravity";
  return (
    <Stack
      direction={antigravity ? "row" : "column"}
      sx={
        antigravity
          ? { ...shellBelowBarSx, overflow: "hidden" }
          : { minHeight: "100%" }
      }
    >
      <ScreenNav current={current} />
      <Box
        component="main"
        id={MAIN_CONTENT_ID}
        tabIndex={-1}
        sx={{
          flex: 1,
          bgcolor: "surfaceVariant",
          p: 3,
          outline: "none",
          // Beside the rail the page scrolls in its own column, matching
          // Conversas, so the rail never leaves the viewport.
          ...(antigravity ? { minWidth: 0, overflowY: "auto" } : {}),
        }}
      >
        <Stack spacing={3}>
          <Stack
            direction="row"
            spacing={1.5}
            sx={{ alignItems: "center", flexWrap: "wrap" }}
          >
            <Typography
              component="h1"
              sx={{
                fontSize: TYPE_SCALE.page,
                fontWeight: 800,
                letterSpacing: "-0.02em",
              }}
            >
              {title}
            </Typography>
            {titleAside}
          </Stack>
          {children}
        </Stack>
      </Box>
    </Stack>
  );
}

/**
 * One band: a section heading ABOVE its content, never inside the card.
 *
 * The heading row carries an optional subtitle (Follow-up's ordering note,
 * "mais antigo primeiro") and an optional trailing node (Relatórios' section
 * mark). The band is a `section` named after its title so tests and assistive
 * technology can address it as a region.
 *
 * @param title - Heading text and the section's accessible name.
 * @param subtitle - Caption beside the heading; omitted when undefined.
 * @param end - Node at the far end of the heading row; omitted when undefined.
 * @param id - Optional DOM id for in-page anchors.
 * @param children - The band's card(s) and anything drawn between heading and card.
 * @returns A `section` region with the heading row above its children.
 */
export function PageSection({
  title,
  subtitle,
  end,
  id,
  children,
}: {
  title: string;
  subtitle?: string;
  end?: ReactNode;
  id?: string;
  children: ReactNode;
}) {
  return (
    <Stack component="section" id={id} aria-label={title} spacing={1.5}>
      <Stack
        direction="row"
        spacing={1.5}
        sx={{ alignItems: "baseline", flexWrap: "wrap" }}
      >
        <Typography
          component="h2"
          sx={{
            fontSize: TYPE_SCALE.section,
            fontWeight: 700,
            letterSpacing: "-0.01em",
          }}
        >
          {title}
        </Typography>
        {subtitle ? (
          <Typography sx={{ fontSize: TYPE_SCALE.caption }} color="text.secondary">
            {subtitle}
          </Typography>
        ) : null}
        {end ? <Box sx={{ ml: "auto" }}>{end}</Box> : null}
      </Stack>
      {children}
    </Stack>
  );
}

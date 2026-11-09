/**
 * MUI theme factory — hand-set brand palettes and component shape overrides.
 */
import { createTheme, lighten, type Theme } from "@mui/material/styles";

/** Identifies which contained-CTA palette variant is active (`yellow-cta` default). */
export type PaletteId = "yellow-cta" | "black-cta";

/**
 * The canvas type scale, in CSS pixels.
 *
 * These are the `--t-*` tokens the shared foundation block declares in
 * `design/mvp-screen-designs/`, named here so a heading size is written once
 * rather than as a literal on each screen. `metric` is a value, not a heading:
 * it carries weight 800 and the tight letter-spacing the canvas gives numerals.
 *
 * A heading SHALL NOT be distinguished by weight alone — pair a size from this
 * scale with weight, and, for the current nav entry, with an underline.
 */
export const TYPE_SCALE = {
  /** Page title, one per screen. */
  page: 26,
  /** Section heading inside a screen. */
  section: 18,
  /** Subsection heading, and three-up supporting stats. */
  subsection: 15,
  /** Default running text. */
  body: 13,
  /** Secondary note under a value or field. Floor is 12px (no UI text below that). */
  caption: 12,
  /** A card’s headline number. */
  metric: 30,
} as const;

/**
 * Minimum tap/click target, in CSS pixels.
 *
 * ui-ux-pro-max (Touch & Interaction) and WCAG 2.2 AAA 2.5.5 both call for 44×44.
 * Buttons, icon buttons, toggles, and nav links use this; dense `size="small"`
 * text fields stay on MUI's compact height so dashboard filters do not grow.
 */
export const TOUCH_TARGET_PX = 44;

/**
 * Height of the authenticated AppBar, in CSS pixels.
 *
 * Matches the canvas `.shell` (52px). `html` scroll-padding uses the same value
 * so a focused control is not fully covered by that bar (WCAG 2.2 2.4.11).
 */
export const SHELL_BAR_HEIGHT_PX = 52;

/**
 * Height for a screen shell that must fill the viewport without scrolling the
 * document — the antigravity variant's contract.
 *
 * Such a shell renders *below* the AppBar inside `RequireAuth`'s stack, so a
 * plain `100dvh` makes the document exactly one bar taller than the viewport
 * and every route scrolls by {@link SHELL_BAR_HEIGHT_PX}. Subtracting the bar
 * is deliberate rather than `flex: 1`: that stack is `minHeight: 100vh` with no
 * definite height, so a flex child grows with its content instead of being
 * constrained by it, and the page ends up clipped with its tail unreachable.
 *
 * One definition because three shells need it — `PageShell`, the antigravity
 * Conversas page, and `ServicosPage`, which cannot use `PageShell` (it is a
 * master-detail layout with its own header band and internal scroller).
 */
export const shellBelowBarSx = {
  height: `calc(100dvh - ${SHELL_BAR_HEIGHT_PX}px)`,
  // Fallback for browsers without dvh support
  "@supports not (height: 100dvh)": {
    height: `calc(100vh - ${SHELL_BAR_HEIGHT_PX}px)`,
  },
} as const;

/** WCAG 2.2 AA for body-sized text; the funnel numerals are 15px, not large text. */
const AA_CONTRAST = 4.5;

/** One stage of the funnel ramp, as a share of the way from `primary` to white. */
const FUNNEL_STEP = 0.12;

function channelToLinear(channel: number) {
  const s = channel / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/**
 * Reads a colour in either shape it is written here: a 6-digit hex from the
 * role tables, or the `rgb(r, g, b)` string `lighten` recomposes.
 */
function parseColor(color: string) {
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(color);
  if (rgb) {
    return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]) };
  }
  const normalized = color.replace("#", "");
  if (normalized.length !== 6) {
    throw new Error(`expected 6-digit hex or rgb(), got ${color}`);
  }
  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16),
  };
}

function relativeLuminance(color: string) {
  const { r, g, b } = parseColor(color);
  return (
    0.2126 * channelToLinear(r) +
    0.7152 * channelToLinear(g) +
    0.0722 * channelToLinear(b)
  );
}

/**
 * WCAG contrast ratio between two colours.
 *
 * It lives in the theme module because a colour DECISION belongs with the
 * colours: {@link funnelStage} picks a label with it at render time, which a
 * helper defined inside a test file could not do.
 *
 * @param foreground - Text colour, as hex or `rgb()`.
 * @param background - Fill behind it, as hex or `rgb()`.
 * @returns Ratio from 1 (identical) to 21 (black on white).
 */
export function contrastRatio(foreground: string, background: string) {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * Landmark id the skip link (`Pular para o conteúdo`) points at.
 *
 * PageShell, Conversas, Serviços, and the token gallery stamp this on their
 * `main` so one href works on every authenticated route.
 */
export const MAIN_CONTENT_ID = "conteudo-principal";

/** Visible keyboard focus ring: 2px perimeter, charcoal on both palettes. */
function focusVisibleSx(theme: Theme) {
  return {
    outline: `${theme.spacing(0.25)} solid ${theme.palette.secondary.main}`,
    outlineOffset: theme.spacing(0.25),
  };
}

/**
 * The fill and label for one Funil de Vendas stage.
 *
 * The artboard's funnel tokens are `#EAB63D`, `#eec25c`, `#f2ce7c`, `#f7db9d` —
 * the brand gold lightened in ~12% steps — so the fill is a SOLID lightening of
 * `primary`, not the gold at reduced opacity: a solid colour is one the label
 * can be measured against, where a translucent one only has a ratio if you
 * assume what is behind it.
 *
 * The label is whichever of `primary.contrastText` and `onPrimaryContainer`
 * reads better ON that fill, and the step backs off in 1% decrements while
 * neither clears AA. On yellow-cta it never backs off: every gold in the ramp
 * carries `#111111` far above 4.5. On black-cta it does, at the last stage —
 * lightening charcoal by a full 36% lands near `#7a7a7a`, the mid grey where
 * white reaches only 4.3:1 and black 4.4:1, so no label would be readable.
 *
 * @param palette - The active theme palette.
 * @param index - Stage position, 0 for the widest.
 * @returns The stage's solid `fill` and the `label` colour to draw its count in.
 */
export function funnelStage(palette: Theme["palette"], index: number) {
  const candidates = [palette.primary.contrastText, palette.onPrimaryContainer];
  let amount = index * FUNNEL_STEP;
  for (;;) {
    const fill = lighten(palette.primary.main, amount);
    const label = candidates.reduce((best, candidate) =>
      contrastRatio(candidate, fill) > contrastRatio(best, fill) ? candidate : best,
    );
    if (amount <= 0 || contrastRatio(label, fill) >= AA_CONTRAST) {
      return { fill, label };
    }
    amount = Math.max(0, amount - 0.01);
  }
}

/**
 * Two hand-set light palettes (openspec design-system "Central theme is the
 * only color source"). Hexes are the spec's tables, not generated — the brand
 * stays yellow / black / white. Shared roles (tertiary, surface, error,
 * WhatsApp) are identical on both palettes.
 */
const ROLE_TABLES: Record<
  PaletteId,
  {
    primary: string;
    onPrimary: string;
    primaryContainer: string;
    onPrimaryContainer: string;
    secondary: string;
    onSecondary: string;
    secondaryContainer: string;
    onSecondaryContainer: string;
  }
> = {
  "yellow-cta": {
    primary: "#EAB63D",
    onPrimary: "#111111",
    primaryContainer: "#FFF3C4",
    onPrimaryContainer: "#111111",
    secondary: "#303030",
    onSecondary: "#FFFFFF",
    secondaryContainer: "#E4E2E1",
    onSecondaryContainer: "#303030",
  },
  "black-cta": {
    primary: "#303030",
    onPrimary: "#FFFFFF",
    primaryContainer: "#EAB63D",
    onPrimaryContainer: "#111111",
    secondary: "#111111",
    onSecondary: "#FFFFFF",
    secondaryContainer: "#E4E2E1",
    onSecondaryContainer: "#111111",
  },
};

/**
 * Spacing uses MUI’s default 8px base. Do not set `spacing: 4`.
 *
 * 4px scale via half-steps:
 *   spacing(0.5) = 4px
 *   spacing(1)   = 8px
 *   spacing(1.5) = 12px
 *   spacing(2)   = 16px
 *   spacing(3)   = 24px
 *   spacing(4)   = 32px
 *   spacing(6)   = 48px
 *   spacing(8)   = 64px
 */
/**
 * Builds the MUI theme for the given palette id.
 * @param id - Active brand palette (`yellow-cta` or `black-cta`) controlling contained CTA colors.
 * @returns MUI `Theme` with hand-set Select Lub tokens and component shape overrides.
 */
export function createAppTheme(id: PaletteId) {
  const roles = ROLE_TABLES[id];
  return createTheme({
    palette: {
      primary: {
        main: roles.primary,
        contrastText: roles.onPrimary,
      },
      secondary: {
        main: roles.secondary,
        contrastText: roles.onSecondary,
      },
      primaryContainer: roles.primaryContainer,
      onPrimaryContainer: roles.onPrimaryContainer,
      secondaryContainer: roles.secondaryContainer,
      onSecondaryContainer: roles.onSecondaryContainer,
      tertiary: "#5f5e5e",
      onTertiary: "#FFFFFF",
      tertiaryContainer: "#e4e2e1",
      onTertiaryContainer: "#474747",
      // Status containers from the artboards' shared foundation: the soft
      // tints a delta chip or a tag is drawn in, identical on both palettes.
      // MUI has no success/error CONTAINER role — `success.main` and
      // `error.main` are full-strength fills — so these are hand-set beside
      // the other container tokens rather than derived from them.
      successContainer: "#e6f4ea",
      onSuccessContainer: "#1e4620",
      errorContainer: "#ffe0e0",
      onErrorContainer: "#8a1c1c",
      // Warning and info complete the set at the same weight as the two the
      // canvas draws: a pale fill with a dark ink of its own hue. They exist
      // because the tag vocabulary has six colours — a mapping that folded
      // warning onto the primary tint and info onto the secondary one made
      // two pairs of tags indistinguishable. Amber is pushed toward peach so
      // it does not read as yellow-cta's lemon primaryContainer #FFF3C4.
      warningContainer: "#ffe9d1",
      onWarningContainer: "#7a3e00",
      infoContainer: "#e0edfb",
      onInfoContainer: "#14457a",
      error: {
        main: "#B3261E",
      },
      background: {
        default: "#FFFFFF",
        paper: "#FFFFFF",
      },
      text: {
        primary: "#111111",
      },
      divider: "#D9D9D9",
      surfaceVariant: "#EDEDED",
      // Hand-set read-tick blue (message-status-ticks-ui D1): identical on
      // both palettes; primary can't serve because yellow-cta's gold fails
      // AA on the white bubble and black-cta's charcoal is indistinguishable.
      readTick: "#1565C0",
      whatsapp: {
        main: "#25D366",
        light: "#25D366",
        dark: "#25D366",
        contrastText: "#111111",
      },
    },
    shape: {
      borderRadius: 8,
    },
    typography: {
      fontFamily: '"Inter", system-ui, sans-serif',
      h1: { fontWeight: 800 },
      h2: { fontWeight: 800 },
      h3: { fontWeight: 800 },
      body1: { fontSize: TYPE_SCALE.body, lineHeight: 1.5 },
      body2: { fontSize: TYPE_SCALE.caption, lineHeight: 1.5 },
    },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          html: {
            scrollPaddingTop: SHELL_BAR_HEIGHT_PX,
            scrollBehavior: "smooth",
            "@media (prefers-reduced-motion: reduce)": {
              scrollBehavior: "auto",
            },
          },
        },
      },
      MuiButtonBase: {
        styleOverrides: {
          root: ({ theme: t }) => ({
            cursor: "pointer",
            transition: t.transitions.create(
              ["background-color", "color", "border-color", "box-shadow"],
              { duration: 200 },
            ),
            "@media (prefers-reduced-motion: reduce)": {
              transition: "none",
            },
            "&.Mui-focusVisible": focusVisibleSx(t),
          }),
        },
      },
      MuiButton: {
        styleOverrides: {
          // Every button is a sentence-case pill (design-system: "Radii SHALL
          // be … 16px (every button …)"; "A button label SHALL keep the case
          // it is written in"). The canvas writes each action as prose —
          // `Criar lembrete`, `Editar unidades` — and never draws MUI's
          // upper-cased default, so the rule lives here, not per call site.
          root: ({ theme: t }) => ({
            borderRadius: t.spacing(2),
            textTransform: "none",
            minHeight: TOUCH_TARGET_PX,
          }),
          // Gold #EAB63D fails AA (~1.9:1) as text on white, so yellow-cta's
          // text-styled primary surfaces render charcoal instead (spec:
          // "Contrast of intended CTA pairs"). black-cta's primary is
          // already charcoal, so its label needs no override. The outlined
          // border is the outline token on both palettes: the canvas's row
          // action is a hairline pill, not a brand-coloured one.
          ...(id === "yellow-cta"
            ? {
                text: { color: "#303030" },
                outlined: { color: "#303030", borderColor: "#D9D9D9" },
              }
            : { outlined: { borderColor: "#D9D9D9" } }),
        },
      },
      MuiToggleButton: {
        styleOverrides: {
          // The header palette toggle draws its options as prose on the
          // artboards (`Amarelo` / `Preto`), but MuiToggleButton inherits
          // typography.button's upper-casing and the MuiButton root override
          // above does not reach it. Radii stay untouched: the toggle's 2px
          // corners are set where the group is laid out (RequireAuth).
          root: {
            textTransform: "none",
            minHeight: TOUCH_TARGET_PX,
            minWidth: TOUCH_TARGET_PX,
          },
        },
      },
      MuiIconButton: {
        styleOverrides: {
          root: {
            minWidth: TOUCH_TARGET_PX,
            minHeight: TOUCH_TARGET_PX,
          },
        },
      },
      MuiLink: {
        styleOverrides: {
          root: ({ theme: t }) => ({
            ...(id === "yellow-cta" ? { color: "#303030" } : {}),
            "&:focus-visible": focusVisibleSx(t),
          }),
        },
      },
      MuiOutlinedInput: {
        styleOverrides: {
          root: ({ theme: t }) => ({
            borderRadius: t.spacing(0.5),
            "&:focus-within": focusVisibleSx(t),
          }),
        },
      },
      MuiChip: {
        styleOverrides: {
          root: ({ theme: t }) => ({
            borderRadius: t.spacing(0.5),
          }),
        },
      },
      MuiDialog: {
        styleOverrides: {
          paper: ({ theme: t }) => ({
            borderRadius: t.spacing(2),
          }),
        },
      },
    },
  });
}

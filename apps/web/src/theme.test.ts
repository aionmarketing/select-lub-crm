/**
 * Test design (testing-strategy)
 *
 * Setup: createAppTheme(id) from theme.ts. No network, no DOM.
 *
 * Oracle: openspec design-system "Central theme is the only color source"
 * (brand-palette-switch) — two hand-set light palettes `yellow-cta` (default)
 * and `black-cta` whose hexes are the spec's tables; tertiary, surface,
 * WhatsApp, error and the eight status containers (success, error, warning
 * and info container, each with its on-colour) shared; WhatsApp never `success`; 8px spacing base with
 * 4px half-steps; radii 4/8/16px; every button a sentence-case pill
 * (align-shipped-ui-to-pdf-artboards: 16px on the button ROOT, not only on
 * contained, and no upper-casing) — and the header palette toggle is
 * sentence-case for the same reason, through its own component override
 * because MuiButton's does not reach MuiToggleButton. Hexes come from the
 * spec tables, not from running the factory.
 *
 * Axes
 *   A1 palette id — "yellow-cta" / "black-cta" (closed union; no invalid id
 *      case: PaletteId is a compile-time literal union, a third string does
 *      not typecheck — contract-hidden)
 *   A2 token group — role table / shared tokens / spacing / radii / label
 *      case / the funnel ramp
 *   A3 funnel stage — 0 (untouched primary) / 1–2 (plain step) / 3 (the step
 *      that has to back off on black-cta)
 *
 * Outputs
 *   O1 role hexes match the palette's spec table
 *   O2 shared tokens identical on both palettes
 *   O3 success.main ≠ #25D366
 *   O4 spacing strings 4…64px; radii 4/8/16px
 *   O5 yellow-cta charcoal on text/outlined/link; black-cta outlined border only
 *   O6 button root 16px radius, sentence case, minHeight 44
 *   O7 palette toggle sentence-case AND 44px min
 *   O8 funnel stages ≥ 4.5
 *   O9 TYPE_SCALE.caption ≥ 12; no step below 12 except that floor is the caption
 *   O10 html scroll-padding-top = shell bar 52; smooth scroll unless reduced motion
 *   O11 ButtonBase focus-visible outline uses secondary.main; reduced-motion kills transition
 *   O12 IconButton min 44×44
 *   O13 OutlinedInput focus-within uses the same 2px ring
 *
 * Sampled-cell
 *   yellow-cta matches its table   | A1 yellow  | O1+O2 | any spec hex drifted
 *   black-cta matches its table    | A1 black   | O1+O2 | any spec hex drifted
 *   WhatsApp not success           | A2 shared  | O3    | success aliased green
 *   8px spacing base               | A2 spacing | O4    | spacing(0.5) ≠ 4px
 *   4 / 8 / 16px radii             | A2 radii   | O4    | button root radius ≠ 16px
 *   sentence-case pill, both       | A1 both    | O6    | textTransform upper-cases
 *   sentence-case toggle, both     | A1 both    | O7    | palette toggle upper-cases
 *   funnel ramp readable, both     | A1+A3 both | O8    | a stage label under 4.5
 *   ramp starts at primary         | A3 0       | O8    | stage 1 already lightened
 *   contrastRatio rejects #fff     | A2 ramp    | O8    | a short hex parses silently
 *   yellow text-primary charcoal   | A1 yellow  | O5    | gold links on white return
 *   black-cta has no link colour   | A1 black   | O5    | charcoal colour forced on black
 *   caption not below 12px         | A2 type    | O9    | TYPE_SCALE.caption < 12
 *   scroll-padding under the bar   | A2 chrome  | O10   | html padding missing
 *   focus ring + reduced motion    | A1 both    | O11   | outline missing or hex
 *   icon button 44px               | A2 touch   | O12   | IconButton min smaller
 *   input focus-within ring       | A1 both    | O13   | inputs skip the ring
 *
 * Outputs (cont.): O5 — yellow-cta overrides MuiLink and the text/outlined
 * MuiButton LABEL to #303030 (design D10); black-cta declares no text-button
 * label and no link `color`, only the outline border and a shared focus ring.
 * O6 — the MuiButton root override on either palette returns 16px radius,
 * textTransform "none", and minHeight 44. O7 — the MuiToggleButton root
 * override is sentence-case plus 44px min size, and declares no radius (the
 * toggle's 2px corners belong to RequireAuth's layout). O8 — funnelStage
 * returns a SOLID fill starting at primary.main, and a label that clears 4.5
 * on that fill for every stage of both palettes; contrastRatio reads hex and
 * rgb() and throws on anything else, so a malformed colour cannot parse to a
 * passing ratio. O9–O12 — type floor, scroll-padding, focus ring, icon target.
 *
 * Decision / branch map (theme.ts): funnelStage's back-off loop — T (a stage
 * whose best label is under AA) taken only by black-cta's last stage, F by
 * every yellow-cta stage and black-cta's first three; parseColor's rgb match —
 * T for a lightened fill, F for a role-table hex, throw for the rest.
 * `ROLE_TABLES[id]` lookup has no branch;
 * the two `id === "yellow-cta"` ternaries (button variants, MuiLink colour) — T taken
 * by the yellow override it; F by the black-cta it, which now asserts the
 * palette-independent outlined border that the F arm still declares, and a
 * Link root with no `color` key. The
 * MuiToggleButton override sits outside both ternaries, so it is unbranched
 * and the per-palette cases assert the same object twice by design. MuiLink
 * root is a callback on both palettes (focus ring always; colour only on yellow).
 *
 * Out of scope: contrast ratios (contrast.test.ts); the palette store and
 * header switch (paletteStore.test.ts / paletteSwitch.test.tsx); Inter files.
 */
import { describe, expect, it } from "vitest";
import { lighten } from "@mui/material/styles";
import {
  contrastRatio,
  createAppTheme,
  funnelStage,
  SHELL_BAR_HEIGHT_PX,
  TOUCH_TARGET_PX,
  TYPE_SCALE,
} from "./theme.js";

function invokeOverride(override: unknown, theme: ReturnType<typeof createAppTheme>) {
  if (typeof override !== "function") {
    throw new Error("expected a style override callback");
  }
  return override({ theme } as never) as Record<string, unknown>;
}

function sharedTokenChecks(theme: ReturnType<typeof createAppTheme>) {
  expect(theme.palette.tertiary).toBe("#5f5e5e");
  expect(theme.palette.onTertiary).toBe("#FFFFFF");
  expect(theme.palette.tertiaryContainer).toBe("#e4e2e1");
  expect(theme.palette.onTertiaryContainer).toBe("#474747");
  expect(theme.palette.whatsapp.main).toBe("#25D366");
  expect(theme.palette.whatsapp.contrastText).toBe("#111111");
  expect(theme.palette.readTick).toBe("#1565C0");
  expect(theme.palette.successContainer).toBe("#e6f4ea");
  expect(theme.palette.onSuccessContainer).toBe("#1e4620");
  expect(theme.palette.errorContainer).toBe("#ffe0e0");
  expect(theme.palette.onErrorContainer).toBe("#8a1c1c");
  expect(theme.palette.warningContainer).toBe("#ffe9d1");
  expect(theme.palette.onWarningContainer).toBe("#7a3e00");
  expect(theme.palette.infoContainer).toBe("#e0edfb");
  expect(theme.palette.onInfoContainer).toBe("#14457a");
  expect(theme.palette.background.default).toBe("#FFFFFF");
  expect(theme.palette.background.paper).toBe("#FFFFFF");
  expect(theme.palette.surfaceVariant).toBe("#EDEDED");
  expect(theme.palette.text.primary).toBe("#111111");
  expect(theme.palette.divider).toBe("#D9D9D9");
  expect(theme.palette.error.main).toBe("#B3261E");
}

describe("theme palettes", () => {
  it("yellow-cta matches its spec table and the shared tokens", () => {
    const theme = createAppTheme("yellow-cta");
    expect(theme.palette.primary.main).toBe("#EAB63D");
    expect(theme.palette.primary.contrastText).toBe("#111111");
    expect(theme.palette.primaryContainer).toBe("#FFF3C4");
    expect(theme.palette.onPrimaryContainer).toBe("#111111");
    expect(theme.palette.secondary.main).toBe("#303030");
    expect(theme.palette.secondary.contrastText).toBe("#FFFFFF");
    expect(theme.palette.secondaryContainer).toBe("#E4E2E1");
    expect(theme.palette.onSecondaryContainer).toBe("#303030");
    sharedTokenChecks(theme);
  });

  it("black-cta matches its spec table and the shared tokens", () => {
    const theme = createAppTheme("black-cta");
    expect(theme.palette.primary.main).toBe("#303030");
    expect(theme.palette.primary.contrastText).toBe("#FFFFFF");
    expect(theme.palette.primaryContainer).toBe("#EAB63D");
    expect(theme.palette.onPrimaryContainer).toBe("#111111");
    expect(theme.palette.secondary.main).toBe("#111111");
    expect(theme.palette.secondary.contrastText).toBe("#FFFFFF");
    expect(theme.palette.secondaryContainer).toBe("#E4E2E1");
    expect(theme.palette.onSecondaryContainer).toBe("#111111");
    sharedTokenChecks(theme);
  });

  it("does not map WhatsApp green onto success on either palette", () => {
    expect(createAppTheme("yellow-cta").palette.success.main).not.toBe("#25D366");
    expect(createAppTheme("black-cta").palette.success.main).not.toBe("#25D366");
  });

  it("keeps MUI 8px spacing base", () => {
    const theme = createAppTheme("yellow-cta");
    expect([0.5, 1, 1.5, 2, 3, 4, 6, 8].map((step) => theme.spacing(step))).toEqual([
      "4px",
      "8px",
      "12px",
      "16px",
      "24px",
      "32px",
      "48px",
      "64px",
    ]);
  });

  it("renders yellow-cta text-styled primary surfaces in charcoal (design D10)", () => {
    const theme = createAppTheme("yellow-cta");
    const link = invokeOverride(theme.components?.MuiLink?.styleOverrides?.root, theme);
    expect(link["color"]).toBe("#303030");
    expect(theme.components?.MuiButton?.styleOverrides?.text).toEqual({
      color: "#303030",
    });
    expect(theme.components?.MuiButton?.styleOverrides?.outlined).toEqual({
      color: "#303030",
      borderColor: "#D9D9D9",
    });
  });

  it("black-cta declares no link or text-button label colour, only the outline border", () => {
    const theme = createAppTheme("black-cta");
    const link = invokeOverride(theme.components?.MuiLink?.styleOverrides?.root, theme);
    expect(link["color"]).toBeUndefined();
    expect(theme.components?.MuiButton?.styleOverrides?.text).toBeUndefined();
    expect(theme.components?.MuiButton?.styleOverrides?.outlined).toEqual({
      borderColor: "#D9D9D9",
    });
  });

  it.each(["yellow-cta", "black-cta"] as const)(
    "makes every button a sentence-case 16px pill with a 44px min height on %s",
    (id) => {
      const theme = createAppTheme(id);
      const styles = invokeOverride(
        theme.components?.MuiButton?.styleOverrides?.root,
        theme,
      );

      expect(styles).toEqual({
        borderRadius: "16px",
        textTransform: "none",
        minHeight: TOUCH_TARGET_PX,
      });
    },
  );

  it.each(["yellow-cta", "black-cta"] as const)(
    "keeps the header palette toggle sentence-case and 44px on %s",
    (id) => {
      const theme = createAppTheme(id);
      expect(theme.components?.MuiToggleButton?.styleOverrides?.root).toEqual({
        textTransform: "none",
        minHeight: TOUCH_TARGET_PX,
        minWidth: TOUCH_TARGET_PX,
      });
    },
  );

  it.each(["yellow-cta", "black-cta"] as const)(
    "ramps the funnel from primary with every stage label at AA on %s",
    (id) => {
      const theme = createAppTheme(id);
      const stages = [0, 1, 2, 3].map((index) => funnelStage(theme.palette, index));

      // Stage 0 is the brand colour itself, only recomposed as rgb() by
      // lighten(0), so the ramp starts where the artboard starts.
      expect(stages[0]!.fill).toBe(lighten(theme.palette.primary.main, 0));
      for (const stage of stages) {
        expect(contrastRatio(stage.label, stage.fill)).toBeGreaterThanOrEqual(4.5);
      }
    },
  );

  it("reads hex and rgb() alike and refuses anything else", () => {
    expect(contrastRatio("#FFFFFF", "rgb(0, 0, 0)")).toBeCloseTo(21, 1);
    expect(contrastRatio("rgb(255, 255, 255)", "#000000")).toBeCloseTo(21, 1);
    expect(() => contrastRatio("#fff", "#000000")).toThrow(
      /expected 6-digit hex or rgb/,
    );
  });

  it("applies 4 / 8 / 16px radii", () => {
    const theme = createAppTheme("yellow-cta");
    expect(theme.shape.borderRadius).toBe(8);
    const input = theme.components?.MuiOutlinedInput?.styleOverrides?.root;
    const chip = theme.components?.MuiChip?.styleOverrides?.root;
    const button = theme.components?.MuiButton?.styleOverrides?.root;
    const dialog = theme.components?.MuiDialog?.styleOverrides?.paper;
    if (
      typeof input !== "function" ||
      typeof chip !== "function" ||
      typeof button !== "function" ||
      typeof dialog !== "function"
    ) {
      throw new Error("expected theme radius overrides to be callbacks");
    }
    const props = { theme } as never;
    expect((input(props) as { borderRadius: string }).borderRadius).toBe("4px");
    expect((chip(props) as { borderRadius: string }).borderRadius).toBe("4px");
    expect((button(props) as { borderRadius: string }).borderRadius).toBe("16px");
    expect((dialog(props) as { borderRadius: string }).borderRadius).toBe("16px");
  });

  it("keeps every type-scale step at or above 12px", () => {
    expect(TYPE_SCALE.caption).toBe(12);
    for (const [name, size] of Object.entries(TYPE_SCALE)) {
      expect(size, name).toBeGreaterThanOrEqual(12);
    }
  });

  it("offsets focused content below the authenticated bar and smooth-scrolls unless motion is reduced", () => {
    const theme = createAppTheme("yellow-cta");
    expect(theme.components?.MuiCssBaseline?.styleOverrides).toEqual({
      html: {
        scrollPaddingTop: SHELL_BAR_HEIGHT_PX,
        scrollBehavior: "smooth",
        "@media (prefers-reduced-motion: reduce)": {
          scrollBehavior: "auto",
        },
      },
    });
    expect(SHELL_BAR_HEIGHT_PX).toBe(52);
  });

  it.each(["yellow-cta", "black-cta"] as const)(
    "draws a 2px secondary focus ring and skips motion when reduced on %s",
    (id) => {
      const theme = createAppTheme(id);
      const base = invokeOverride(
        theme.components?.MuiButtonBase?.styleOverrides?.root,
        theme,
      );
      const ring = {
        outline: `2px solid ${theme.palette.secondary.main}`,
        outlineOffset: "2px",
      };
      expect(base["&.Mui-focusVisible"]).toEqual(ring);
      expect(base["@media (prefers-reduced-motion: reduce)"]).toEqual({
        transition: "none",
      });
      const link = invokeOverride(
        theme.components?.MuiLink?.styleOverrides?.root,
        theme,
      );
      expect(link["&:focus-visible"]).toEqual(ring);
      const input = invokeOverride(
        theme.components?.MuiOutlinedInput?.styleOverrides?.root,
        theme,
      );
      expect(input["&:focus-within"]).toEqual(ring);
    },
  );

  it("gives icon buttons a 44px minimum target", () => {
    expect(
      createAppTheme("yellow-cta").components?.MuiIconButton?.styleOverrides?.root,
    ).toEqual({
      minWidth: TOUCH_TARGET_PX,
      minHeight: TOUCH_TARGET_PX,
    });
  });
});

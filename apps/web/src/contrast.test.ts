/**
 * Test design (testing-strategy)
 *
 * Setup: contrastRatio() in this file + createAppTheme(id). No browser.
 * Ratio = (lighter luminance + 0.05) / (darker + 0.05).
 *
 * Oracle: openspec design-system "Contrast of intended CTA pairs"
 * (brand-palette-switch) — each working palette meets WCAG 2.2 AA (≥ 4.5:1)
 * on: on-primary/primary, on-primary-container/primary-container,
 * on-secondary/secondary, on-secondary-container/secondary-container,
 * on-tertiary/tertiary, on-tertiary-container/tertiary-container,
 * on-surface/surface, whatsapp pair, and the four status-container pairs
 * (success, error, warning and info) — the two the artboards' shared
 * foundation adds, plus the two that complete the tag vocabulary. Gold #EAB63D as text on white stays
 * banned (< 4.5).
 *
 * Axes
 *   A1 palette — yellow-cta / black-cta (test.each; closed union)
 *   A2 pair — the eight spec pairs / banned gold-on-white / malformed hex
 *
 * Outputs
 *   O1 each spec pair ≥ 4.5 on both palettes
 *   O2 gold-on-white < 4.5
 *   O3 3-digit hex throws
 *
 * Sampled-cell
 *   eight pairs per palette (test.each) | A1 both A2 pairs | O1 | any pair < 4.5
 *   gold-on-white banned               | A2 banned        | O2 | helper ≥ 4.5 on swap
 *   3-digit hex throws                 | A2 malformed     | O3 | silent parse
 *
 * Decision / branch map (this file's helpers; theme.ts has no branches):
 *   parseHex `length !== 6` — T: 3-digit throw it; F: every other it
 *   channelToLinear `s <= 0.04045` — T: black channels (#111111, #303030
 *     low channels) in the pair its; F: high channels everywhere
 *
 * Out of scope: elevation overlays; WCAG 3:1 large-text; 4.49/4.50 BVA (the
 * cutoff is a matcher at the call site, not a branch in contrastRatio).
 */
import { describe, expect, it } from "vitest";
import { createAppTheme, type PaletteId } from "./theme.js";

function channelToLinear(channel: number) {
  const s = channel / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function parseHex(hex: string) {
  const normalized = hex.replace("#", "");
  if (normalized.length !== 6) {
    throw new Error(`expected 6-digit hex, got ${hex}`);
  }
  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16),
  };
}

function relativeLuminance(hex: string) {
  const { r, g, b } = parseHex(hex);
  return (
    0.2126 * channelToLinear(r) +
    0.7152 * channelToLinear(g) +
    0.0722 * channelToLinear(b)
  );
}

function contrastRatio(foreground: string, background: string) {
  const L1 = relativeLuminance(foreground);
  const L2 = relativeLuminance(background);
  const lighter = Math.max(L1, L2);
  const darker = Math.min(L1, L2);
  return (lighter + 0.05) / (darker + 0.05);
}

describe("theme contrast", () => {
  it("fails gold-on-white so the helper would catch a swapped pair", () => {
    expect(contrastRatio("#EAB63D", "#FFFFFF")).toBeLessThan(4.5);
  });

  it("throws when parseHex is given a 3-digit hex", () => {
    expect(() => contrastRatio("#fff", "#000000")).toThrow(/expected 6-digit hex/);
  });

  it.each<PaletteId>(["yellow-cta", "black-cta"])(
    "meets WCAG AA on every spec pair for %s",
    (id) => {
      const theme = createAppTheme(id);
      const pairs: [string, string][] = [
        [theme.palette.primary.contrastText, theme.palette.primary.main],
        [theme.palette.onPrimaryContainer, theme.palette.primaryContainer],
        [theme.palette.secondary.contrastText, theme.palette.secondary.main],
        [theme.palette.onSecondaryContainer, theme.palette.secondaryContainer],
        [theme.palette.onTertiary, theme.palette.tertiary],
        [theme.palette.onTertiaryContainer, theme.palette.tertiaryContainer],
        [theme.palette.text.primary, theme.palette.background.default],
        [theme.palette.whatsapp.contrastText, theme.palette.whatsapp.main],
        // readTick blue on the white bubble (message-status-ticks-ui D1)
        [theme.palette.readTick, theme.palette.background.paper],
        [theme.palette.onSuccessContainer, theme.palette.successContainer],
        [theme.palette.onErrorContainer, theme.palette.errorContainer],
        [theme.palette.onWarningContainer, theme.palette.warningContainer],
        [theme.palette.onInfoContainer, theme.palette.infoContainer],
      ];
      for (const [foreground, background] of pairs) {
        expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(4.5);
      }
    },
  );
});

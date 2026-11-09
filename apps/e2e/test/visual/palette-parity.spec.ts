/// <reference lib="dom" />
// The e2e tsconfig loads only Node types. These files pass callbacks to
// `page.evaluate`, whose body runs in the browser, so DOM globals are legitimately in
// scope there and must be declared for the compiler. Scoped to this file rather than
// widened in the shared tsconfig, which other suites depend on.

/**
 * Test design (testing-strategy + testing-playwright)
 *
 * Under test: that switching the palette changes colour only, never geometry. The two
 * palettes are a shared primitive — `theme.ts` builds both from the same scale — so a
 * token that accidentally carries a size, a border width or a font weight would move
 * layout on every screen at once, which is precisely the "related routes sharing a
 * primitive" failure the visual-qa skill asks to be proven.
 *
 * ORACLE: `openspec/specs/design-system/spec.md` requires the two palettes to be the
 * same design system with different CTA colours; nothing in it authorises a
 * palette-dependent layout. Combined with the 2026-09-07 capture, where all 60
 * measurements came out with identical per-element geometry across `yellow-cta` and
 * `black-cta`, the expected result is equality.
 *
 * Technique: differential (A/B) testing. The same route is measured twice with only
 * `select-lub.palette` in localStorage varied, and the two geometric fingerprints are
 * compared. This is what lets `desktop-overflow.spec.ts` legitimately test one palette
 * instead of doubling every case.
 *
 * Measured at 720 px (200% zoom at 1440) ON PURPOSE. At the desktop widths both
 * palettes produce zero offenders, so comparing empty lists would pass no matter what
 * the palette did. At 720 px `/servicos` produces 30 offenders, so the comparison has
 * real content to disagree about on at least one route and cannot pass vacuously
 * everywhere. Where a route has no offenders the assertion still pins `clientWidth`
 * and the page-level scroll flag.
 *
 * Not covered: colour itself. Whether the black CTA is the right black is the owner's
 * judgement on the PNGs, and `contrast.test.ts` in `apps/web` owns the token-level
 * contrast rules. Nothing here asserts appearance.
 */
import { expect, test, type Browser } from "@playwright/test";
import { gotoRoute, measure, ROUTES } from "./measure.js";

/** `paletteStore.ts` reads this key; anything but `black-cta` falls back to yellow. */
const PALETTE_STORAGE_KEY = "select-lub.palette";
const ZOOM_200_AT_1440 = { width: 720, height: 900 } as const;

/**
 * Measures one route with one palette pre-set, in a context of its own.
 *
 * The palette is written by an init script rather than after load, so the first paint
 * is already themed and no measurement can catch a flash of the default palette.
 *
 * @param browser - Playwright browser to open an isolated context on.
 * @param palette - Value for `select-lub.palette`.
 * @param routePath - App-relative path to measure.
 * @param baseURL - Origin from the Playwright `baseURL` fixture (CI `5173`, or
 *   `VISUAL_BASE_URL` under the standalone visual config). Isolated contexts do
 *   not inherit `use.baseURL`.
 * @returns The geometric fingerprint used for the A/B comparison.
 */
async function measureWithPalette(
  browser: Browser,
  palette: string,
  routePath: string,
  baseURL: string | undefined,
) {
  // Isolated context so localStorage cannot leak between palettes. `browser.newContext`
  // does not inherit Playwright `use.baseURL`, so pass the fixture origin through —
  // `VISUAL_BASE_URL` is unset in the main CI config, and `undefined` here made
  // `goto("/")` an invalid URL.
  if (!baseURL) {
    throw new Error(
      "measureWithPalette needs the Playwright baseURL fixture; isolated contexts do not inherit use.baseURL",
    );
  }
  const context = await browser.newContext({
    viewport: ZOOM_200_AT_1440,
    deviceScaleFactor: 2,
    baseURL,
  });
  await context.addInitScript(
    ([key, value]) => window.localStorage.setItem(key, value),
    [PALETTE_STORAGE_KEY, palette],
  );
  try {
    const page = await context.newPage();
    await gotoRoute(page, routePath);
    const result = await measure(page);
    return {
      clientWidth: result.clientWidth,
      documentScrollsHorizontally: result.documentScrollsHorizontally,
      renderedHeadings: result.renderedHeadings,
      // Geometry only — text is excluded so a copy change cannot fail a layout test.
      offenders: result.offenders.map((o) => ({
        tag: o.tag,
        overshoot: o.overshoot,
        width: o.width,
        reachableByScrolling: o.reachableByScrolling,
      })),
    };
  } finally {
    await context.close();
  }
}

for (const route of ROUTES) {
  test(`${route.slug} has identical geometry in both palettes`, async ({
    browser,
    baseURL,
  }) => {
    const yellow = await measureWithPalette(browser, "yellow-cta", route.path, baseURL);
    const black = await measureWithPalette(browser, "black-cta", route.path, baseURL);

    // Render proof for both arms: two blank pages also match each other.
    expect(yellow.renderedHeadings).toBe(1);
    expect(black.renderedHeadings).toBe(1);

    expect(black).toEqual(yellow);
  });
}

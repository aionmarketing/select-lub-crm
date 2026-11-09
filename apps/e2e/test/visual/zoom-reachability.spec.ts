/**
 * Test design (testing-strategy + testing-playwright)
 *
 * Under test: whether content stays REACHABLE at 200% browser zoom. Browser zoom has
 * no Playwright API, and 200% zoom is exactly a half-width layout viewport at
 * `deviceScaleFactor: 2`, so it is expressed that way rather than approximated: 1440
 * CSS px zoomed to 200% is a 720 px layout viewport. Taken at 1440 rather than 1024
 * because 720 effective px is a width a desktop layout might plausibly survive, so a
 * finding is actionable, where a 512 px break on a desktop-only app is not.
 *
 * ORACLE: WCAG 2.1 SC 1.4.4 (Resize text) — content and functionality must remain
 * available when text is scaled to 200%. This is an external standard, NOT an OpenSpec
 * scenario; no spec in `openspec/specs/` governs zoom. It is named here rather than
 * invented, and it is why these cases live in their own file: their findings are
 * accessibility findings, and averaging them into `desktop-overflow.spec.ts` would let
 * an accessibility regression read as a desktop-layout pass.
 *
 * What "reachable" means operationally: an element may extend past the viewport's right
 * edge WITHOUT being a defect, provided some ancestor scrolls horizontally, because the
 * user can still bring it into view. The defect is content that overshoots while
 * NOTHING scrolls — then it is clipped and simply unavailable. So the assertion is on
 * `reachableByScrolling`, not on the mere existence of an overshoot.
 *
 * Measured state on 2026-09-07, recorded so a future reader can tell a regression from
 * the status quo: only `/servicos` overshoots at this width — its Detalhes pane is
 * 320 px inside a 300 px column, overshooting the viewport by 44 px — and every one of
 * its 30 overshooting elements sits inside a `overflow-x: auto` ancestor that scrolls
 * (clientWidth 300, scrollWidth 344). So the content is awkward, not lost. The other
 * five routes had no overshoot at all.
 *
 * Deliberately NOT asserted: that `/servicos` still overshoots. Pinning the current
 * overshoot would turn a fix into a failure, which is a test defending a defect.
 *
 * Vacuity, stated plainly: on the five routes with no offenders the per-offender loop
 * asserts nothing. The claim carrying weight on every route is
 * `documentScrollsHorizontally === false` — a real, currently-true, falsifiable
 * statement — plus the render proof. The offender loop is what catches the regression
 * where a future layout clips content at zoom.
 *
 * Not covered: text legibility, focus order, and contrast at zoom. Those need a human
 * or an axe run, and are out of scope for a geometry suite.
 */
import { expect, test } from "@playwright/test";
import { gotoRoute, measure, ROUTES } from "./measure.js";

/** 1440 CSS px at 200% zoom is a 720 px layout viewport at 2x. */
const ZOOM_200_AT_1440 = { width: 720, height: 900 } as const;

for (const route of ROUTES) {
  test(`${route.slug} keeps content reachable at 200% zoom`, async ({ page }) => {
    await page.setViewportSize(ZOOM_200_AT_1440);
    await gotoRoute(page, route.path);

    const result = await measure(page);

    // Render proof: without it every assertion below passes against a blank page.
    expect(result.renderedHeadings).toBe(1);
    expect(result.bodyChars).toBeGreaterThan(40);
    expect(result.clientWidth).toBe(ZOOM_200_AT_1440.width);

    // The non-vacuous claim, true on all six routes today.
    expect(result.documentScrollsHorizontally).toBe(false);

    // Overshoot is allowed; unreachable overshoot is not.
    const unreachable = result.offenders.filter((o) => !o.reachableByScrolling);
    expect(unreachable).toEqual([]);
  });
}

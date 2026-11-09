/**
 * Test design (testing-strategy + testing-playwright)
 *
 * Under test: horizontal layout geometry of the six product routes at the desktop
 * widths this product actually targets. Asserts the PER-ELEMENT result, not a
 * page-level boolean — page overflow alone does not attribute a defect to anything,
 * which is the gap the 2026-09-05 `overflow.json` round left.
 *
 * ORACLE, and its limits — read before trusting this file. There is NO OpenSpec
 * scenario governing viewport behaviour. `AGENTS.md` (§4) asks whoever specs a screen
 * to state its responsive behaviour, and no spec author did. The expected result here
 * is the OWNER's ruling of 2026-09-07, relayed through the coordinating session: the
 * app is desktop-only. That is a human-supplied oracle recorded in a session, not a
 * spec, so per `openspec/specs/repo-foundation/spec.md` (§"Reachable production
 * decisions have both test outcomes", the unspecified-UI-branch clause) this is named
 * rather than invented, and a spec delta for design-system responsive behaviour is
 * still owed. Do not treat these widths as settled until that delta lands.
 *
 * Technique: boundary-value analysis on viewport width. 1024 is the low boundary —
 * the smallest laptop an attendant plausibly uses — and 1920 the high one, because a
 * layout can fail by stretching as well as by cramping. 1280 and 1440 are interior
 * points; they are exercised by the capture harness on every run rather than duplicated
 * here, so this suite stays fast enough to run per pull request.
 *
 * Partitions: route (all six, since shared primitives leak between screens) × width
 * boundary (low, high).
 *
 * Not covered here, deliberately:
 * - Palette. The 2026-09-07 capture measured all 60 combinations and the per-element
 *   results are byte-identical between `yellow-cta` and `black-cta`, so palette does
 *   not move geometry. `palette-parity.spec.ts` asserts that directly instead of
 *   multiplying every case here by two.
 * - 200% zoom. Its findings are WCAG 1.4.4, not desktop layout, and mixing them into
 *   this file would let an accessibility regression read as a layout pass. See
 *   `zoom-reachability.spec.ts`.
 * - Appearance. Wrapping rhythm, spacing and taste are the owner's call on the PNGs;
 *   nothing here asserts that a screen looks right.
 *
 * Vacuity guard: every case asserts the page actually rendered (one `h1`, non-trivial
 * text) BEFORE asserting no overflow. Without it "no element sticks out" passes
 * perfectly against a blank page, which is exactly how a broken capture looks.
 */
import { expect, test } from "@playwright/test";
import { gotoRoute, measure, ROUTES } from "./measure.js";

const DESKTOP_WIDTH_BOUNDARIES = [
  { label: "1024-floor", width: 1024 },
  { label: "1920-ceiling", width: 1920 },
] as const;

for (const route of ROUTES) {
  for (const viewport of DESKTOP_WIDTH_BOUNDARIES) {
    test(`${route.slug} has no element overflowing at ${viewport.label}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: 900 });
      await gotoRoute(page, route.path);

      const result = await measure(page);

      // Render proof first: the assertions below are meaningless against a blank page.
      expect(result.renderedHeadings).toBe(1);
      expect(result.bodyChars).toBeGreaterThan(40);
      expect(result.clientWidth).toBe(viewport.width);

      // The finding is the element list, so failure output names what to fix.
      expect(result.offenders).toEqual([]);
      expect(result.documentScrollsHorizontally).toBe(false);
    });
  }
}

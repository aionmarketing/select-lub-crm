/**
 * Test design (testing-strategy)
 *
 * Setup: renders the shared page shell and the icon rail under MemoryRouter,
 * once per screen. Antigravity-only: every case is skipped when the suite runs
 * in the default mode, because the cursor variant draws a horizontal row and
 * these assertions are about the rail.
 *
 * Oracle: openspec/changes/build-time-ui-variant specs/design-system —
 * "Icon rail on every antigravity screen" (56px left column, all six entries,
 * aria-current on the current one, no nav row above the content) and
 * "Accessibility floor on every variant" (44px entries, named by their screen,
 * skip link reaching the main landmark).
 *
 * Axes
 *   A1 screen — each of the six routes
 *   A2 entry state — current vs not current
 *
 * Outputs
 *   O1 rail is a left column beside main, not a strip above it
 *   O2 all six labels present; exactly one aria-current="page"
 *   O3 each entry meets the 44px floor and is named by its screen
 *   O4 the main landmark carries MAIN_CONTENT_ID and is focusable
 *
 * Sampled-cell
 *   rail beside main    | A1 all  | O1 | shell stacks the rail above the page
 *   six entries + mark  | A1 all  | O2 | a screen omits an entry, as three did
 *   44px + named        | A2 both | O3 | icon-only entry with no accessible name
 *   landmark present    | A1 one  | O4 | skip link with nothing to reach
 *
 * What would make a test fail:
 *   PageShell losing its variant-aware direction (the rail becomes a 56px-tall
 *   strip); an entry rendered icon-only without aria-label; the main landmark
 *   dropped from the antigravity page, which is what left the skip link
 *   pointing at nothing when the composition was first imported.
 *
 * Production decisions: none. This suite reads rendered chrome.
 *
 * Not in this file: the Conversas four-column layout and the rail's cards
 * (conversas.antigravity.test.tsx); behaviour shared with cursor, which the
 * unbranched suites already cover in both modes.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { PageShell } from "./PageShell.js";
import { SCREENS } from "./screens.js";
import { MAIN_CONTENT_ID, TOUCH_TARGET_PX } from "./theme.js";
import { UI_VARIANT } from "./uiVariant.js";

const onAntigravity = UI_VARIANT === "antigravity" ? describe : describe.skip;

function renderShell(current: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[current]}>
        <PageShell current={current} title="Título">
          <div>conteúdo</div>
        </PageShell>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { nav: screen.getByRole("navigation"), main: screen.getByRole("main") };
}

onAntigravity("antigravity shell", () => {
  it.each(SCREENS.map((entry) => [entry.label, entry.to] as const))(
    "puts the rail beside the page on %s",
    (_label, to) => {
      const { nav, main } = renderShell(to);

      // Beside, not above: the shell's own axis has to be the rail's, or a
      // 56px-wide column renders as a 56px-tall strip across the top.
      expect(nav.parentElement).toHaveStyle({ flexDirection: "row" });
      expect(nav).toHaveStyle({ width: "56px" });
      expect(nav.compareDocumentPosition(main)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    },
  );

  it.each(SCREENS.map((entry) => [entry.label, entry.to] as const))(
    "lists all six screens and marks only %s",
    (label, to) => {
      const { nav } = renderShell(to);

      for (const entry of SCREENS) {
        expect(within(nav).getByText(entry.label)).toBeInTheDocument();
      }
      const marked = within(nav).getAllByLabelText(label, {
        selector: "[aria-current]",
      });
      expect(marked).toHaveLength(1);
      expect(nav.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    },
  );

  it("names every entry by its screen and meets the 44px floor", () => {
    const { nav } = renderShell("/");

    for (const entry of SCREENS) {
      // The current screen is not a link, so query by accessible name rather
      // than by role — the floor applies to both shapes.
      const [item] = within(nav).getAllByLabelText(entry.label);
      expect(item, entry.label).toBeInTheDocument();
      expect(item, entry.label).toHaveStyle({ minHeight: `${TOUCH_TARGET_PX}px` });
    }
  });

  it("gives the skip link a main landmark to reach", () => {
    const { main } = renderShell("/relatorios");

    expect(main).toHaveAttribute("id", MAIN_CONTENT_ID);
    expect(main).toHaveAttribute("tabindex", "-1");
  });
});

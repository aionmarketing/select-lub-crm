/**
 * Test design (testing-strategy)
 *
 * Setup: ScreenNav rendered directly under MemoryRouter — the row takes only a
 * `current` route, so no providers, no MSW and no page shell are needed.
 *
 * Oracle: align-shipped-ui-to-revised-canvas tasks 1.2 and 1.3 — one shared
 * component used by every page, all six entries present, the current screen
 * marked "by weight and an underline rather than by bold text alone", and the
 * page heading outside the row. Divergence item 26's badge is NOT covered here;
 * it arrives with task 13.6.
 *
 * The regression this exists to prevent is drift, not a bug: before extraction
 * Relatórios listed four screens plus the Galeria QA page, and Configurações
 * and Usuários each omitted Relatórios. Those passed every test that existed,
 * because no test asserted the SET of entries.
 *
 * Axes
 *   A1 current route: each of the six / a route in no screen (e.g. /galeria)
 *   A2 entry set: all six present / no extra entries
 *   A3 marking: exactly one aria-current / the rest are links
 *   A4 mark treatment: weight AND underline colour, not weight alone
 *   A5 touch target: current item / link, both 44px minHeight
 *
 * Outputs: O1 accessible roles and names; O2 aria-current; O3 computed style;
 * O4 absence
 *
 * Sampled-cell
 *   it                                        | axes    | expect | fails if
 *   lists all six screens on every route      | A1,A2   | O1  | an entry is missing
 *   marks exactly the current screen          | A1,A3   | O2  | zero or two marked
 *   marks by underline as well as weight      | A4      | O3  | weight alone
 *   gives every nav entry a 44px min          | A5      | O3  | minHeight smaller
 *   offers no link to the screen you are on   | A3      | O4  | self-link
 *   an unknown route marks nothing            | A1,A3   | O4  | throws or marks one
 *   carries no Galeria entry                  | A2      | O4  | QA page in the nav
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { FollowUpOptionalCounts } from "@select-lub/shared-types";
import { SCREENS, ScreenNav } from "./ScreenNav.js";

const LABELS = [
  "Conversas",
  "Serviços",
  "Follow-up",
  "Relatórios",
  "Configurações",
  "Usuários",
];

/**
 * Renders the row with the counts cache pre-seeded, so no request is made and
 * the badge's input is stated by the test rather than by a fixture server.
 *
 * @param current - Route to mark as current.
 * @param counts - Counts to seed; omit to leave the read unresolved, which is
 *   what "unavailable" looks like to the badge.
 */
function renderAt(current: string, counts?: FollowUpOptionalCounts) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  if (counts) {
    queryClient.setQueryData(["follow-up-counts"], counts);
  }
  const { unmount } = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[current]}>
        <ScreenNav current={current} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { nav: screen.getByRole("navigation"), unmount };
}

const ALL_FOUR = {
  unansweredQuotes: 4,
  overdueReturns: 6,
  upcomingReturns: 2,
  waitingReply: 1,
};

describe("ScreenNav", () => {
  it("lists all six screens whichever one you are on", () => {
    for (const screenEntry of SCREENS) {
      const { nav, unmount } = renderAt(screenEntry.to);
      for (const label of LABELS) {
        expect(within(nav).getByText(label)).toBeInTheDocument();
      }
      unmount();
    }
  });

  it("marks exactly the current screen, on every screen", () => {
    for (const screenEntry of SCREENS) {
      const { nav, unmount } = renderAt(screenEntry.to);
      const marked = nav.querySelectorAll('[aria-current="page"]');
      expect(marked).toHaveLength(1);
      expect(marked[0]).toHaveTextContent(screenEntry.label);
      unmount();
    }
  });

  it("marks the current screen by an underline as well as by weight", () => {
    const { nav } = renderAt("/relatorios");
    const marked = within(nav).getByText("Relatórios");
    const style = getComputedStyle(marked);
    expect(style.fontWeight).toBe("700");
    // The canvas pairs weight with border-bottom-color:var(--primary); weight
    // alone is what this assertion exists to reject.
    expect(style.borderBottomWidth).not.toBe("");
    expect(style.borderBottomColor).not.toBe("transparent");
  });

  it("gives every nav entry a 44px minimum target", () => {
    const { nav } = renderAt("/");
    expect(within(nav).getByText("Conversas")).toHaveStyle({ minHeight: "44px" });
    expect(within(nav).getByRole("link", { name: "Serviços" })).toHaveStyle({
      minHeight: "44px",
    });
  });

  it("does not link the screen you are already on", () => {
    const { nav } = renderAt("/servicos");
    const links = within(nav).getAllByRole("link");
    expect(links).toHaveLength(SCREENS.length - 1);
    expect(links.map((a) => a.getAttribute("href"))).not.toContain("/servicos");
  });

  it("marks nothing when the route is not one of the six", () => {
    const { nav } = renderAt("/galeria");
    expect(within(nav).getAllByRole("link")).toHaveLength(SCREENS.length);
    expect(nav.querySelector('[aria-current="page"]')).toBeNull();
  });

  it("carries no Galeria entry — it is a QA page, not a product screen", () => {
    const { nav } = renderAt("/");
    expect(within(nav).queryByText("Galeria")).toBeNull();
  });

  it("badges Follow-up with the total of the four counts", () => {
    const { nav } = renderAt("/", ALL_FOUR);
    // 4 + 6 + 2 + 1 — the same contract the screen and the Relatórios alert read.
    expect(
      within(nav).getByRole("status", { name: "13 pendências no Follow-up" }),
    ).toHaveTextContent("13");
  });

  it("draws no badge when nothing is pending", () => {
    const { nav } = renderAt("/", {
      unansweredQuotes: 0,
      overdueReturns: 0,
      upcomingReturns: 0,
      waitingReply: 0,
    });
    expect(within(nav).queryByText("0")).toBeNull();
  });

  it("draws no badge when the counts are unavailable", () => {
    const { nav } = renderAt("/");
    expect(within(nav).queryByRole("status")).toBeNull();
  });

  it("draws no badge from a partial answer rather than understating it", () => {
    // A missing count makes the total unknown, not smaller: 4 + 6 is not the
    // number of pending things, so no badge is the honest render.
    const { nav } = renderAt("/", { unansweredQuotes: 4, overdueReturns: 6 });
    expect(within(nav).queryByText("10")).toBeNull();
    expect(within(nav).queryByRole("status")).toBeNull();
  });

  it("badges Follow-up even while you are on Follow-up", () => {
    const { nav } = renderAt("/follow-up", ALL_FOUR);
    expect(
      within(nav).getByRole("status", { name: "13 pendências no Follow-up" }),
    ).toBeInTheDocument();
  });
});

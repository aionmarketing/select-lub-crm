/**
 * Test design (testing-strategy)
 *
 * Setup: PageShell / PageSection inside AppProviders + MemoryRouter (ScreenNav
 * needs the router and the follow-up-counts query; shared MSW answers it).
 *
 * Oracle: design-system delta "Screen pages share the canvas foundation"
 * (align-shipped-ui-to-pdf-artboards) — the area under the nav row is the
 * surface-variant grey (#EDEDED → rgb(237, 237, 237)); a section heading sits
 * above its card, outside it; the page has one h1.
 *
 * Axes
 *   A1 titleAside — given / omitted
 *   A2 PageSection subtitle — given / omitted
 *   A3 PageSection end node — given / omitted
 *
 * Outputs
 *   O1 nav + main landmark (`#conteudo-principal`), main painted surface-variant
 *   O2 h1 is the title; aside rendered beside it or absent
 *   O3 section region named by its title; heading precedes the card in DOM order
 *   O4 subtitle / end node present or absent
 *
 * Sampled-cell
 *   grey main under the nav      | A1 given   | O1 O2 | main missing, white, or no aside
 *   no aside                     | A1 omitted | O2    | a stray element beside the h1
 *   heading above the card       | A2 A3 given| O3 O4 | heading inside the card, or unnamed region
 *   bare section                 | A2 A3 omit | O4    | empty subtitle/end nodes rendered
 *
 * Decision map (PageShell.tsx): `titleAside` render — T: grey-main it, F: no-aside
 * it; `subtitle ?` — T: heading-above it, F: bare it; `end ?` — same pair.
 *
 * Out of scope: ScreenNav's own badge and current-item marking (ScreenNav.test.tsx);
 * the visual pixel comparison (visual-qa artifacts).
 */
import { QueryClient } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders } from "./AppProviders.js";
import { cardSx, PageSection, PageShell } from "./PageShell.js";
import Box from "@mui/material/Box";

function renderShell(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  return render(
    <MemoryRouter initialEntries={["/usuarios"]}>
      <AppProviders queryClient={queryClient}>{ui}</AppProviders>
    </MemoryRouter>,
  );
}

describe("PageShell", () => {
  it("paints the main region grey under the nav and puts the aside beside the title", () => {
    renderShell(
      <PageShell
        current="/usuarios"
        title="Usuários"
        titleAside={<span>Unidade Centro</span>}
      >
        <p>conteúdo</p>
      </PageShell>,
    );

    const main = screen.getByRole("main");
    expect(main).toHaveAttribute("id", "conteudo-principal");
    expect(screen.getByRole("navigation")).toBeInTheDocument();
    expect(main).toHaveStyle({ backgroundColor: "rgb(237, 237, 237)" });
    expect(
      within(main).getByRole("heading", { level: 1, name: "Usuários" }),
    ).toBeInTheDocument();
    expect(within(main).getByText("Unidade Centro")).toBeInTheDocument();
    expect(within(main).getByText("conteúdo")).toBeInTheDocument();
  });

  it("renders nothing beside the title when no aside is given", () => {
    renderShell(
      <PageShell current="/usuarios" title="Usuários">
        <p>conteúdo</p>
      </PageShell>,
    );

    const heading = screen.getByRole("heading", { level: 1, name: "Usuários" });
    expect(heading.parentElement?.childElementCount).toBe(1);
  });
});

describe("PageSection", () => {
  it("names the region by its title and keeps the heading above the card", () => {
    renderShell(
      <PageSection
        title="Equipe"
        subtitle="mais antigo primeiro"
        end={<button>i</button>}
      >
        <Box sx={cardSx} data-testid="card">
          linhas
        </Box>
      </PageSection>,
    );

    const region = screen.getByRole("region", { name: "Equipe" });
    const heading = within(region).getByRole("heading", { level: 2, name: "Equipe" });
    const card = within(region).getByTestId("card");
    expect(
      heading.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(card.contains(heading)).toBe(false);
    expect(within(region).getByText("mais antigo primeiro")).toBeInTheDocument();
    expect(within(region).getByRole("button", { name: "i" })).toBeInTheDocument();
    expect(card).toHaveStyle({ backgroundColor: "rgb(255, 255, 255)" });
  });

  it("draws no subtitle or end node when neither is given", () => {
    renderShell(
      <PageSection title="Templates">
        <p>linhas</p>
      </PageSection>,
    );

    const region = screen.getByRole("region", { name: "Templates" });
    const headingRow = within(region).getByRole("heading", { level: 2 }).parentElement;
    expect(headingRow?.childElementCount).toBe(1);
  });
});

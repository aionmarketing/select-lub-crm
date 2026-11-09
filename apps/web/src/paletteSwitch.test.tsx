/**
 * Test design (testing-strategy)
 *
 * Setup: App in MemoryRouter + AppProviders (App.test.tsx pattern).
 * setupTests seeds an authenticated session; the pre-auth its override it.
 * localStorage cleared per it. The storage→initial-id read rule itself is
 * paletteStore.test.ts's SUT; here "reload keeps the choice" is sampled as
 * the store surviving an unmount/remount within the session (module store).
 *
 * Oracle: openspec design-system "Header switch selects the active palette"
 * + "Palette choice survives reload in this browser" (brand-palette-switch)
 * — control on every authenticated screen incl. /galeria, Portuguese labels
 * Amarelo/Preto, default yellow-cta, switch remaps primary without reload,
 * no control on loading or login-failed, choice written to
 * `select-lub.palette`. Gallery keeps the only appTitle heading.
 *
 * Axes
 *   A1 auth state — loading (!ready) / login-failed (no token) / authenticated
 *   A2 route — / (Conversas) / /galeria
 *   A3 action — none / click Preto / remount after Preto
 *
 * Outputs
 *   O1 no "Paleta de cores" control; no skip link
 *   O2 Amarelo pressed; provided theme primary #EAB63D
 *   O3 Preto pressed; storage black-cta; provided theme primary #303030 /
 *      contrast #FFFFFF, same mount
 *   O4 exactly one appTitle heading on /galeria
 *   O5 skip link "Pular para o conteúdo" on authenticated screens
 *
 * Observable note: MUI v6 buttons paint via CSS vars
 * (`var(--variant-containedBg)`), which jsdom's getComputedStyle cannot
 * resolve — so the palette is asserted on the ThemeProvider's delivered
 * theme via a probe component (the token→pixel mapping is MUI's upstream
 * contract). The real painted colors are covered by visual-qa task 5.2.
 *
 * Sampled-cell
 *   loading has no switch          | A1 loading    | O1 | control pre-auth
 *   login-failed has no switch     | A1 failed     | O1 | control pre-auth
 *   default Amarelo on /galeria    | A1 auth A2 g  | O2+O4 | default flipped / dup heading
 *   click Preto remaps live        | A3 click      | O3 | reload needed or storage miss
 *   remount keeps Preto            | A3 remount    | O3 | choice reset per mount
 *   switch present on Conversas    | A2 /          | control | header only on gallery
 *
 * Decision / branch map (RequireAuth + AppProviders subscription):
 *   !ready — T loading it; F others
 *   !accessToken — T login-failed it; F authenticated its
 *   onChange next !== null — T click it; F (deselect) not offered by
 *     exclusive ToggleButtonGroup re-click? it IS reachable (re-click active
 *     button yields null) — covered by re-click it keeping the palette
 *
 * Out of scope: storage-init read rule (paletteStore.test.ts); visual
 * cascade beyond the two asserted buttons (visual-qa task 5.2).
 */
import { useTheme } from "@mui/material/styles";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { App, appTitle } from "./App.js";
import { AppProviders } from "./AppProviders.js";
import { useAuthSession } from "./authSession.js";
import { usePalette } from "./paletteStore.js";

function ThemeProbe() {
  const theme = useTheme();
  return (
    <div data-testid="theme-probe">
      {theme.palette.primary.main}|{theme.palette.primary.contrastText}
    </div>
  );
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders>
        <App />
        <ThemeProbe />
      </AppProviders>
    </MemoryRouter>,
  );
}

function switchGroup() {
  return screen.getByRole("group", { name: "Paleta de cores" });
}

beforeEach(() => {
  localStorage.clear();
  usePalette.setState({ paletteId: "yellow-cta" });
});

describe("palette switch chrome", () => {
  it("shows no switch while the session is loading", async () => {
    useAuthSession.setState({ accessToken: null, currentUnitId: null, ready: false });
    renderAt("/");
    expect(
      screen.queryByRole("group", { name: "Paleta de cores" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Pular para o conteúdo" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Carregando…")).toBeInTheDocument();
    // Mounting with ready:false kicks off AuthHydrate's async hydrate; settle
    // it here so its resolution cannot unmount a later test's tree mid-run.
    await waitFor(() => {
      expect(useAuthSession.getState().ready).toBe(true);
    });
  });

  it("shows no switch on the login-failed alert", () => {
    useAuthSession.setState({ accessToken: null, currentUnitId: null, ready: true });
    renderAt("/");
    expect(
      screen.queryByRole("group", { name: "Paleta de cores" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Pular para o conteúdo" }),
    ).not.toBeInTheDocument();
  });

  it("defaults to Amarelo on /galeria with one appTitle heading and a gold primary", async () => {
    renderAt("/galeria");
    const amarelo = within(switchGroup()).getByRole("button", { name: "Amarelo" });
    expect(amarelo).toHaveAttribute("aria-pressed", "true");
    expect(screen.getAllByRole("heading", { name: appTitle })).toHaveLength(1);
    expect(
      await screen.findByRole("button", { name: "Ação principal" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("theme-probe")).toHaveTextContent("#EAB63D|#111111");
  });

  it("click Preto remaps primary in place and writes the storage key", async () => {
    const user = userEvent.setup();
    renderAt("/galeria");
    expect(
      await screen.findByRole("button", { name: "Ação principal" }),
    ).toBeInTheDocument();
    await user.click(within(switchGroup()).getByRole("button", { name: "Preto" }));
    expect(localStorage.getItem("select-lub.palette")).toBe("black-cta");
    expect(
      within(switchGroup()).getByRole("button", { name: "Preto" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("theme-probe")).toHaveTextContent("#303030|#FFFFFF");
  });

  it("re-clicking the active option keeps the palette", async () => {
    const user = userEvent.setup();
    renderAt("/galeria");
    await user.click(within(switchGroup()).getByRole("button", { name: "Amarelo" }));
    expect(
      within(switchGroup()).getByRole("button", { name: "Amarelo" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(usePalette.getState().paletteId).toBe("yellow-cta");
  });

  it("a remount keeps Preto selected", async () => {
    const user = userEvent.setup();
    const first = renderAt("/galeria");
    await user.click(within(switchGroup()).getByRole("button", { name: "Preto" }));
    first.unmount();
    renderAt("/galeria");
    expect(
      within(switchGroup()).getByRole("button", { name: "Preto" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("shows the switch and the non-heading title on Conversas", async () => {
    renderAt("/");
    expect(switchGroup()).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Pular para o conteúdo" })).toHaveAttribute(
      "href",
      "#conteudo-principal",
    );
    expect(screen.getByText(appTitle)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: appTitle })).not.toBeInTheDocument();
  });
});

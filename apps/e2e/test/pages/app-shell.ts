/**
 * Page object for the authenticated CRM shell that wraps every route.
 *
 * The shell is the one region a tour crosses on every screen: the navigation
 * rail, the Follow-up pendency badge, and the palette switch in the header. It
 * has no `data-testid` of its own and does not need one — the rail is a
 * `navigation` landmark of links named by their route, the switch is a named
 * `group` of two buttons, and the content is the `main` landmark, so role-based
 * locators here are the same ones the accessibility snapshot showed during the
 * drive.
 *
 * Oracle: openspec/specs/design-system/spec.md (Header switch selects the active
 * palette; Palette choice survives reload in this browser) and
 * openspec/specs/accounts/auth/spec.md (Login screen — `/login` redirects to Conversas).
 */
import type { Page } from "@playwright/test";

/** Route paths the navigation rail links to, keyed by their visible label. */
export const SHELL_ROUTES = {
  Conversas: "/",
  "Serviços": "/servicos",
  "Follow-up": "/follow-up",
  "Relatórios": "/relatorios",
  "Configurações": "/configuracoes",
  "Usuários": "/usuarios",
} as const;

/** Visible label of a navigation rail destination. */
export type ShellRoute = keyof typeof SHELL_ROUTES;

/** Locators for the persistent application shell (header, rail, main). */
export class AppShell {
  /**
   * Binds locators to the Playwright page under test.
   * @param page - Browser tab hosting the CRM SPA.
   */
  constructor(private readonly page: Page) {}

  /**
   * Navigates to a shell route by its visible rail label.
   * @param route - Rail destination to open.
   * @returns Playwright navigation promise for that route.
   */
  goto(route: ShellRoute) {
    return this.page.goto(SHELL_ROUTES[route]);
  }

  /**
   * Locator for the application header band.
   * @returns Playwright locator for the `banner` landmark.
   */
  header() {
    return this.page.getByRole("banner");
  }

  /**
   * Locator for the navigation rail.
   * @returns Playwright locator for the `navigation` landmark.
   */
  nav() {
    return this.page.getByRole("navigation");
  }

  /**
   * Locator for one rail destination.
   *
   * The rail renders the *current* route as plain text rather than a link, so a
   * link locator doubles as the "not the current screen" check a tour needs
   * when it walks every route in turn.
   * @param route - Rail destination label.
   * @returns Playwright locator for that rail link.
   */
  navLink(route: ShellRoute) {
    return this.nav().getByRole("link", { name: route, exact: false });
  }

  /**
   * Locator for the rail entry of the route currently open.
   * @param route - Rail destination label.
   * @returns Playwright locator for the non-link current-route marker.
   */
  navCurrent(route: ShellRoute) {
    return this.nav().getByText(route, { exact: true });
  }

  /**
   * Locator for the Follow-up pendency badge on the rail.
   *
   * Rendered as a `status` so screen readers announce it; absent entirely at
   * zero, which is the scenario "Zero renders no badge".
   * @returns Playwright locator for the badge.
   */
  followUpBadge() {
    return this.nav().getByRole("status");
  }

  /**
   * Locator for the palette switch group in the header.
   * @returns Playwright locator for the named radio-style button group.
   */
  paletteSwitch() {
    return this.page.getByRole("group", { name: "Paleta de cores" });
  }

  /**
   * Locator for one palette button.
   * @param palette - Visible palette name (`Amarelo` is the default yellow-cta).
   * @returns Playwright locator for that palette button.
   */
  paletteButton(palette: "Amarelo" | "Preto") {
    return this.paletteSwitch().getByRole("button", { name: palette });
  }

  /**
   * Locator for the main content landmark.
   * @returns Playwright locator for the `main` landmark.
   */
  main() {
    return this.page.getByRole("main");
  }

  /**
   * Locator for the skip-to-content link that opens the tab order.
   * @returns Playwright locator for the skip link.
   */
  skipLink() {
    return this.page.getByRole("link", { name: "Pular para o conteúdo" });
  }
}

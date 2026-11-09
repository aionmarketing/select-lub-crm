/**
 * Tour log — Application shell (navigation, palette, auth landing)
 *
 * Feature: the chrome every route shares — the navigation rail and its
 * Follow-up badge, the `/login` redirect auto-login lands behind, and the header
 * palette switch with its per-browser persistence.
 *
 * Run report: `runs/2026-09-10-app-shell.md`. Every step below was driven live
 * through the Playwright MCP first and is transcribed from the steps that
 * succeeded there; nothing here asserts a value that the drive merely displayed.
 *
 * Guidebook:
 * - openspec/specs/accounts/auth/spec.md — Login screen (Auto-login reaches Conversas;
 *   Logged-out home does not open a login form)
 * - openspec/specs/design-system/spec.md — Default is yellow-cta; Switch remaps
 *   primary without reload; Reload keeps black-cta; Garbage stored id falls back
 *
 * Tours:
 * - Guiado (Negócio) — the rail is the guidebook; nothing had walked all six
 *   screens in one browser pass.
 * - Colecionador (Turístico) — six distinct outputs; requiring each to render a
 *   non-empty `main` separates "the links exist" from "the rail works".
 * - Período Chuvoso (Hoteleiro) — the palette is the shell's only persisted
 *   state, and a reload is the interruption it must survive.
 * - Rumo Errado (Decadente) — two illegal arrivals: `/login` while already
 *   authenticated, and booting on a stored palette id that is not a palette.
 *
 * Findings: no defect. Three notes in the run report — read-path validation
 * turns one bad tag/template row into a 500 (defence-in-depth, not a live
 * defect), the garbage-palette fallback does not heal the stored value, and the
 * MCP's headed Chromium logs a favicon 404 that headless runs never see.
 * Nothing pinned in production code.
 *
 * Out of scope: `/galeria` (a token gallery, not an attendant route), the
 * logged-out and failed-login shells (no session to revoke on the tour stack),
 * multi-unit switching, and Tour do Museu (the shell is not the older code under
 * edit in this change).
 */
import { AppShell, SHELL_ROUTES, type ShellRoute } from "../pages/app-shell.js";
import { expect, test } from "./fixtures.js";

/** Storage key the SPA keeps the chosen palette under. */
const PALETTE_KEY = "select-lub.palette";

/**
 * Reads the computed background of the primary action button on Conversas.
 *
 * The palette is asserted through a rendered colour rather than through the
 * pressed state alone: `aria-pressed` would still flip if the theme never
 * remapped, which is the failure the design-system scenarios are about.
 *
 * Named explicitly rather than "the first button in `main`" so the sample can
 * never drift to a different control as the inbox toolbar changes.
 * @param page - Page under tour.
 * @returns The computed `background-color` string.
 */
async function primaryButtonColor(page: import("@playwright/test").Page) {
  return page
    .getByRole("button", { name: "Nova conversa" })
    .evaluate((button) => getComputedStyle(button).backgroundColor);
}

/**
 * Waits for the primary button to *settle* on a colour other than `previous`.
 *
 * MUI transitions `background-color` over a few hundred milliseconds, and the
 * intermediate frames are real blended colours. Waiting merely for "different
 * from `previous`" is not enough: under load this run captured
 * `rgb(149,121,55)`, a blend of the yellow and black palettes, and then failed
 * after the reload when the settled `rgb(48,48,48)` did not match it. So the
 * condition is two consecutive equal reads that also differ from `previous` —
 * stable, and actually remapped.
 * @param page - Page under tour.
 * @param previous - Colour the button had before the palette changed.
 * @returns The settled `background-color` string.
 */
async function colorAfterRemap(page: import("@playwright/test").Page, previous: string) {
  let last = "";
  await expect
    .poll(
      async () => {
        const current = await primaryButtonColor(page);
        const settled = current === last && current !== previous;
        last = current;
        return settled;
      },
      { timeout: 15_000, intervals: [150, 150, 150, 300, 300, 500] },
    )
    .toBe(true);
  return last;
}

test("Tour Guiado: auto-login lands on Conversas and /login never shows a form", async ({
  page,
  mainPane,
}) => {
  const shell = new AppShell(page);

  await shell.goto("Conversas");
  await mainPane();

  // Oracle: auth — "Auto-login reaches Conversas". The absence of a password
  // field is the observable half; a form would mean auto-login did not happen.
  await expect(page.getByRole("textbox", { name: /senha/i })).toHaveCount(0);
  await expect(shell.nav()).toBeVisible();

  // Oracle: auth — "Login screen" (`/login` redirects to `/`).
  await page.goto("/login");
  await expect(page).toHaveURL(/\/$/);
  await mainPane();
  await expect(page.getByRole("textbox", { name: /senha/i })).toHaveCount(0);
});

test("Tour do Colecionador: every rail destination renders its own screen", async ({
  page,
  mainPane,
}) => {
  const shell = new AppShell(page);
  await shell.goto("Conversas");
  await mainPane();

  // The drive walked these by clicking the rail, in this order, and each
  // screen rendered its own non-empty main pane.
  const routes: ShellRoute[] = [
    "Serviços",
    "Follow-up",
    "Relatórios",
    "Configurações",
    "Usuários",
    "Conversas",
  ];

  for (const route of routes) {
    await shell.navLink(route).click();
    await expect(page).toHaveURL(new RegExp(`${SHELL_ROUTES[route]}$`));

    // Oracle: the App route table — each path renders its own page. `mainPane`
    // is the blank-pane invariant: a rail that navigates to an empty shell
    // would pass a URL check and fail a person.
    await mainPane();

    // Oracle: the rail marks where you are — the current destination stops
    // being a link while the others stay links.
    await expect(shell.navLink(route)).toHaveCount(0);
  }
});

test("Tour em Período Chuvoso: the palette choice survives a reload", async ({
  page,
  mainPane,
}) => {
  const shell = new AppShell(page);
  await shell.goto("Conversas");
  await mainPane();

  // Oracle: design-system — "Default is yellow-cta". Read after the button has
  // settled, for the same transition reason as `colorAfterRemap`.
  await expect(shell.paletteButton("Amarelo")).toHaveAttribute("aria-pressed", "true");
  const yellow = await colorAfterRemap(page, "");

  // Oracle: design-system — "Switch remaps primary without reload". No reload
  // between the click and the read, which is the whole point of the scenario.
  await shell.paletteButton("Preto").click();
  await expect(shell.paletteButton("Preto")).toHaveAttribute("aria-pressed", "true");

  // The two colours must actually differ, or every check below passes
  // vacuously against a theme that never remapped. The drive saw
  // rgb(234,182,61) and rgb(48,48,48); the inequality is what is pinned, not
  // either literal.
  const black = await colorAfterRemap(page, yellow);

  // Oracle: design-system — "Reload keeps black-cta".
  await page.reload();
  await mainPane();
  await expect(shell.paletteButton("Preto")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => primaryButtonColor(page), { timeout: 10_000 }).toBe(black);
});

test("Tour do Rumo Errado: a stored palette id that is not a palette falls back", async ({
  page,
  mainPane,
}) => {
  // Written before the app boots: the SPA reads the stored palette during its
  // first render, so setting it after `goto` would test the wrong moment.
  await page.addInitScript(
    ([key, value]) => window.localStorage.setItem(key, value),
    [PALETTE_KEY, "nao-existe-essa-paleta"] as const,
  );

  const shell = new AppShell(page);
  await shell.goto("Conversas");

  // Oracle: design-system — "Garbage stored id falls back". The app boots, and
  // it boots on the default palette rather than on nothing.
  await mainPane();
  await expect(shell.paletteButton("Amarelo")).toHaveAttribute("aria-pressed", "true");
  await expect(shell.paletteButton("Preto")).toHaveAttribute("aria-pressed", "false");
});

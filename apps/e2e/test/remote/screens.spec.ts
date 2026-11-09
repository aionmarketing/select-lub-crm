/**
 * Oracle: deploy — "Published origins are verified by a read-only remote smoke
 *   run" (each of the six product routes renders with the shared navigation of
 *   that origin's variant) and "The second origin serves the antigravity
 *   variant"; design-system — the shared nav is the artboard row on `cursor`
 *   and a 56px icon rail on `antigravity`, and `aria-current="page"` marks
 *   exactly the current screen on both.
 *
 * The per-route assertion is deliberately variant-independent: it reads
 * `aria-current="page"`, which both compositions set, rather than a link role.
 * On `cursor` the current entry is NOT a link — it is static text — so a
 * link-role assertion would fail on every screen it navigated to.
 *
 * The routes are restated here rather than imported from `apps/web/src/
 * screens.ts`: this project's tsconfig has `rootDir: "."`, so it cannot reach
 * into another workspace package. `../remote-is-read-only.test.ts` compares
 * this list against the SPA's, so a screen added there fails the build until it
 * is added here too.
 */
import { expect, expectedVariant, test } from "./fixtures.js";

/** Must equal the `to` / `label` pairs in `apps/web/src/screens.ts`. */
export const REMOTE_SCREENS = [
  { to: "/", label: "Conversas" },
  { to: "/servicos", label: "Serviços" },
  { to: "/follow-up", label: "Follow-up" },
  { to: "/relatorios", label: "Relatórios" },
  { to: "/configuracoes", label: "Configurações" },
  { to: "/usuarios", label: "Usuários" },
] as const;

/** Widest an icon rail can be before it is no longer a rail (56px + borders). */
const RAIL_MAX_WIDTH = 96;

test.describe("published product routes", () => {
  for (const screen of REMOTE_SCREENS) {
    test(`${screen.label} (${screen.to}) renders and is the current screen`, async ({ page }) => {
      await page.goto(screen.to);

      const current = page.locator('nav [aria-current="page"]');
      await expect(current).toHaveCount(1, { timeout: 60_000 });
      // cursor marks the current entry with its visible label; antigravity's
      // rail button carries the label as its accessible name instead.
      const label = (await current.getAttribute("aria-label")) ?? (await current.innerText());
      expect(label).toContain(screen.label);

      // A failed auto-login renders a Portuguese error instead of the screen.
      await expect(page.getByText(/n[ãa]o foi poss[ií]vel/i)).toHaveCount(0);
    });
  }
});

test("the shared navigation has the shape of the expected variant", async ({ page }) => {
  await page.goto("/");
  const nav = page.locator("nav").first();
  await expect(nav).toBeVisible({ timeout: 60_000 });

  const box = await nav.boundingBox();
  expect(box, "the shared nav has a layout box").not.toBeNull();
  if (expectedVariant === "antigravity") {
    // A vertical icon rail: narrow and tall. On cursor the same element is a
    // full-width row, so this is what actually tells the two links apart.
    expect(box!.width).toBeLessThanOrEqual(RAIL_MAX_WIDTH);
    expect(box!.height).toBeGreaterThan(box!.width);
  } else {
    expect(box!.width).toBeGreaterThan(RAIL_MAX_WIDTH);
  }
});

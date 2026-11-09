/// <reference lib="dom" />
// The e2e tsconfig loads only Node types. These files pass callbacks to
// `page.evaluate`, whose body runs in the browser, so DOM globals are legitimately in
// scope there and must be declared for the compiler. Scoped to this file rather than
// widened in the shared tsconfig, which other suites depend on.

/**
 * Shared measurement helpers for the visual specs.
 *
 * These run the SAME per-element measurement the capture harness
 * (`apps/e2e/capture/visual-qa.mjs`) runs, so a spec failure and a capture finding
 * describe the same number. Kept in one place because two copies of a geometry rule
 * drift, and a spec that measures differently from the evidence it is meant to
 * protect is worse than no spec.
 */
import type { Page } from "@playwright/test";

/** One element sticking out past the viewport's right edge. */
export type Offender = {
  tag: string;
  testId: string | null;
  text: string | null;
  /** CSS px past `documentElement.clientWidth`. */
  overshoot: number;
  width: number;
  /**
   * Whether some ancestor scrolls horizontally, which decides whether the overshooting
   * content is merely awkward (reachable by scrolling that region) or unreachable.
   */
  reachableByScrolling: boolean;
};

/** What one route at one width looks like geometrically. */
export type Measurement = {
  clientWidth: number;
  /** True when the whole document scrolls sideways — the coarse, page-level signal. */
  documentScrollsHorizontally: boolean;
  offenders: Offender[];
  /** Render proof, so an assertion cannot pass against a blank page. */
  renderedHeadings: number;
  bodyChars: number;
};

/**
 * Measures the page's horizontal geometry and every element crossing the right edge.
 *
 * @param page - A page already navigated and settled.
 * @returns Page-level overflow plus the per-element offender list, worst first.
 */
export async function measure(page: Page): Promise<Measurement> {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const clientWidth = doc.clientWidth;
    const offenders = [];
    // Array.from rather than iterating the NodeList directly: the e2e tsconfig does not
    // load the `dom.iterable` lib, and one more lib reference is a worse trade than one
    // copy of the node list.
    for (const el of Array.from(document.querySelectorAll("body *"))) {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      const overshoot = Math.round(rect.right - clientWidth);
      if (overshoot <= 1) continue;
      let reachableByScrolling = false;
      for (let n = el.parentElement; n && n !== doc; n = n.parentElement) {
        if (n.scrollWidth > n.clientWidth + 1) {
          reachableByScrolling = true;
          break;
        }
      }
      offenders.push({
        tag: el.tagName.toLowerCase(),
        testId: el.getAttribute("data-testid"),
        text: (el.textContent ?? "").trim().slice(0, 40) || null,
        overshoot,
        width: Math.round(rect.width),
        reachableByScrolling,
      });
    }
    offenders.sort((a, b) => b.overshoot - a.overshoot);
    return {
      clientWidth,
      documentScrollsHorizontally: doc.scrollWidth > clientWidth + 1,
      offenders: offenders.slice(0, 20),
      renderedHeadings: document.querySelectorAll("h1").length,
      bodyChars: (document.body.textContent ?? "").trim().length,
    };
  });
}

/**
 * Navigates and waits for the page's own render signal before measuring.
 *
 * Waits on the `h1` rather than `main`: only `PageShell.tsx` renders a `main` landmark
 * and Conversas and Serviços do not use PageShell, so `main` never appears on those two
 * however correctly they render. All six routes render exactly one `h1`.
 *
 * `networkidle` alone is not a render signal under the Vite dev server — it fires
 * during a lull in on-demand module transforms, which was observed to yield an
 * 11-character body on a route that renders 1416 characters a moment later.
 *
 * @param page - Page to drive.
 * @param routePath - App-relative path, e.g. `/servicos`.
 */
export async function gotoRoute(page: Page, routePath: string): Promise<void> {
  const base = process.env["VISUAL_BASE_URL"];
  await page.goto(base ? `${base}${routePath}` : routePath, { waitUntil: "networkidle" });
  await page.waitForSelector("h1", { state: "attached" });
}

/** The six product routes behind `RequireAuth`, as the capture harness lists them. */
export const ROUTES = [
  { slug: "conversas", path: "/" },
  { slug: "servicos", path: "/servicos" },
  { slug: "follow-up", path: "/follow-up" },
  { slug: "relatorios", path: "/relatorios" },
  { slug: "configuracoes", path: "/configuracoes" },
  { slug: "usuarios", path: "/usuarios" },
] as const;

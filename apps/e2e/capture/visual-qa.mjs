/**
 * Reproducible visual-QA capture harness.
 *
 * `skills/visual-qa/SKILL.md` says to run the project's screenshot harness and, when
 * none exists, to capture manually with a throwaway script. This repo had no harness,
 * so every capture in `artifacts/visual-qa/` was taken by hand — which is why that set
 * is at MIXED `deviceScaleFactor` (768/1024/1440 at 2x, the rest at 1x) and cannot be
 * compared against itself. One setting, applied by construction, is the whole point.
 *
 * It lives under `apps/e2e/` rather than `tools/` because Playwright resolves only
 * from this package; a script outside it cannot import `@playwright/test`.
 *
 * Run:  pnpm --filter @select-lub/e2e capture
 *
 * Requires a dev server and an API already running, and the SPA's auto-login
 * variables set for that server. Port 5173 is commonly taken on this machine, hence
 * the 5199 default — override with CAPTURE_BASE_URL.
 *
 * Writes PNGs and `measurements.json` under `artifacts/visual-qa/<subject>/`.
 * It renders NO verdict on appearance: wrapping, rhythm and taste are the reviewer's.
 * What it produces is evidence plus numbers.
 */
/*
 * `document`, `window` and `location` below appear only inside callbacks passed to
 * `page.evaluate` and `context.addInitScript`, whose bodies are serialised and run in
 * the browser, not in this Node process. ESLint lints this file as Node source and
 * cannot tell the two scopes apart, so it reports them as undefined; declaring them
 * here is narrower than widening the workspace lint config for one file.
 */
/* global document, window, location */
import { chromium } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Reads a PNG's pixel dimensions from its IHDR chunk, at fixed offsets 16 and 20.
 *
 * Avoids a dependency for two integers, and the numbers matter: a full-page capture
 * silently widens to swallow horizontal overflow, so the image size is the only way
 * to tell that a file labelled for one viewport was rendered at another width.
 *
 * @param file - Path to a PNG on disk.
 * @returns Its width and height in device pixels.
 */
function pngSize(file) {
  const header = readFileSync(file).subarray(0, 24);
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");

/** Base URL of an already-running dev server. 5173 is usually occupied here. */
const BASE_URL = process.env.CAPTURE_BASE_URL ?? "http://127.0.0.1:5199";
/** Subject folder under `artifacts/visual-qa/`; name it for the change under review. */
const SUBJECT = process.env.CAPTURE_SUBJECT ?? "harness-run";
/**
 * Which UI variant the server under `CAPTURE_BASE_URL` was started with.
 *
 * The script cannot read this off the page, so it is declared: point
 * `CAPTURE_BASE_URL` at a server started with `--mode antigravity` and set this
 * to match. Shots land in `<subject>/<variant>/`, because the two variants draw
 * the same routes at the same viewports and would otherwise overwrite each
 * other — which is the one way a four-way comparison silently lies.
 */
const UI_VARIANT =
  process.env.CAPTURE_UI_VARIANT === "antigravity" ? "antigravity" : "cursor";
/**
 * ONE device scale factor for every capture in a run. The existing set mixes 1x and
 * 2x, which is the defect this constant exists to prevent — a mixed set cannot be
 * compared, and no amount of care at capture time fixes it afterwards.
 */
const DEVICE_SCALE_FACTOR = Number(process.env.CAPTURE_SCALE ?? 2);

/** Product routes behind `RequireAuth`, slug used for the filename. */
const ROUTES = [
  { slug: "conversas", path: "/" },
  { slug: "servicos", path: "/servicos" },
  { slug: "follow-up", path: "/follow-up" },
  { slug: "relatorios", path: "/relatorios" },
  { slug: "configuracoes", path: "/configuracoes" },
  { slug: "usuarios", path: "/usuarios" },
];

/**
 * Desktop widths, plus one zoom case.
 *
 * NOT the list in `skills/visual-qa/SKILL.md`. That list — 320, 375, 768, 1024, 1440 —
 * is written for responsive apps, and its first two are phone widths. This product is
 * desktop-only (owner, 2026-09-07), so capturing at 320 measures a screen no user has.
 * The previous capture round followed the skill literally and found overflow ONLY at
 * 320, 375 and the zoom case, with 768/1024/1440 clean on every route — i.e. every
 * recorded finding sat at a width nobody sees.
 *
 * 1024 is the floor: the smallest laptop an attendant plausibly uses. 1920 is here
 * because a layout can fail by stretching, not only by cramping.
 *
 * Browser zoom has no Playwright API, and 200% zoom IS a half-width layout viewport at
 * 2x — so it is expressed that way rather than approximated. Taken at 1440 rather than
 * 1024: 720 effective px is a width a desktop layout might plausibly survive, so a
 * finding there is actionable, where a 512 px break on a desktop-only app is not.
 * Its findings belong under accessibility (WCAG 1.4.4), not layout.
 */
const VIEWPORTS = [
  { label: "1024", width: 1024, scale: DEVICE_SCALE_FACTOR },
  { label: "1280", width: 1280, scale: DEVICE_SCALE_FACTOR },
  { label: "1440", width: 1440, scale: DEVICE_SCALE_FACTOR },
  { label: "1920", width: 1920, scale: DEVICE_SCALE_FACTOR },
  { label: "1440-zoom200", width: 720, scale: 2, accessibility: true },
];

/** `paletteStore.ts` reads this key; anything but `black-cta` falls back to yellow. */
const PALETTE_STORAGE_KEY = "select-lub.palette";
const PALETTES = ["yellow-cta", "black-cta"];

/**
 * The one DOM node every product route renders once it has actually rendered.
 *
 * All six routes render a single `h1` — the four `PageShell` screens through the shell,
 * Conversas and Serviços through their own `Typography component="h1"`. That makes the
 * h1 the only structural signal shared by all six, which is why the capture waits on it
 * and why `renderedProductContent` keys on it.
 *
 * Do NOT switch this back to `main`: `PageShell.tsx` is the sole source of that
 * landmark and two routes do not use PageShell, so `main` reports a false negative on
 * exactly those two however correct their render is.
 */
const PRODUCT_CONTENT_ANCHOR = "h1";

/**
 * Measures overflow twice, because the skill requires blaming the right element.
 *
 * Page-level overflow at 320/375 does not by itself fail a change — old layout bugs
 * exist independently of what anyone touched. So the per-element list is what makes a
 * finding attributable, and it is exactly what the previous `overflow.json` lacked.
 *
 * @returns Page scroll/client width plus the elements crossing the right edge,
 *   worst overshoot first, capped so one broken row cannot bloat the report.
 */
async function measureOverflow(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const clientWidth = doc.clientWidth;
    const offenders = [];
    for (const el of document.querySelectorAll("body *")) {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      const overshoot = Math.round(rect.right - clientWidth);
      if (overshoot > 1) {
        offenders.push({
          tag: el.tagName.toLowerCase(),
          testId: el.getAttribute("data-testid") ?? null,
          role: el.getAttribute("role") ?? null,
          text: (el.textContent ?? "").trim().slice(0, 40) || null,
          overshoot,
          width: Math.round(rect.width),
        });
      }
    }
    offenders.sort((a, b) => b.overshoot - a.overshoot);
    return {
      pageScrollWidth: doc.scrollWidth,
      pageClientWidth: clientWidth,
      pageOverflow: doc.scrollWidth > clientWidth,
      offenderCount: offenders.length,
      offenders: offenders.slice(0, 20),
    };
  });
}

/**
 * Collects failed HTTP responses for one page. MUST be attached before `goto`.
 *
 * The DOM check below cannot see an authorization failure, so the network layer is
 * where that has to be caught. Returns the array the listener appends to; read it
 * only after navigation settles.
 */
function watchFailedResponses(page) {
  const failures = [];
  page.on("response", (response) => {
    const status = response.status();
    if (status < 400) return;
    failures.push({ url: response.url().slice(0, 200), status });
  });
  return failures;
}

/**
 * Records whether the SPA actually reached the product route.
 *
 * Auto-login is a build-time Vite concern, so a dev server started without
 * `VITE_MVP_LOGIN_*` yields a screenshot of a login or error screen that looks
 * plausible in a thumbnail. Capturing that silently would be worse than failing.
 *
 * The DOM half of this check is NOT sufficient on its own, which is the correction
 * that matters here. Auth and data resolve against different stores: the SPA signs in
 * against hosted Supabase, while the API's `onRequest` hook reads the profile and unit
 * membership from the LOCAL database. When the two disagree on the user's uuid, every
 * unit-scoped route returns 403 — and a 403 page still renders the app shell, the nav
 * and the header. So it has a `<main>` and far more than 40 characters of text, and
 * both DOM conditions pass while the screenshot shows no product data at all. That is
 * the exact failure this harness exists to prevent, and it would have written six
 * confident-looking PNGs of nothing and exited 0.
 *
 * Hence `apiFailures`: an authorization failure is visible in the response status and
 * nowhere reliable in the DOM. Do not relax this to a DOM heuristic — the two stores
 * currently agree only by coincidence (the demo seed happens to mint the same uuid the
 * auto-login account resolves to), and a coincidence is not a precondition.
 *
 * @param failures - The array from `watchFailedResponses`, already populated.
 */
async function readiness(page, failures) {
  const dom = await page.evaluate(
    (anchor) => ({
      url: location.pathname,
      hasMain: Boolean(document.querySelector("main, [role='main']")),
      hasProductContentAnchor: Boolean(document.querySelector(anchor)),
      bodyChars: (document.body.textContent ?? "").trim().length,
    }),
    PRODUCT_CONTENT_ANCHOR,
  );
  // 401/403 mean the render is authenticated-but-unauthorized: the worst case, because
  // it looks like a real screen. Other 4xx/5xx are recorded but judged less harshly,
  // since a single failed optional asset should not void an otherwise correct capture.
  const authFailures = failures.filter((f) => f.status === 401 || f.status === 403);
  return {
    ...dom,
    apiFailures: failures.slice(0, 10),
    authFailureCount: authFailures.length,
    // The single field the run's exit code keys on.
    //
    // Keyed on the h1, NOT on `hasMain`. `hasMain` was wrong as a gate and voided 20
    // of 60 otherwise-good captures: only `PageShell.tsx` renders `<Box component=
    // "main">`, and Conversas and Serviços do not use PageShell, so those two routes
    // have no `main` landmark however correctly they render. They were flagged while
    // showing 1416 and 2190 characters of real product content.
    //
    // `hasMain` is still recorded above, because the gap it reveals is a real
    // accessibility finding about the app — it is just not evidence about this capture.
    //
    // The auth clause is the coordinator's and is deliberately unchanged: a 401/403
    // still voids the capture no matter how much content rendered.
    renderedProductContent:
      dom.hasProductContentAnchor && dom.bodyChars >= 40 && authFailures.length === 0,
  };
}

async function main() {
  const outDir = path.join(REPO_ROOT, "artifacts", "visual-qa", SUBJECT, UI_VARIANT);
  mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch();
  const measurements = [];
  let captured = 0;
  let suspect = 0;

  for (const palette of PALETTES) {
    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: 900 },
        deviceScaleFactor: viewport.scale,
      });
      // Set before any document script runs, so the first paint is already themed —
      // setting it after load would capture a flash of the default palette.
      await context.addInitScript(
        ([key, value]) => window.localStorage.setItem(key, value),
        [PALETTE_STORAGE_KEY, palette],
      );

      for (const route of ROUTES) {
        const page = await context.newPage();
        const file = `${route.slug}-${viewport.label}-${palette}.png`;
        // Attached before goto, or the navigation's own responses are missed.
        const failedResponses = watchFailedResponses(page);
        try {
          await page.goto(`${BASE_URL}${route.path}`, {
            waitUntil: "networkidle",
            timeout: 30_000,
          });
          // `networkidle` is not a render signal. Under the Vite dev server it fires
          // during a lull in on-demand module transforms, before React has mounted —
          // observed directly: the same route measured 1416 characters in one context
          // and 11 in the next, from an unchanged app. Waiting for the page's own h1
          // makes the measurement wait for the render instead of racing it. Failure to
          // appear is left to `readiness`, which reports it rather than throwing.
          await page
            .waitForSelector(PRODUCT_CONTENT_ANCHOR, {
              state: "attached",
              timeout: 15_000,
            })
            .catch(() => {});
          const ready = await readiness(page, failedResponses);
          const overflow = await measureOverflow(page);
          const filePath = path.join(outDir, file);
          await page.screenshot({ path: filePath, fullPage: true });
          const image = pngSize(filePath);
          captured += 1;
          if (!ready.renderedProductContent) suspect += 1;
          measurements.push({
            route: route.slug,
            path: route.path,
            viewport: viewport.label,
            cssWidth: viewport.width,
            deviceScaleFactor: viewport.scale,
            // Zoom findings are a WCAG 1.4.4 question, not a desktop-layout one, and
            // must not be averaged in with the rest when someone reads this file.
            accessibilityCase: viewport.accessibility === true,
            palette,
            file,
            image,
            // A full-page capture EXPANDS to include horizontal overflow, so a PNG
            // labelled "320" can be 2000 CSS px wide and the very overflow it should
            // reveal is invisible in it. Recording the implied width keeps the label
            // from lying: anything above `cssWidth` is overflow the image absorbed.
            impliedCssWidth: Math.round(image.width / viewport.scale),
            widerThanViewport:
              Math.round(image.width / viewport.scale) > viewport.width,
            ready,
            ...overflow,
          });
        } catch (error) {
          measurements.push({
            route: route.slug,
            viewport: viewport.label,
            palette,
            file: null,
            error: String(error).slice(0, 300),
          });
        } finally {
          await page.close();
        }
      }
      await context.close();
    }
  }

  await browser.close();

  const report = {
    capturedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    uiVariant: UI_VARIANT,
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
    routes: ROUTES.length,
    viewports: VIEWPORTS.map((v) => v.label),
    palettes: PALETTES,
    expected: ROUTES.length * VIEWPORTS.length * PALETTES.length,
    captured,
    suspectRenders: suspect,
    measurements,
  };
  writeFileSync(
    path.join(outDir, "measurements.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );

  console.log(`captured ${captured}/${report.expected} (${UI_VARIANT}) -> ${outDir}`);
  if (suspect > 0) {
    const authBlocked = measurements.filter(
      (m) => m.ready?.authFailureCount > 0,
    ).length;
    console.error(
      `WARNING: ${suspect} capture(s) did not render product content. ` +
        `Those PNGs are of a login, error or empty screen — do not review them as the product.`,
    );
    if (authBlocked > 0) {
      // Named separately because the two causes need different fixes, and the 403 case
      // is the one that looks correct in a thumbnail.
      console.error(
        `  ${authBlocked} of them got 401/403 from the API. Sign-in worked but the LOCAL ` +
          `database has no profile or unit membership for the signed-in user, so every ` +
          `unit-scoped route was refused. Re-seed the worktree database, or point ` +
          `auto-login at an account the seed actually creates.`,
      );
    }
    if (suspect > authBlocked) {
      console.error(
        `  ${suspect - authBlocked} of them rendered no h1 or almost no text. ` +
          `The dev server is probably missing VITE_MVP_LOGIN_* so the SPA never signed in.`,
      );
    }
    process.exitCode = 1;
  }
}

await main();

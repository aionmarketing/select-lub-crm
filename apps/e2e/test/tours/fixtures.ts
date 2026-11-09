/**
 * Fixtures for exploratory tour specs — the default fixtures plus the invariants
 * every tour asserts regardless of which tour it is.
 *
 * A tour walks the app the way a developer would, so the interesting failures
 * are the ones no per-step `expect` was written for: a thrown render, a console
 * error, a 5xx behind a silent UI, a pane that came back blank. `tourLog` is an
 * auto fixture, so every tour in this folder gets those four checks without
 * asking, and `mainPane` is the fifth (blank-pane) check on demand.
 *
 * Setup comes from `playwright.tours.config.ts`: API 3100, Vite 5174, mock
 * Evolution 18081, paid-provider credentials blanked. The page object, seed, and
 * `crmApi` are the default suite's, imported not copied — a tour is a file, not
 * a second framework.
 *
 * Oracle: openspec/specs/repo-foundation/spec.md — "Exploratory tour specs are
 * quarantined from the default suite" (every tour asserts the cross-cutting
 * invariants).
 */
import { expect, type Request, type Response } from "@playwright/test";
import { isHostedSupabaseRequest } from "../../tour-auth-env.js";
import { test as base } from "../fixtures.js";

/**
 * Console messages that the dev build emits on a healthy page.
 *
 * Every entry needs a comment saying why it is not a defect: the allow-list is
 * the one place a real error could hide, so it has to stay auditable and short.
 * Anything not listed fails the tour.
 */
const ALLOWED_CONSOLE_ERRORS: RegExp[] = [
  // Vite dev server injects this when HMR reconnects after the API restarts;
  // it describes the dev tooling, not the app under tour.
  /\[vite\] (?:connecting|connected|server connection lost)/i,
  // React Router logs future-flag notices on v6 dev builds. Advisory only.
  /React Router Future Flag Warning/i,
];

/** One recorded invariant violation, kept until teardown so all are reported. */
type Violation = { kind: "console" | "pageerror" | "server" | "hosted-supabase"; detail: string };

/** Control surface a tour uses to declare a refusal it deliberately provokes. */
export type TourLog = {
  /**
   * Declares that a console error matching `pattern` is expected in this tour.
   *
   * A Decadente tour's whole job is to provoke refusals, and the browser logs
   * every non-2xx fetch as a console error — so a tour that submits a duplicate
   * name would fail on the 409 it went looking for. This is deliberately
   * per-test rather than another entry in the module-level allow-list: a 409 is
   * expected in the one tour that asks for it and is a finding anywhere else.
   * @param pattern - Matches the console text to tolerate, for this tour only.
   */
  expect(pattern: RegExp): void;
};

type TourFixtures = {
  /** Auto: fails the tour if any cross-cutting invariant broke during it. */
  tourLog: TourLog;
  /** Asserts the main landmark is present and not blank on the tour's page. */
  mainPane: () => Promise<void>;
};

/**
 * True when a console error is a known dev-build message rather than a defect.
 * @param text - The console message body
 * @returns Whether the message is on the allow-list
 */
function isAllowedConsoleError(text: string) {
  return ALLOWED_CONSOLE_ERRORS.some((pattern) => pattern.test(text));
}

/**
 * Playwright `test` for tours: default fixtures plus the always-on invariants.
 */
export const test = base.extend<TourFixtures>({
  tourLog: [
    async ({ page }, use) => {
      const violations: Violation[] = [];
      // Populated by `tourLog.expect(...)` from inside a tour, so a refusal a
      // Decadente tour deliberately provokes does not read as a defect.
      const expected: RegExp[] = [];

      page.on("console", (message) => {
        if (message.type() !== "error") return;
        const text = message.text();
        if (isAllowedConsoleError(text)) return;
        if (expected.some((pattern) => pattern.test(text))) return;
        violations.push({ kind: "console", detail: text });
      });
      page.on("request", (request) => {
        if (isHostedSupabaseRequest(request.url())) {
          violations.push({ kind: "hosted-supabase", detail: `${request.method()} ${request.url()}` });
        }
      });
      page.on("pageerror", (error) => {
        violations.push({ kind: "pageerror", detail: error.message });
      });
      page.on("response", (response: Response) => {
        if (response.status() < 500) return;
        const request: Request = response.request();
        violations.push({
          kind: "server",
          detail: `${response.status()} ${request.method()} ${response.url()}`,
        });
      });

      await use({
        expect(pattern: RegExp) {
          expected.push(pattern);
        },
      });

      // Reported as one list rather than the first hit: a tour that produced
      // three violations tells a different story from one that produced one,
      // and the run report wants all of them.
      expect(violations.map((entry) => `${entry.kind}: ${entry.detail}`)).toEqual([]);
    },
    { auto: true },
  ],
  mainPane: async ({ page }, use) => {
    await use(async () => {
      const main = page.getByRole("main");
      // Generous timeout, not the 5s default: right after `goto` the SPA is
      // still in MVP auto-login and renders only `Carregando…`, with no main
      // landmark yet. Waiting on the landmark itself is the auto-waiting way to
      // absorb that — a sleep would be both slower and less reliable.
      await expect(main).toBeVisible({ timeout: 30_000 });
      // A shell that renders its chrome around an empty slot still passes a
      // visibility check, which is exactly the "blank pane" the invariant is
      // about. Requiring text is what separates the two.
      await expect(main).not.toHaveText("");
    });
  },
});

/** Re-exported Playwright assertion helper so tour specs import one module. */
export { expect };

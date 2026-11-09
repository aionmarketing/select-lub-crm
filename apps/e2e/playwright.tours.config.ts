/**
 * Playwright config for exploratory tour specs (`test/tours`), quarantined from CI.
 *
 * A tour is transcribed from a live exploration, so it is fragile by design and
 * MUST NOT gate a pull request: `playwright.config.ts` ignores `**\/tours/**`
 * and `test/ci-excludes-live.test.ts` pins that exclusion. Invoke only via
 * `pnpm test:e2e:tours`.
 *
 * Ports 3100 / 5174 / 18081, so a tour runs while `pnpm dev` holds 3000/5173.
 * The stack's shape and the provider guard live in `tours-config.shared.ts` —
 * read that file's header before changing anything about credentials.
 *
 * THE GUARD IS INCOMPLETE FOR MOTUL AND TECFIL, and blanking credentials cannot
 * close it: neither is paid, and both hosts are hardcoded in their clients. The
 * only thing keeping runs off `gateway-apim.motul.com` today is that the tour
 * fixture's vehicle has an identity too incomplete to resolve — see the header
 * of `test/tours/conversas-oil-quote.tour.spec.ts`.
 *
 * Does NOT collect `conversas-channel-down.tour.spec.ts`. That tour needs the
 * CONFIGURED Evolution instance to be disconnected, which is a property of the
 * whole API process rather than of one test, so it has its own config and its
 * own ports: `playwright.tours-disconnected.config.ts`. Collecting it here would
 * drive it against a CONNECTED instance and fail for the wrong reason.
 */
import { defineTourConfig } from "./tours-config.shared.js";

export default defineTourConfig({
  apiPort: 3100,
  webPort: 5174,
  evolutionPort: 18081,
  testMatch: "**/*.tour.spec.ts",
  testIgnore: "**/conversas-channel-down.tour.spec.ts",
  outputDir: "test-results/tours",
});

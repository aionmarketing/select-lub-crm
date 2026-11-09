/**
 * Oracle: openspec/specs/repo-foundation/spec.md — live-scheduled-messages (the
 * opt-in live suite may send one WhatsApp text) and exploratory-tour-tests (a
 * failing tour MUST NOT fail a pull-request check). `pnpm test:e2e` and CI must
 * run neither. CI runs `pnpm --filter @select-lub/e2e test`, which is
 * `playwright test` on the DEFAULT config, so that config must never collect a
 * spec from `test/live/`, `test/remote/` or `test/tours/`.
 *
 * Why a test and not a reading. Five independent guards keep CI from sending:
 * the default config's `testIgnore`, the live specs living under a separate
 * config, the `E2E_LIVE_SCHEDULE` opt-in, CI's mock `SERVER_URL`, and CI
 * starting no worker. Only the opt-in is covered by a test (`live/gate.test.ts`).
 * The first two were verified once, by hand, by reading the config. Widening
 * `testMatch` or dropping `testIgnore` would silently erode the property from
 * five layers to three with nothing going red. This pins the collection
 * behaviour itself, not the config value: asserting `testIgnore` contains a
 * string would restate the source rather than check what Playwright does with it.
 *
 * Two suites, one `testIgnore`, two independent reasons — and neither weakens
 * the other. `live/` is quarantined because it is **expensive and
 * irreversible**: it sends real WhatsApp messages through the hosted Evolution
 * instance (five reached the user's own numbers over two days in September
 * 2026, each with an Evolution id). `tours/` is quarantined because it is
 * **fragile by design**: a tour walks a feature the way a person would, so a
 * non-functional UI change can turn it red, which is fine on demand and
 * unacceptable on a pull request. If anyone ever proposes relaxing this line so
 * that a suite can run, that is the answer: run it through its own config and
 * its own command, the way `playwright.live.config.ts` + `run-live.mjs` and
 * `playwright.tours.config.ts` + `run-tours.mjs` already do.
 *
 * Vacuity guard: a listing with no live files is also what you get when
 * `test/live/` is empty or renamed, so the absence is only meaningful once at
 * least one live spec is known to exist on disk. Both are asserted.
 *
 * Out of scope: whether the LIVE config collects the live specs (proved by
 * running it), the opt-in gate (`live/gate.test.ts`), and the CI job's env
 * (read in tasks 1.3).
 */
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const e2eRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** One entry of `playwright test --list --reporter=json`'s `suites`. */
type ListedSuite = { file: string };

/** Memoised result of {@link defaultConfigSpecFiles}; see the note inside it. */
let cachedSpecFiles: string[] | undefined;

/**
 * Lists what the default Playwright config collects, without running anything.
 *
 * `--list` resolves specs and exits; it does not start the `webServer` entries,
 * so no API, Vite, mock Evolution or worker is launched.
 *
 * The listing is immutable for a run and costs a `pnpm` spawn plus Playwright's
 * collection step, so it is computed once and shared by every assertion below.
 *
 * @returns Spec paths relative to the config's `testDir`
 */
function defaultConfigSpecFiles(): string[] {
  // Memoised: three tests below need this listing, it cannot change between
  // them, and each call spawns a Playwright process that takes seconds. Left
  // uncached, the file spent ~28s of its 30s budget on two redundant spawns and
  // timed out under a loaded machine on 2026-09-10 — a false red on the check
  // that guards tour quarantine, which is the worst kind to have flake.
  if (cachedSpecFiles) return cachedSpecFiles;
  const stdout = execFileSync(
    "pnpm",
    ["exec", "playwright", "test", "--list", "--reporter=json", "--config", "playwright.config.ts"],
    { cwd: e2eRoot, encoding: "utf8", shell: process.platform === "win32" },
  );
  const listed = JSON.parse(stdout) as { suites: ListedSuite[] };
  cachedSpecFiles = listed.suites.map((suite) => suite.file.split(path.sep).join("/"));
  return cachedSpecFiles;
}

describe("default Playwright config never collects the tour suite", () => {
  const tourSpecs = readdirSync(path.join(e2eRoot, "test", "tours")).filter((name) =>
    name.endsWith(".tour.spec.ts"),
  );

  // Same shape as the live block below, for a different reason. A tour is
  // transcribed from a live exploration and is deliberately fragile: it walks a
  // feature the way a person would rather than asserting one contract, so a
  // non-functional UI change can turn it red. That is acceptable on demand and
  // unacceptable on a pull request. `testMatch` is `**/*.spec.ts`, which
  // `*.tour.spec.ts` matches, so ONLY `testIgnore` keeps CI clear of them —
  // one line, worth pinning.
  it("has tour specs on disk, so their absence from the listing means something", () => {
    expect(tourSpecs.length).toBeGreaterThan(0);
  });

  it("collects nothing under test/tours", () => {
    const collected = defaultConfigSpecFiles();
    expect(collected.length).toBeGreaterThan(0);
    expect(collected.filter((file) => file.startsWith("tours/"))).toEqual([]);
    for (const spec of tourSpecs) {
      expect(collected).not.toContain(`tours/${spec}`);
    }
  });
});

describe("default Playwright config never collects the remote suite", () => {
  const remoteSpecs = readdirSync(path.join(e2eRoot, "test", "remote")).filter((name) =>
    name.endsWith(".spec.ts"),
  );

  // Added when `**/remote/**` arrived in `testIgnore` with nothing pinning it.
  // A remote spec drives a PUBLISHED origin, so collecting one in CI points a
  // pull-request check at deployed infrastructure. Same one-line exposure as the
  // other two suites, and it was the only one of the three left unguarded.
  it("has remote specs on disk, so their absence from the listing means something", () => {
    expect(remoteSpecs.length).toBeGreaterThan(0);
  });

  it("collects nothing under test/remote", () => {
    const collected = defaultConfigSpecFiles();
    expect(collected.length).toBeGreaterThan(0);
    expect(collected.filter((file) => file.startsWith("remote/"))).toEqual([]);
    for (const spec of remoteSpecs) {
      expect(collected).not.toContain(`remote/${spec}`);
    }
  });
});

describe("default Playwright config never collects the live suite", () => {
  const liveSpecs = readdirSync(path.join(e2eRoot, "test", "live")).filter((name) =>
    name.endsWith(".spec.ts"),
  );

  it("has live specs on disk, so their absence from the listing means something", () => {
    expect(liveSpecs.length).toBeGreaterThan(0);
  });

  it("lists real specs, so an empty listing cannot pass as an exclusion", () => {
    expect(defaultConfigSpecFiles().length).toBeGreaterThan(0);
  });

  it("collects nothing under test/live", () => {
    const collected = defaultConfigSpecFiles();
    expect(collected.filter((file) => file.startsWith("live/"))).toEqual([]);
    for (const spec of liveSpecs) {
      expect(collected).not.toContain(`live/${spec}`);
    }
  });
});

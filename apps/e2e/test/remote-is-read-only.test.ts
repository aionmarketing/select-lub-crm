/**
 * Test design (testing-strategy)
 *
 * Setup: reads source files. No Playwright run, no browser, no network, no
 *   database — the properties under test are about what the remote suite is
 *   *allowed to reach*, so exercising it would defeat the point.
 *
 * Oracle: deploy — "Published origins are verified by a read-only remote smoke
 *   run": it starts no local servers, writes nothing to any database, and is
 *   not collected by `pnpm test:e2e` or pull-request CI.
 *
 * Why a test and not a reading. Three separate things keep the remote suite
 *   from writing to the database real people see: the default config's
 *   `testIgnore`, the remote config declaring no `webServer` and no
 *   `globalSetup`, and the specs not importing the fixture seed. Each is one
 *   edit away from being undone, and the damage — e2e customers and schedules
 *   appearing in the shared demo — would show up as "someone else's data",
 *   not as a failing test. `ci-excludes-live.test.ts` guards the live suite
 *   the same way and for the same reason.
 *
 * Axes
 *   A1 default config — ignores remote / would collect it
 *   A2 remote config — no webServer + no globalSetup / declares either
 *   A3 remote specs — import only Playwright and the token module / import
 *      the seed, fixtures or any entry point of `@select-lub/core` (every one
 *      reaches Prisma), or the `@select-lub/db` it absorbed in wave 5.1c
 *   A4 route list — matches apps/web/src/screens.ts / drifted
 *
 * Outputs: O1 assertion passes; O2 assertion fails naming the file
 *
 * Sampled-cell
 *   testIgnore has remote | A1 | O1 | drop the pattern
 *   no webServer          | A2 | O1 | boot a local stack against a remote URL
 *   no globalSetup        | A2 | O1 | seed before a remote run
 *   no db import          | A3 | O1 | import Prisma into a remote spec
 *   each pattern bites    | A3 | O1 | a pattern (or the comment stripper) that
 *                         |    |    | matches nothing, passing the row above vacuously
 *   routes in sync        | A4 | O1 | add a screen and never smoke it
 *
 * Decision / branch map: each assertion is a single predicate over file text;
 *   the F arm is the edit it forbids.
 *
 * Out of scope: whether the remote suite passes against a published origin
 *   (tasks 7.3–7.6); the live suite (ci-excludes-live.test.ts).
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const e2eRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const remoteDir = path.join(e2eRoot, "test", "remote");

/** Reads a file under apps/e2e. */
function read(...segments: string[]) {
  return readFileSync(path.join(e2eRoot, ...segments), "utf8");
}

/**
 * Every `.ts` file in the remote suite as `[name, code]`, comments stripped.
 *
 * Stripped because these files *name* the forbidden modules in prose — saying
 * why they must not be imported is exactly how the rule survives — and a
 * substring match over the raw text would fire on the explanation instead of
 * on an import.
 */
function remoteSources(): [string, string][] {
  return readdirSync(remoteDir)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => [name, stripComments(readFileSync(path.join(remoteDir, name), "utf8"))]);
}

/** Source text with block and line comments removed; see {@link remoteSources}. */
function stripComments(raw: string) {
  return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("the default Playwright config never collects the remote suite", () => {
  it("ignores **/remote/**", () => {
    const config = read("playwright.config.ts");
    expect(config).toMatch(/testIgnore:\s*\[[^\]]*\*\*\/remote\/\*\*/);
  });
});

describe("the remote config starts nothing and seeds nothing", () => {
  const config = read("playwright.remote.config.ts");

  it("declares no webServer", () => {
    expect(config).not.toMatch(/^\s*webServer:/m);
  });

  it("declares no globalSetup", () => {
    expect(config).not.toMatch(/^\s*globalSetup:/m);
  });

  it("requires E2E_BASE_URL rather than defaulting to localhost", () => {
    expect(config).toContain("E2E_BASE_URL");
    expect(config).not.toContain("127.0.0.1:5173");
  });
});

/** A real import the pattern must find: a file (relative to apps/e2e) or, where none exists any more, a sample. */
type Control = { file: string } | { sample: string };

/**
 * Each forbidden import, and the controls that really make it. The controls
 * keep the negative check honest: if a pattern were misspelt, or the comment
 * stripper ever ate import lines, "imports X nowhere" would pass over every
 * remote spec without testing anything. The pattern must first find every
 * control's import, through the same stripper.
 */
const FORBIDDEN_IMPORTS: [label: string, pattern: RegExp, controls: Control[]][] = [
  // Any entry point of core reaches Prisma: `@select-lub/core/db` directly, and
  // the bare barrel through `kernel`, which imports it. apps/e2e declares the
  // whole package, so either would resolve. One control per form.
  [
    "@select-lub/core, bare or any subpath",
    /["']@select-lub\/core(?:\/[^"']*)?["']/,
    [{ file: "../api/src/app.ts" }, { file: "test/seed-e2e.ts" }],
  ],
  // The package core absorbed in wave 5.1c. Nothing imports it any more, so the
  // control is a sample; kept so a stale copy-paste is still caught.
  [
    "@select-lub/db (before wave 5.1c)",
    /["']@select-lub\/db(?:\/[^"']*)?["']/,
    [{ sample: 'import { prisma } from "@select-lub/db";' }],
  ],
  ["the fixture seed", /seed-e2e/, [{ file: "test/fixtures.ts" }]],
  ["the local fixtures (which import the seed)", /from\s+"\.\.\/fixtures\.js"/, [{ file: "test/live/fixtures.ts" }]],
];

describe("no remote spec can reach a database", () => {
  it("scans a real remote suite", () => {
    expect(remoteSources().length).toBeGreaterThan(0);
  });

  it.each(FORBIDDEN_IMPORTS)("finds %s where it is imported (positive control)", (_label, pattern, controls) => {
    for (const control of controls) {
      const [where, raw] = "file" in control ? [`apps/e2e/${control.file}`, read(control.file)] : ["sample", control.sample];
      expect(stripComments(raw), where).toMatch(pattern);
    }
  });

  it.each(FORBIDDEN_IMPORTS)("imports %s nowhere", (_label, pattern) => {
    for (const [name, source] of remoteSources()) {
      expect(source, `apps/e2e/test/remote/${name}`).not.toMatch(pattern);
    }
  });
});

describe("the smoke covers every product screen", () => {
  it("lists the same routes as apps/web/src/screens.ts", () => {
    const spa = readFileSync(path.join(e2eRoot, "..", "web", "src", "screens.ts"), "utf8");
    const spec = read("test", "remote", "screens.spec.ts");

    const routesIn = (source: string) =>
      [...source.matchAll(/\{\s*to:\s*"([^"]+)",\s*label:\s*"([^"]+)"\s*\}/g)]
        .map((match) => `${match[1]} ${match[2]}`)
        .sort();

    const spaRoutes = routesIn(spa);
    expect(spaRoutes.length).toBeGreaterThan(0);
    expect(routesIn(spec)).toEqual(spaRoutes);
  });
});

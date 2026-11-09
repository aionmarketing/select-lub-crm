/**
 * Test design (testing-strategy)
 *
 * Setup: none. This suite deliberately stubs nothing — it reads the REAL
 * `import.meta.env` the runner was started with, which is the only way to prove
 * the wiring `uiVariant.test.ts` cannot: that `--mode antigravity` makes Vite
 * load the repo-root `.env.antigravity` and hand `VITE_UI_VARIANT` to the app.
 *
 * Spec rule (openspec/specs/design-system/spec.md):
 *   The active variant SHALL be chosen when the SPA is started or built, from
 *   the start command's environment or mode.
 *
 * Partitions (one numbered group = modes the spec treats the same):
 *
 *   P1 MODE === "antigravity"  → `pnpm test:web:antigravity`; .env.antigravity
 *                                is loaded and UI_VARIANT is "antigravity"
 *   P2 any other MODE          → plain `pnpm test` (MODE "test"); no mode file
 *                                matches and UI_VARIANT is "cursor"
 *
 * Output partitions:
 *   O1 — "antigravity" (P1)
 *   O2 — "cursor"      (P2)
 *
 * Limits (boundary value analysis):
 *   One assertion, branched on MODE, rather than a skipped test per mode: a
 *   skip would let a broken mode file pass silently in whichever run skipped.
 *
 * Map from each `it` to a partition:
 *
 *   follows the mode the runner was started with → P1 in the antigravity run,
 *                                                  P2 in the default run
 *
 * What would make a test fail:
 *   Deleting `.env.antigravity`, renaming its variable, moving it out of the
 *   repo root (Vite's `envDir`), or a vitest config that stops merging the vite
 *   config and so stops loading mode files.
 *
 * Production decisions: none. This suite pins the mode-to-variant wiring.
 *
 * Not in this file: the narrowing of arbitrary values (uiVariant.test.ts).
 */
import { describe, expect, it } from "vitest";
import { UI_VARIANT } from "./uiVariant.js";

describe("UI_VARIANT under the runner's own mode", () => {
  it("follows the mode the runner was started with", () => {
    const expected = import.meta.env.MODE === "antigravity" ? "antigravity" : "cursor";

    expect(UI_VARIANT).toBe(expected);
  });
});

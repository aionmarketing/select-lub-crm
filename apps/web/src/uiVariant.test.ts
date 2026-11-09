/**
 * Test design (testing-strategy)
 *
 * Setup: `UI_VARIANT` is computed at module load from `import.meta.env`, so each
 * case stubs `VITE_UI_VARIANT`, resets the module registry, and re-imports.
 *
 * Spec rule (openspec/specs/design-system/spec.md):
 *   Build-time UI variant selects the shell composition — two ids, `cursor`
 *   default, and a value that is neither id falls back to `cursor` without
 *   failing to start.
 *
 * Partitions (one numbered group = values the spec treats the same):
 *
 *   P1 "antigravity"  → the only value that selects the antigravity composition
 *   P2 "cursor"       → the default, named explicitly
 *   P3 absent         → no variable set at all (the plain `pnpm dev:web` case)
 *   P4 anything else  → typo, empty string, wrong case, unrelated word
 *
 * Output partitions:
 *   O1 — "antigravity" (P1 only)
 *   O2 — "cursor"      (P2, P3, P4)
 *
 * Limits (boundary value analysis):
 *   The match is exact and case-sensitive: "Antigravity" and " antigravity"
 *   are P4, not P1, because Vite passes the env value through verbatim and a
 *   near-miss must not silently ship the other composition.
 *
 * Map from each `it` to a partition:
 *
 *   selects antigravity for the exact id                    → P1 → O1
 *   is cursor when the id is cursor                         → P2 → O2
 *   is cursor when nothing is set                           → P3 → O2
 *   is cursor for a value that is neither id (table)        → P4 → O2
 *
 * What would make a test fail:
 *   Narrowing with `!== "cursor"` instead of `=== "antigravity"` (P4 would
 *   then select antigravity); reading the env at call time rather than once.
 *
 * Production decisions: none. This suite pins the narrowing of one env value.
 *
 * Not in this file: that `--mode antigravity` actually loads `.env.antigravity`
 * (uiVariant.mode.test.ts, which reads the real env rather than a stub).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

async function loadVariant() {
  vi.resetModules();
  const module = await import("./uiVariant.js");
  return module.UI_VARIANT;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("UI_VARIANT", () => {
  it("selects antigravity for the exact id", async () => {
    vi.stubEnv("VITE_UI_VARIANT", "antigravity");

    await expect(loadVariant()).resolves.toBe("antigravity");
  });

  it("is cursor when the id is cursor", async () => {
    vi.stubEnv("VITE_UI_VARIANT", "cursor");

    await expect(loadVariant()).resolves.toBe("cursor");
  });

  it("is cursor when nothing is set", async () => {
    vi.stubEnv("VITE_UI_VARIANT", undefined);

    await expect(loadVariant()).resolves.toBe("cursor");
  });

  it.each([
    ["empty", ""],
    ["capitalised", "Antigravity"],
    ["padded", " antigravity"],
    ["a typo", "antigravty"],
    ["an unrelated word", "whatsapp"],
  ])("is cursor for %s", async (_label, value) => {
    vi.stubEnv("VITE_UI_VARIANT", value);

    await expect(loadVariant()).resolves.toBe("cursor");
  });
});

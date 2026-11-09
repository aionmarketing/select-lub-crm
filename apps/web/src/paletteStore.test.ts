/**
 * Test design (testing-strategy)
 *
 * Setup: usePalette zustand store + jsdom localStorage. Each stored-value it
 * seeds storage, then `vi.resetModules()` + dynamic import re-runs the
 * module's own initializer, so the SUT's read rule (not a copy of it) decides
 * the resolved id. The two throw its below replace `Storage.prototype`'s
 * `getItem`/`setItem` with a mock that throws, since jsdom's own storage
 * never throws on its own — the technique real private-mode browsers need a
 * mock to simulate in any test environment, not a jsdom limitation.
 *
 * Oracle: openspec design-system "Palette choice survives reload in this
 * browser" (brand-palette-switch) — only `black-cta` is accepted as
 * non-default; empty / garbage / `yellow-cta` all resolve to `yellow-cta`;
 * setPaletteId writes `select-lub.palette`. The spec does not mention a
 * throwing store, so the two throw its below are governed instead by the
 * module's own pre-existing documentation, cited per it: `setPaletteId`'s
 * catch (paletteStore.ts:30-31) carries its own comment, "storage unavailable
 * (private mode) — the in-memory choice still applies," and `usePalette`'s
 * JSDoc (paletteStore.ts:20) already states "invalid stored values fall back
 * to yellow-cta" for the read side — a storage read that throws is, under
 * that same sentence, one more way no valid stored value is obtained, so it
 * resolves the same way. That connection is this file's own reading of the
 * doc, named as such rather than passed off as a verbatim citation. Both
 * catches were confirmed against the code before writing: `storedPaletteId`
 * falls through to `return "yellow-cta"`, and `setPaletteId`'s catch is empty
 * (a no-op) so execution reaches the `set()` call below the try — code and
 * doc agree in both places, no divergence to report.
 *
 * Axes
 *   A1 stored value — absent / "black-cta" / "yellow-cta" / garbage ("nope")
 *   A2 action — initial read / setPaletteId
 *   A3 storage failure — getItem throws / setItem throws
 *
 * Outputs
 *   O1 resolved id yellow-cta; O2 resolved id black-cta; O3 key written
 *   O4 getItem throw resolves to yellow-cta; O5 setItem throw still updates
 *      in-memory state and does not throw out of setPaletteId
 *
 * Sampled-cell
 *   absent → yellow            | A1 absent  | O1 | default flipped
 *   garbage "nope" → yellow    | A1 garbage | O1 | unknown id honored
 *   "yellow-cta" → yellow      | A1 yellow  | O1 | strict-equality bug
 *   "black-cta" → black        | A1 black   | O2 | non-default lost
 *   setPaletteId writes key    | A2 set     | O3 | choice not persisted
 *   getItem throws → yellow    | A3 getItem | O4 | throw escapes init
 *   setItem throws, state sticks | A3 setItem | O5 | throw escapes setPaletteId, or state not updated
 *
 * Decision / branch map (paletteStore.ts):
 *   `=== "black-cta"` ternary — T: black it; F: absent/garbage/yellow its
 *   storedPaletteId catch — T: getItem-throws it; F: every other read it
 *   setPaletteId catch — T: setItem-throws it; F: every other set it
 *
 * Out of scope: the header control rendering (paletteSwitch.test.tsx);
 * cross-tab sync (unspecified).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const STORAGE_KEY = "select-lub.palette";

async function importFreshStore() {
  vi.resetModules();
  return import("./paletteStore.js");
}

describe("paletteStore", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it.each([
    ["absent", null, "yellow-cta"],
    ["garbage", "nope", "yellow-cta"],
    ["yellow-cta", "yellow-cta", "yellow-cta"],
    ["black-cta", "black-cta", "black-cta"],
  ] as const)("stored %s resolves to %s", async (_label, stored, expected) => {
    if (stored !== null) {
      localStorage.setItem(STORAGE_KEY, stored);
    }
    const { usePalette } = await importFreshStore();
    expect(usePalette.getState().paletteId).toBe(expected);
  });

  it("setPaletteId writes the storage key and updates state", async () => {
    const { usePalette, PALETTE_STORAGE_KEY } = await importFreshStore();
    expect(PALETTE_STORAGE_KEY).toBe(STORAGE_KEY);
    usePalette.getState().setPaletteId("black-cta");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("black-cta");
    expect(usePalette.getState().paletteId).toBe("black-cta");
    usePalette.getState().setPaletteId("yellow-cta");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("yellow-cta");
    expect(usePalette.getState().paletteId).toBe("yellow-cta");
  });

  it("falls back to yellow-cta when reading storage throws (private mode)", async () => {
    const getItemSpy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    try {
      const { usePalette } = await importFreshStore();
      expect(usePalette.getState().paletteId).toBe("yellow-cta");
    } finally {
      getItemSpy.mockRestore();
    }
  });

  it("keeps the in-memory choice when writing storage throws (private mode)", async () => {
    const { usePalette } = await importFreshStore();
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    try {
      expect(() => usePalette.getState().setPaletteId("black-cta")).not.toThrow();
      expect(usePalette.getState().paletteId).toBe("black-cta");
    } finally {
      setItemSpy.mockRestore();
    }
  });
});

/**
 * Zustand store for the hand-set light palette (`yellow-cta` | `black-cta`), persisted per browser.
 */
import { create } from "zustand";
import type { PaletteId } from "./theme.js";

/** `localStorage` key for the selected {@link PaletteId}. */
export const PALETTE_STORAGE_KEY = "select-lub.palette";

function storedPaletteId(): PaletteId {
  try {
    return localStorage.getItem(PALETTE_STORAGE_KEY) === "black-cta" ? "black-cta" : "yellow-cta";
  } catch {
    return "yellow-cta";
  }
}

/**
 * Zustand hook for the hand-set light palette, persisted in {@link PALETTE_STORAGE_KEY}.
 * @returns `paletteId` and `setPaletteId`; invalid stored values fall back to `yellow-cta`.
 */
export const usePalette = create<{
  paletteId: PaletteId;
  setPaletteId: (id: PaletteId) => void;
}>((set) => ({
  paletteId: storedPaletteId(),
  setPaletteId: (id) => {
    try {
      localStorage.setItem(PALETTE_STORAGE_KEY, id);
    } catch {
      // storage unavailable (private mode) — the in-memory choice still applies
    }
    set({ paletteId: id });
  },
}));

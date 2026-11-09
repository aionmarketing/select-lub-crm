/**
 * The build-time UI variant (`cursor` | `antigravity`), fixed when the SPA is started or built.
 */

/** Identifies which shell composition the SPA was built with (`cursor` default). */
export type UiVariant = "cursor" | "antigravity";

/**
 * The active variant, read once from `VITE_UI_VARIANT`.
 *
 * Unlike the palette, this is NOT a runtime choice: it comes from the start
 * command's mode (`--mode antigravity` loads `.env.antigravity`) or from the
 * environment, is never persisted, and never reaches the API. Anything that is
 * not `antigravity` — absent, empty, or a typo — is `cursor`, so a bad value
 * degrades to the default composition instead of failing the boot.
 */
export const UI_VARIANT: UiVariant =
  import.meta.env.VITE_UI_VARIANT === "antigravity" ? "antigravity" : "cursor";

/**
 * Selects the screen navigation for the build-time UI variant.
 *
 * Consumers keep importing `./ScreenNav.js` and get whichever composition the
 * SPA was started with — the artboard's horizontal row on `cursor`, the
 * vertical icon rail on `antigravity`. The choice is a constant folded at build
 * time, not a runtime branch.
 */
import { ScreenNav as ScreenNavAntigravity } from "./ScreenNav.antigravity.js";
import { ScreenNav as ScreenNavCursor } from "./ScreenNav.cursor.js";
import { UI_VARIANT } from "./uiVariant.js";

export { SCREENS } from "./screens.js";

/** The six-screen navigation of the active variant. */
export const ScreenNav =
  UI_VARIANT === "antigravity" ? ScreenNavAntigravity : ScreenNavCursor;

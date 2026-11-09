/**
 * Selects the Conversas composition for the build-time UI variant.
 *
 * `cursor` keeps the three-pane inbox the artboards draw; `antigravity` is the
 * full-viewport four-column layout whose columns scroll independently. Both
 * satisfy the same `conversas` requirements — only the arrangement differs.
 */
import { ConversasPage as ConversasPageAntigravity } from "./ConversasPage.antigravity.js";
import { ConversasPage as ConversasPageCursor } from "./ConversasPage.cursor.js";
import { UI_VARIANT } from "./uiVariant.js";

/** The Conversas screen of the active variant. */
export const ConversasPage =
  UI_VARIANT === "antigravity" ? ConversasPageAntigravity : ConversasPageCursor;

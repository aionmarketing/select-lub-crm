/**
 * Selects the contact rail for the build-time UI variant.
 *
 * `antigravity` draws each rail section as a card with its own loading text and
 * retry action; `cursor` keeps the artboard's stacked sections.
 */
import { ContactRail as ContactRailAntigravity } from "./contact-rail.antigravity.js";
import { ContactRail as ContactRailCursor } from "./contact-rail.cursor.js";
import { UI_VARIANT } from "../uiVariant.js";

export { OmiePendenciasPanel } from "./prefill.js";

/** The cadastro / vehicles / services / schedule rail of the active variant. */
export const ContactRail =
  UI_VARIANT === "antigravity" ? ContactRailAntigravity : ContactRailCursor;

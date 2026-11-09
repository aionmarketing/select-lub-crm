import { authHandlers } from "./handlers/auth.js";
import { conversasHandlers } from "./handlers/conversas.js";
import { prefillHandlers } from "./handlers/prefill.js";
import { followUpHandlers } from "./handlers/follow-up.js";
import { reportsHandlers } from "./handlers/reports.js";
import { tagsHandlers } from "./handlers/tags.js";

export const handlers = [
  ...authHandlers,
  ...conversasHandlers,
  ...prefillHandlers,
  ...followUpHandlers,
  ...reportsHandlers,
  ...tagsHandlers,
];

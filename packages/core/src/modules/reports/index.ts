/**
 * The reports module: Relatórios. One slice, `report-conversations`
 * (`GET /reports/conversations`), which also keeps the attribution rows current
 * as a side effect of the read. Writes only `attribution_rule` and the three
 * `service_*_attribution` tables; every other table it touches is a foreign read.
 *
 * The composition root registers it with `createHttpPlugin(ports)`. The one
 * port is the follow-up rules' unanswered-quote count, which `apps/api` still
 * computes; the ports live in this closure, per app, never in a module-level
 * variable, so each test's app carries its own.
 *
 * Public surface for other modules: `./contracts/` (the REP-15 funnel and the
 * HTTP schemas), reached as `@select-lub/core/modules/reports/contracts`.
 */
import { registerSlice, type HttpPlugin } from "../../kernel/http.js";
import {
  reportConversationsRoute,
  type ReportConversationsPorts,
} from "./report-conversations/index.js";

export type { ReportConversationsPorts as ReportsPorts } from "./report-conversations/index.js";

/**
 * The module's HTTP plugin, with its ports closed over.
 *
 * @param ports - What the module needs from outside it; see `ReportsPorts`.
 * @returns The plugin the composition root calls with its app.
 */
export function createHttpPlugin(ports: ReportConversationsPorts): HttpPlugin {
  return (app) => {
    registerSlice(app, "reports", "report-conversations", reportConversationsRoute(ports));
  };
}

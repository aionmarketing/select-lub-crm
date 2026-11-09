/**
 * The reports module's public surface: what another module, or `apps/api`, may
 * call. Reached from outside the package as
 * `@select-lub/core/modules/reports/contracts`.
 */
export {
  isNovaInPeriod,
  reportFunnel,
  type FunnelAttribution,
  type FunnelConversation,
  type FunnelQuote,
  type ReportFunnel,
} from "./funnel.js";
export {
  reportQuerySchema,
  reportResultSchema,
  type ReportQuery,
  type ReportResult,
} from "./http.js";

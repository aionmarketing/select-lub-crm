/**
 * Relatórios and Follow-up HTTP.
 */
import {
  type FollowUpCloseBody,
  followUpOptionalCountsSchema,
  type FollowUpOptionalCounts,
  followUpResultSchema,
  reportResultSchema,
  type FollowUpResult,
  type ReportQuery,
  type ReportResult,
} from "@select-lub/shared-types";
import { apiBase, apiRead, headers, parse } from "./http.js";

/**
 * Fetches aggregated conversation metrics for the reports screen.
 * @param query - Period bounds (ISO instants), bucket granularity, and optional source/tag/campaign filters.
 * @returns Parsed `ReportResult` from `GET /reports/conversations`.
 */
export async function fetchConversationReport(
  query: ReportQuery,
): Promise<ReportResult> {
  const params = new URLSearchParams({
    periodStart: query.periodStart,
    periodEnd: query.periodEnd,
    granularity: query.granularity,
  });
  if (query.sourceType) {
    params.set("sourceType", query.sourceType);
  }
  if (query.tagId) {
    params.set("tagId", query.tagId);
  }
  if (query.campaignId) {
    params.set("campaignId", query.campaignId);
  }
  const body = await parse(
    await apiRead(`${apiBase}/reports/conversations?${params}`),
  );
  return reportResultSchema.parse(body);
}

/**
 * Loads the four Follow-up section lists and matching counts for the current unit.
 *
 * @param view - `open` is the queue; `closed` is the same four sections built
 *   from the entries closed out of it, so a suppressed queue stays auditable.
 * @returns Parsed `FollowUpResult` from `GET /follow-ups`.
 */
export async function fetchFollowUp(view: "open" | "closed" = "open"): Promise<FollowUpResult> {
  const query = view === "closed" ? "?closed=1" : "";
  const body = await parse(await apiRead(`${apiBase}/follow-ups${query}`));
  return followUpResultSchema.parse(body);
}

/**
 * Closes one message-pendency entry, or reopens it.
 *
 * The anchor travels with the request rather than being looked up server-side:
 * it is what the attendant was looking at when they decided, so closing against
 * it cannot suppress a newer quote that arrived while the screen was open.
 *
 * @param action - `close` takes the entry off its section and its count;
 *   `reopen` puts it back.
 * @param body - Section, conversation, and the anchor that qualified the entry.
 * @throws Error `http 404` when the conversation is not the current unit's.
 */
export async function setFollowUpClosed(
  action: "close" | "reopen",
  body: FollowUpCloseBody,
): Promise<void> {
  await parse(
    await fetch(`${apiBase}/follow-ups/${action}`, {
      method: "POST",
      headers: { ...headers(), "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

/**
 * The four Follow-up counts alone, without the lists.
 *
 * Same aggregation the lists come from, deliberately: a second reader over its
 * own predicates is how a badge starts disagreeing with the screen it points
 * at. Used by the navigation badge and the Relatórios alert strip, neither of
 * which needs the rows.
 *
 * @returns The counts; each is optional, and absent means unavailable rather
 *   than zero.
 */
export async function fetchFollowUpCounts(): Promise<FollowUpOptionalCounts> {
  return followUpOptionalCountsSchema.parse(
    await parse(await apiRead(`${apiBase}/follow-up-counts`)),
  );
}

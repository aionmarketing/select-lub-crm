/**
 * Pure report aggregation from normalized conversation rows (and optional
 * schedule rows): the scoping filter, the buckets, the unanswered list, the
 * tag and campaign breakdowns, and the scheduled counts, assembled into one
 * `ReportResult`.
 *
 * The calendar arithmetic is in `calendar.ts` and the response-time statistics
 * in `response-times.ts`; both were part of this file before the reports module
 * existed and split out by topic when it moved under the line cap.
 */
import { emptyReportInsights, type ReportBucket, type ReportByCampaignRow, type ReportByTagRow, type ReportQuery, type ReportResult, type ReportScheduledCounts, type UnansweredItem } from "../contracts/http.js";
import { oldestPendingShouldReplyAt } from "../../conversations/contracts/http.js";
import { bucketKey, inHalfOpenPeriod } from "./calendar.js";
import { coverageOf, firstResponseStats, subsequentResponseStats } from "./response-times.js";

/** Maximum unanswered conversations returned in the `unanswered` list section. */
export const UNANSWERED_ITEM_CAP = 100;

/** Normalized conversation facts fed into {@link buildReport}. */
export type ReportConversationRow = {
  conversationId: string;
  unitId: string;
  sourceType: "AD" | "ORGANIC" | "UNKNOWN";
  firstInboundAt: Date | null;
  firstOutboundAt: Date | null;
  campaignId: string | null;
  adSetId: string | null;
  adId: string | null;
  tags: { tagId: string; name: string; active: boolean }[];
  messages: { direction: "inbound" | "outbound"; providerTimestamp: Date; shouldReply?: boolean | null }[];
  customerId: string | null;
};

/** Scheduled-message facts included in report send/cancel counts. */
export type ReportScheduledRow = {
  status: string;
  scheduledAt: Date;
  sentAt: Date | null;
};

type BucketAcc = { newConversationCount: number; activeConversationCount: number };

/** Optional schedule rows, attribution section, and clock override for deterministic tests. */
export type BuildReportExtras = {
  scheduled?: ReportScheduledRow[];
  now?: Date;
  attribution?: ReportResult["attribution"];
  insights?: ReportResult["insights"];
};

/**
 * Applies unit and report filter dimensions to a normalized conversation row.
 *
 * @param row - Normalized conversation facts from Prisma or memory loaders.
 * @param unitId - Loja that must match `row.unitId`.
 * @param query - Optional source type, tag id, and campaign id filters from the report request.
 * @returns Whether the row should be included in the aggregated report.
 */
export function conversationInScope(
  row: ReportConversationRow,
  unitId: string,
  query: ReportQuery,
): boolean {
  if (row.unitId !== unitId) {
    return false;
  }
  if (query.sourceType && row.sourceType !== query.sourceType) {
    return false;
  }
  if (query.tagId && !row.tags.some((tag) => tag.tagId === query.tagId && tag.active)) {
    return false;
  }
  if (query.campaignId && row.campaignId !== query.campaignId) {
    return false;
  }
  return true;
}

function sortMessages(messages: ReportConversationRow["messages"]) {
  return [...messages].sort(
    (a, b) => a.providerTimestamp.getTime() - b.providerTimestamp.getTime(),
  );
}

function subsequentDurations(messages: ReportConversationRow["messages"]) {
  const sorted = sortMessages(messages);
  const durations: number[] = [];
  let inboundTotal = 0;
  for (const inbound of sorted) {
    if (inbound.direction !== "inbound") {
      continue;
    }
    inboundTotal += 1;
    const outbound = sorted.find(
      (candidate) =>
        candidate.direction === "outbound" &&
        candidate.providerTimestamp.getTime() > inbound.providerTimestamp.getTime(),
    );
    if (outbound) {
      durations.push(
        outbound.providerTimestamp.getTime() - inbound.providerTimestamp.getTime(),
      );
    }
  }
  return { durations, inboundTotal };
}

function emptyScheduled(): ReportScheduledCounts {
  return { scheduled: 0, sent: 0, cancelled: 0, failed: 0 };
}

/**
 * Tallies scheduled-message statuses whose timestamps fall in the report period.
 *
 * @param rows - Scheduled message rows with status and relevant timestamps.
 * @param periodStart - Inclusive start of the report period.
 * @param periodEnd - Exclusive end of the report period.
 * @returns Counts of scheduled, sent, cancelled, and failed messages in the period.
 */
export function countScheduled(
  rows: ReportScheduledRow[],
  periodStart: Date,
  periodEnd: Date,
): ReportScheduledCounts {
  const counts = emptyScheduled();
  for (const row of rows) {
    if (row.status === "SCHEDULED" || row.status === "CANCELLED") {
      if (!inHalfOpenPeriod(row.scheduledAt, periodStart, periodEnd)) {
        continue;
      }
      if (row.status === "SCHEDULED") {
        counts.scheduled += 1;
      } else {
        counts.cancelled += 1;
      }
      continue;
    }
    if (row.status === "SENT" || row.status === "FAILED") {
      if (!row.sentAt || !inHalfOpenPeriod(row.sentAt, periodStart, periodEnd)) {
        continue;
      }
      if (row.status === "SENT") {
        counts.sent += 1;
      } else {
        counts.failed += 1;
      }
    }
  }
  return counts;
}

function bumpBucket(buckets: Map<string, BucketAcc>, key: string, field: keyof BucketAcc) {
  const current = buckets.get(key) ?? { newConversationCount: 0, activeConversationCount: 0 };
  current[field] += 1;
  buckets.set(key, current);
}

function toBuckets(buckets: Map<string, BucketAcc>): ReportBucket[] {
  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([bucketStart, counts]) => ({ bucketStart, ...counts }));
}

/**
 * Builds the full {@link ReportResult} DTO from normalized rows and optional schedule extras.
 *
 * @param rows - Conversation facts already loaded from persistence.
 * @param unitId - Loja to scope metrics to.
 * @param query - Period, granularity, and filter dimensions from the HTTP request.
 * @param extras - Optional scheduled rows and clock override for deterministic tests.
 * @returns Complete report payload including buckets, response stats, and scheduled counts.
 */
export function buildReport(
  rows: ReportConversationRow[],
  unitId: string,
  query: ReportQuery,
  extras: BuildReportExtras = {},
): ReportResult {
  const periodStart = new Date(query.periodStart);
  const periodEnd = new Date(query.periodEnd);
  const now = extras.now ?? new Date();

  const scoped = rows.filter((row) => conversationInScope(row, unitId, query));

  const novas = scoped.filter((row) => {
    if (!row.firstInboundAt) {
      return false;
    }
    return inHalfOpenPeriod(row.firstInboundAt, periodStart, periodEnd);
  });

  const buckets = new Map<string, BucketAcc>();
  for (const row of novas) {
    bumpBucket(buckets, bucketKey(row.firstInboundAt!, query.granularity), "newConversationCount");
  }

  let activeConversationCount = 0;
  for (const row of scoped) {
    const activeKeys = new Set<string>();
    for (const message of row.messages) {
      if (inHalfOpenPeriod(message.providerTimestamp, periodStart, periodEnd)) {
        activeKeys.add(bucketKey(message.providerTimestamp, query.granularity));
      }
    }
    if (activeKeys.size === 0) {
      continue;
    }
    activeConversationCount += 1;
    for (const key of activeKeys) {
      bumpBucket(buckets, key, "activeConversationCount");
    }
  }

  const durations: number[] = [];
  let answered = 0;
  for (const row of novas) {
    if (row.firstOutboundAt && row.firstInboundAt) {
      answered += 1;
      durations.push(row.firstOutboundAt.getTime() - row.firstInboundAt.getTime());
    }
  }

  const subsequentDurationsMs: number[] = [];
  let inboundTotal = 0;
  for (const row of novas) {
    const pair = subsequentDurations(row.messages);
    inboundTotal += pair.inboundTotal;
    subsequentDurationsMs.push(...pair.durations);
  }

  const unansweredItems: UnansweredItem[] = [];
  for (const row of scoped) {
    const oldest = oldestPendingShouldReplyAt(row.messages);
    if (!oldest) {
      continue;
    }
    unansweredItems.push({
      conversationId: row.conversationId,
      waitMs: Math.max(0, now.getTime() - oldest.getTime()),
    });
  }
  unansweredItems.sort((a, b) => b.waitMs - a.waitMs);

  const byTagMap = new Map<string, ReportByTagRow>();
  for (const row of novas) {
    const seen = new Set<string>();
    for (const tag of row.tags) {
      if (!tag.active || seen.has(tag.tagId)) {
        continue;
      }
      seen.add(tag.tagId);
      const current = byTagMap.get(tag.tagId) ?? { tagId: tag.tagId, name: tag.name, count: 0 };
      current.count += 1;
      byTagMap.set(tag.tagId, current);
    }
  }
  const byTag = [...byTagMap.values()].sort(
    (a, b) => b.count - a.count || a.name.localeCompare(b.name),
  );

  const byCampaignMap = new Map<string, ReportByCampaignRow>();
  for (const row of novas) {
    if (!row.campaignId) {
      continue;
    }
    const key = `${row.campaignId}\0${row.adSetId ?? ""}\0${row.adId ?? ""}`;
    const current = byCampaignMap.get(key) ?? {
      campaignId: row.campaignId,
      adSetId: row.adSetId,
      adId: row.adId,
      count: 0,
    };
    current.count += 1;
    byCampaignMap.set(key, current);
  }
  const byCampaign = [...byCampaignMap.values()].sort(
    (a, b) => b.count - a.count || a.campaignId.localeCompare(b.campaignId),
  );

  return {
    query,
    buckets: toBuckets(buckets),
    newConversationCount: novas.length,
    activeConversationCount,
    firstResponse: firstResponseStats(durations),
    coverage: coverageOf(answered, novas.length),
    unanswered: {
      count: unansweredItems.length,
      items: unansweredItems.slice(0, UNANSWERED_ITEM_CAP),
    },
    subsequentResponse: subsequentResponseStats(subsequentDurationsMs, inboundTotal),
    respondedRate: coverageOf(answered, novas.length),
    byTag,
    byCampaign,
    scheduled: countScheduled(extras.scheduled ?? [], periodStart, periodEnd),
    attribution: extras.attribution ?? {
      rule: { windowDays: 30, version: 1 },
      scheduledReturn: { count: 0 },
      conversion: { converted: 0, total: 0, bySource: [] },
    },
    insights: extras.insights ?? emptyReportInsights(),
  };
}

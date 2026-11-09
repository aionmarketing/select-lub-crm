/**
 * Test design (testing-strategy)
 *
 * Setup: fetchConversationReport against shared MSW + reportResultSchema.
 *
 * Oracle: shared Relatórios contract — valid fixture parses; invalid
 * (negative count) rejects; HTTP !ok throws; sourceType query param only
 * when set.
 *
 * Axes
 *   A1 HTTP ok vs not
 *   A2 body valid vs negative newConversationCount
 *   A3 sourceType omitted vs AD
 *   A4 tagId / campaignId omitted vs set
 *
 * Outputs: O1 parsed ReportResult; O2 throw
 *
 * Sampled-cell
 *   fixture parses          | A1 ok A2 valid A3 omit | O1 | throw
 *   negative count          | A2 invalid             | O2 | resolves
 *   HTTP 500                | A1 not ok              | O2 | parses
 *   sourceType AD on URL    | A3 AD                  | O1 | param missing
 *   tagId + campaignId URL  | A4 set                 | O1 | params missing
 *
 * Decision map (api/reports.ts fetchConversationReport)
 *   D1 if (query.sourceType) T: AD test; F: fixture without sourceType
 *   D2 if (query.tagId) T: tag+campaign test; F: omitted
 *   D3 if (query.campaignId) T: tag+campaign test; F: omitted
 *   parse() if (!response.ok) T: 500; F: 200 tests
 *
 * Out of scope: unit header helper (same as Conversas; VITE_UNIT_ID env).
 */

import { afterEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { emptyReportInsights } from "@select-lub/shared-types";
import { fetchConversationReport } from "./api.js";
import { server } from "../test/msw/server.js";

const valid = {
  query: {
    periodStart: "2026-08-01T03:00:00.000Z",
    periodEnd: "2026-09-01T03:00:00.000Z",
    granularity: "day" as const,
  },
  buckets: [],
  newConversationCount: 0,
  activeConversationCount: 0,
  firstResponse: {
    meanMs: null,
    medianMs: null,
    p90Ms: null,
    eligibleCount: 0,
  },
  coverage: { answered: 0, total: 0 },
  unanswered: { count: 0, items: [] },
  subsequentResponse: {
    meanMs: null,
    medianMs: null,
    p90Ms: null,
    eligibleCount: 0,
    inboundTotal: 0,
  },
  respondedRate: { answered: 0, total: 0 },
  byTag: [],
  byCampaign: [],
  scheduled: { scheduled: 0, sent: 0, cancelled: 0, failed: 0 },
  attribution: {
    rule: { windowDays: 30, version: 1 },
    scheduledReturn: { count: 0 },
    conversion: { converted: 0, total: 0, bySource: [] },
  },
  insights: emptyReportInsights(),
};

afterEach(() => {
  server.resetHandlers();
});

describe("fetchConversationReport", () => {
  it("parses a fixture result", async () => {
    server.use(http.get("*/api/reports/conversations", () => HttpResponse.json(valid)));

    const result = await fetchConversationReport(valid.query);

    expect(result).toEqual(valid);
  });

  it("rejects an invalid payload", async () => {
    server.use(
      http.get("*/api/reports/conversations", () =>
        HttpResponse.json({ ...valid, newConversationCount: -1 }),
      ),
    );

    await expect(fetchConversationReport(valid.query)).rejects.toThrow();
  });

  it("throws when the HTTP status is not ok", async () => {
    server.use(
      http.get("*/api/reports/conversations", () =>
        HttpResponse.json({ error: "boom" }, { status: 500 }),
      ),
    );

    await expect(fetchConversationReport(valid.query)).rejects.toThrow(/http 500/);
  });

  it("sends sourceType when the query includes an origin", async () => {
    let sourceType: string | null = null;
    server.use(
      http.get("*/api/reports/conversations", ({ request }) => {
        sourceType = new URL(request.url).searchParams.get("sourceType");
        return HttpResponse.json({
          ...valid,
          query: { ...valid.query, sourceType: "AD" as const },
        });
      }),
    );

    await fetchConversationReport({ ...valid.query, sourceType: "AD" });

    expect(sourceType).toBe("AD");
  });

  it("sends tagId and campaignId when the query includes those filters", async () => {
    let tagId: string | null = null;
    let campaignId: string | null = null;
    server.use(
      http.get("*/api/reports/conversations", ({ request }) => {
        const params = new URL(request.url).searchParams;
        tagId = params.get("tagId");
        campaignId = params.get("campaignId");
        return HttpResponse.json({
          ...valid,
          query: { ...valid.query, tagId: "tag-1", campaignId: "camp-1" },
        });
      }),
    );

    await fetchConversationReport({ ...valid.query, tagId: "tag-1", campaignId: "camp-1" });

    expect(tagId).toBe("tag-1");
    expect(campaignId).toBe("camp-1");
  });
});

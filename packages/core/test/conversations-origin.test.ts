/**
 * Test design (testing-strategy)
 *
 * Moved from apps/worker/src/ingest/origin.test.ts (adopt-modular-vertical-slices 4A),
 * all cases, assertions unchanged. origin.ts is conversations' internal/ now; this
 * pure test sits in packages/core/test/ because internal/ may not import the test
 * fixtures (src/testing). Module role: none — no database.
 *
 * Setup: classifyConversationOrigin / originOf / mergeOrigin / formatOriginLog.
 * No store, no HTTP.
 *
 * Oracle: conversation-origin-classification design D1 + whatsapp-channel
 *   delta — AD only with ad identifiers; inbound + no ad + no marker →
 *   ORGANIC customer_initiated; outbound-first → UNKNOWN; explicit
 *   organic marker without ad → ORGANIC; marker + ctwa → AD; every
 *   branch writes ruleVersion ctwa-v1 and evidenceAt; logs omit the
 *   full clid (last-4 only). conversionExternalSource is an AD key
 *   whose value is an id — the token "organic" is not ad evidence
 *   (spec: AD only with ad identifiers).
 *
 * Axes
 *   A1 ad keys — ctwaClid / ctwa_clid / contextInfo / conversionExternalSource
 *     / adsContextInfo.sourceId / campaign / adSet / ad / none
 *   A2 key spelling — camelCase / snake_case / nested / array-wrapped
 *   A3 ad value — missing / "" / "   " / "x" / long id
 *   A4 organic marker — absent / organic / ORGANIC / plus ctwa
 *   A5 direction — inbound / outbound
 *   A6 payload root — object / primitive / adsContextInfo present
 *   A7 stored class (merge) — none / UNKNOWN / ORGANIC / AD
 *   A8 next class (merge) — ORGANIC / AD / UNKNOWN
 *   BVA: empty / whitespace / one-char id; evidenceReference length
 *     0 (null) / 4 / 19 (secret)
 *
 * Outputs
 *   O1 AD ctwa; O2 AD ads_context; O3 ORGANIC customer_initiated;
 *   O4 ORGANIC organic_marker; O5 UNKNOWN none; O6 merge keeps stored;
 *   O7 merge upgrades to AD; O8 log without full clid
 *
 * Sampled-cell
 *   ctwaClid camelCase          | A1 A2     | O1 | UNKNOWN/ORGANIC
 *   nested contextInfo.ctwa_clid| A1 A2     | O1 | skip nested
 *   conversionExternal FB       | A1        | O1 | treated as organic
 *   conversionExternal organic  | A1 A4     | O3 | AD
 *   adsContextInfo.sourceId     | A1 A6     | O2 | evidenceType ctwa
 *   campaignId only             | A1        | O2 | UNKNOWN
 *   adSetId only                | A1        | O2 | UNKNOWN
 *   adId only                   | A1        | O2 | UNKNOWN
 *   empty ctwa                  | A3 BVA    | O3 | AD
 *   whitespace ctwa             | A3 BVA    | O3 | AD
 *   one-char campaign           | A3 BVA    | O2 | skipped as empty
 *   inbound empty               | A5 A6     | O3 | UNKNOWN
 *   outbound empty              | A5        | O5 | ORGANIC
 *   marker ORGANIC              | A4        | O4 | UNKNOWN
 *   marker + ctwa               | A4        | O1 | ORGANIC
 *   primitive payload inbound   | A6        | O3 | throw
 *   array-wrapped ctwa          | A2        | O1 | miss walk
 *   originOf attached           | fallback F| O1 | reclassify empty
 *   originOf missing inbound    | fallback T| O3 | keep attached
 *   merge new row               | A7 none   | O7 | leave null
 *   merge AD + later empty      | A7 A8     | O6 | downgrade
 *   merge ORGANIC + ctwa        | A7 A8     | O7 | stay ORGANIC
 *   merge UNKNOWN + inbound     | A7 A8     | O6 | rewrite ORGANIC
 *   log last-4 only             | A3 BVA    | O8 | full secret
 *   log without reference       | A3 len 0  | O8 | includes clid
 *
 * Decision / branch map (origin.ts)
 *   walk !isRecord              T primitive-payload it; F object its
 *   child is array              T array-wrapped it; F nested contextInfo
 *   namedChild adsContextInfo   T sourceId it; F inbound empty
 *   readInsensitive nonempty    T ctwa it; F empty/whitespace its
 *   conversionExternal && !org  T FB it; F organic-token it
 *   isOrganicToken              T marker / conversion-organic; F FB
 *   adsContext ? read           T sourceId it; F inbound empty
 *   hasAd                       T AD its; F empty/marker its
 *   marker                      T marker it; F inbound/outbound empty
 *   direction === inbound       T inbound empty; F outbound empty
 *   ctwaClid ? ctwa : ads       T ctwa it; F campaign/sourceId its
 *   originOf message.origin     T attached it; F missing it
 *   merge !stored               T new-row it; F existing its
 *   stored === AD               T stay-AD it; F upgrade/keep its
 *   next === AD                 T upgrade it; F UNKNOWN+inbound it
 *   formatOriginLog ref         T last-4 it; F no-reference it
 *
 * Out of scope: persist/upgrade (origin.ingest.test.ts); REST (history.test.ts).
 */
import { describe, expect, it } from "vitest";
import {
  CLASSIFICATION_RULE_VERSION,
  classifyConversationOrigin,
  formatOriginLog,
  mergeOrigin,
  originOf,
  type OriginClassification,
} from "../src/modules/conversations/internal/origin.js";

const evidenceAt = new Date("2026-08-01T12:00:00.000Z");
const SECRET_CLID = "CTWA-SECRET-CLICK-ID";

function classify(
  payload: unknown,
  direction: "inbound" | "outbound" = "inbound",
): OriginClassification {
  return classifyConversationOrigin({ payload, direction, evidenceAt });
}

function expectMeta(result: OriginClassification) {
  expect(result.ruleVersion).toBe(CLASSIFICATION_RULE_VERSION);
  expect(result.evidenceAt).toEqual(evidenceAt);
}

describe("classifyConversationOrigin", () => {
  it("classifies camelCase ctwaClid as AD with ctwa evidence", () => {
    const result = classify({ ctwaClid: SECRET_CLID });

    expectMeta(result);
    expect(result.sourceType).toBe("AD");
    expect(result.evidenceType).toBe("ctwa");
    expect(result.evidenceReference).toBe(SECRET_CLID);
    expect(result.ctwaClid).toBe(SECRET_CLID);
  });

  it("reads ctwa_clid nested under contextInfo", () => {
    const result = classify({
      message: { conversation: "oi", contextInfo: { ctwa_clid: SECRET_CLID } },
    });

    expectMeta(result);
    expect(result.sourceType).toBe("AD");
    expect(result.evidenceType).toBe("ctwa");
    expect(result.evidenceReference).toBe(SECRET_CLID);
  });

  it("treats a non-organic conversionExternalSource as AD", () => {
    const result = classify({ conversionExternalSource: "FB_Ads" });

    expectMeta(result);
    expect(result.sourceType).toBe("AD");
    expect(result.evidenceType).toBe("ctwa");
    expect(result.ctwaClid).toBe("FB_Ads");
  });

  it("does not treat conversionExternalSource organic as ad evidence", () => {
    const result = classify({ conversionExternalSource: "organic" });

    expectMeta(result);
    expect(result.sourceType).toBe("ORGANIC");
    expect(result.evidenceType).toBe("customer_initiated");
    expect(result.ctwaClid).toBeNull();
  });

  it("classifies adsContextInfo.sourceId as AD ads_context", () => {
    const result = classify({ adsContextInfo: { sourceId: "src-9" } });

    expectMeta(result);
    expect(result.sourceType).toBe("AD");
    expect(result.evidenceType).toBe("ads_context");
    expect(result.evidenceReference).toBe("src-9");
    expect(result.ctwaClid).toBeNull();
  });

  it("classifies a campaignId without ctwa as AD ads_context", () => {
    const result = classify({ campaign_id: "camp-1" });

    expectMeta(result);
    expect(result.sourceType).toBe("AD");
    expect(result.evidenceType).toBe("ads_context");
    expect(result.campaignId).toBe("camp-1");
    expect(result.evidenceReference).toBe("camp-1");
  });

  it("classifies an adSetId without ctwa as AD", () => {
    const result = classify({ adSetId: "set-1" });

    expectMeta(result);
    expect(result.sourceType).toBe("AD");
    expect(result.adSetId).toBe("set-1");
  });

  it("classifies an adId without ctwa as AD", () => {
    const result = classify({ ad_id: "ad-1" });

    expectMeta(result);
    expect(result.sourceType).toBe("AD");
    expect(result.adId).toBe("ad-1");
  });

  it("treats an empty ctwaClid as no ad evidence on inbound", () => {
    const result = classify({ ctwaClid: "" });

    expectMeta(result);
    expect(result.sourceType).toBe("ORGANIC");
    expect(result.evidenceType).toBe("customer_initiated");
  });

  it("treats a whitespace-only ctwa_clid as no ad evidence on inbound", () => {
    const result = classify({ ctwa_clid: "   " });

    expectMeta(result);
    expect(result.sourceType).toBe("ORGANIC");
    expect(result.evidenceType).toBe("customer_initiated");
  });

  it("accepts a one-character campaign id as AD", () => {
    const result = classify({ campaignId: "x" });

    expectMeta(result);
    expect(result.sourceType).toBe("AD");
    expect(result.campaignId).toBe("x");
  });

  it("classifies an inbound empty payload as ORGANIC customer_initiated", () => {
    const result = classify({}, "inbound");

    expectMeta(result);
    expect(result.sourceType).toBe("ORGANIC");
    expect(result.evidenceType).toBe("customer_initiated");
    expect(result.evidenceReference).toBeNull();
  });

  it("classifies an outbound empty payload as UNKNOWN", () => {
    const result = classify({}, "outbound");

    expectMeta(result);
    expect(result.sourceType).toBe("UNKNOWN");
    expect(result.evidenceType).toBe("none");
    expect(result.evidenceReference).toBeNull();
  });

  it("classifies an explicit ORGANIC marker without ad ids as ORGANIC", () => {
    const result = classify({ sourceType: "ORGANIC" }, "outbound");

    expectMeta(result);
    expect(result.sourceType).toBe("ORGANIC");
    expect(result.evidenceType).toBe("organic_marker");
  });

  it("lets ctwa win when an organic marker is also present", () => {
    const result = classify({ origin: "organic", ctwaClid: SECRET_CLID });

    expectMeta(result);
    expect(result.sourceType).toBe("AD");
    expect(result.evidenceType).toBe("ctwa");
  });

  it("classifies a primitive payload inbound as ORGANIC", () => {
    const result = classify("not-an-object", "inbound");

    expectMeta(result);
    expect(result.sourceType).toBe("ORGANIC");
    expect(result.evidenceType).toBe("customer_initiated");
  });

  it("walks an array child to find ctwa_clid", () => {
    const result = classify({ items: [{ ctwa_clid: SECRET_CLID }] });

    expectMeta(result);
    expect(result.sourceType).toBe("AD");
    expect(result.ctwaClid).toBe(SECRET_CLID);
  });
});

describe("originOf", () => {
  it("returns the origin already attached on the message", () => {
    const attached = classify({ ctwaClid: SECRET_CLID });

    const result = originOf({
      whatsappConnectionId: "c",
      remoteJid: "5511999999999@s.whatsapp.net",
      chatKey: "5511999999999",
      externalMessageId: "m1",
      direction: "inbound",
      messageType: "text",
      textBody: "oi",
      providerTimestamp: evidenceAt,
      origin: attached,
    });

    expect(result).toBe(attached);
  });

  it("classifies from direction when the message has no origin", () => {
    const result = originOf({
      whatsappConnectionId: "c",
      remoteJid: "5511999999999@s.whatsapp.net",
      chatKey: "5511999999999",
      externalMessageId: "m1",
      direction: "inbound",
      messageType: "text",
      textBody: "oi",
      providerTimestamp: evidenceAt,
    });

    expect(result.sourceType).toBe("ORGANIC");
    expect(result.evidenceType).toBe("customer_initiated");
    expect(result.ruleVersion).toBe(CLASSIFICATION_RULE_VERSION);
    expect(result.evidenceAt).toEqual(evidenceAt);
  });
});

describe("mergeOrigin", () => {
  const organic = classify({}, "inbound");
  const unknown = classify({}, "outbound");
  const ad = classify({ ctwaClid: SECRET_CLID });

  it("writes the classifier output on a new conversation", () => {
    expect(mergeOrigin(null, organic)).toBe(organic);
  });

  it("keeps AD when a later message has no ad evidence", () => {
    expect(mergeOrigin(ad, organic)).toBe(ad);
  });

  it("upgrades ORGANIC to AD when later evidence arrives", () => {
    expect(mergeOrigin(organic, ad)).toBe(ad);
  });

  it("does not rewrite UNKNOWN to ORGANIC after insert", () => {
    expect(mergeOrigin(unknown, organic)).toBe(unknown);
  });
});

describe("formatOriginLog", () => {
  it("omits the full clid and keeps only the last four characters", () => {
    const line = formatOriginLog(classify({ ctwaClid: SECRET_CLID }));

    expect(line).toContain("conversation origin AD ctwa");
    expect(line).toContain("…K-ID");
    expect(line).not.toContain(SECRET_CLID);
  });

  it("omits a ref suffix when there is no evidence reference", () => {
    const line = formatOriginLog(classify({}, "inbound"));

    expect(line).toBe("conversation origin ORGANIC customer_initiated");
    expect(line).not.toContain("ref");
  });
});

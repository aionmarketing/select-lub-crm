/**
 * Conversation origin classification from CTWA, ads context, and organic markers.
 */
import type { CanonicalMessage } from "./canonical-message.js";

/** Version tag stored on classified conversations for rule migrations. */
export const CLASSIFICATION_RULE_VERSION = "ctwa-v1";

/** Evidence channel that justified the origin classification. */
export type OriginEvidenceType =
  | "ctwa"
  | "ads_context"
  | "customer_initiated"
  | "organic_marker"
  | "none";

/** Stored origin fields derived from webhook payload evidence. */
export type OriginClassification = {
  sourceType: "AD" | "ORGANIC" | "UNKNOWN";
  evidenceType: OriginEvidenceType;
  evidenceReference: string | null;
  ctwaClid: string | null;
  campaignId: string | null;
  adSetId: string | null;
  adId: string | null;
  ruleVersion: typeof CLASSIFICATION_RULE_VERSION;
  evidenceAt: Date;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function collectRecords(root: unknown) {
  const out: Record<string, unknown>[] = [];
  const walk = (value: unknown) => {
    if (!isRecord(value)) {
      return;
    }
    out.push(value);
    for (const child of Object.values(value)) {
      if (Array.isArray(child)) {
        for (const item of child) {
          walk(item);
        }
      } else {
        walk(child);
      }
    }
  };
  walk(root);
  return out;
}

function namedChild(root: unknown, name: string) {
  for (const record of collectRecords(root)) {
    for (const [key, value] of Object.entries(record)) {
      if (key.toLowerCase() === name.toLowerCase() && isRecord(value)) {
        return value;
      }
    }
  }
  return null;
}

function readInsensitive(record: Record<string, unknown>, names: string[]) {
  const map = new Map(Object.keys(record).map((key) => [key.toLowerCase(), record[key]]));
  for (const name of names) {
    const raw = map.get(name.toLowerCase());
    if (typeof raw === "string" && raw.trim() !== "") {
      return raw.trim();
    }
  }
  return null;
}

function firstString(records: Record<string, unknown>[], names: string[]) {
  for (const record of records) {
    const found = readInsensitive(record, names);
    if (found) {
      return found;
    }
  }
  return null;
}

function isOrganicToken(value: string) {
  return value.toLowerCase() === "organic";
}

/**
 * Classifies conversation origin from CTWA, ads context, organic markers, or direction.
 *
 * @param input - Message payload and metadata used as classification evidence.
 * @param input.payload - Evolution message payload (searched recursively for ad markers).
 * @param input.direction - Message direction; inbound without ad evidence maps to organic customer-initiated.
 * @param input.evidenceAt - Timestamp stored as `evidenceAt` on the classification.
 * @returns Origin classification with rule version {@link CLASSIFICATION_RULE_VERSION}.
 */
export function classifyConversationOrigin(input: {
  payload: unknown;
  direction: "inbound" | "outbound";
  evidenceAt: Date;
}): OriginClassification {
  const records = collectRecords(input.payload);
  const adsContext = namedChild(input.payload, "adsContextInfo");
  const rawCtwa = firstString(records, ["ctwaClid", "ctwa_clid"]);
  const conversionExternal = firstString(records, ["conversionExternalSource"]);
  const ctwaClid =
    rawCtwa ??
    (conversionExternal && !isOrganicToken(conversionExternal) ? conversionExternal : null);
  const campaignId =
    firstString(records, ["campaignId", "campaign_id"]) ??
    (adsContext ? readInsensitive(adsContext, ["campaignId", "campaign_id"]) : null);
  const adSetId =
    firstString(records, ["adSetId", "ad_set_id", "adsetId"]) ??
    (adsContext ? readInsensitive(adsContext, ["adSetId", "ad_set_id", "adsetId"]) : null);
  const adId =
    firstString(records, ["adId", "ad_id"]) ??
    (adsContext ? readInsensitive(adsContext, ["adId", "ad_id"]) : null);
  const adsSourceId = adsContext ? readInsensitive(adsContext, ["sourceId", "source_id"]) : null;
  const hasAd =
    Boolean(ctwaClid) || Boolean(campaignId) || Boolean(adSetId) || Boolean(adId) || Boolean(adsSourceId);
  const marker = ["sourceType", "conversionSource", "origin"]
    .map((name) => firstString(records, [name]))
    .find((value) => value && isOrganicToken(value));

  const base = {
    ctwaClid: hasAd ? ctwaClid : null,
    campaignId: hasAd ? campaignId : null,
    adSetId: hasAd ? adSetId : null,
    adId: hasAd ? adId : null,
    ruleVersion: CLASSIFICATION_RULE_VERSION,
    evidenceAt: input.evidenceAt,
  } as const;

  if (hasAd) {
    return {
      ...base,
      sourceType: "AD",
      evidenceType: ctwaClid ? "ctwa" : "ads_context",
      evidenceReference: ctwaClid ?? adsSourceId ?? campaignId ?? adSetId ?? adId,
    };
  }
  if (marker) {
    return {
      ...base,
      sourceType: "ORGANIC",
      evidenceType: "organic_marker",
      evidenceReference: null,
      ctwaClid: null,
    };
  }
  if (input.direction === "inbound") {
    return {
      ...base,
      sourceType: "ORGANIC",
      evidenceType: "customer_initiated",
      evidenceReference: null,
      ctwaClid: null,
    };
  }
  return {
    ...base,
    sourceType: "UNKNOWN",
    evidenceType: "none",
    evidenceReference: null,
    ctwaClid: null,
  };
}

/**
 * Returns explicit message origin or a direction-based fallback classification.
 *
 * @param message - Canonical message row, optionally carrying a precomputed `origin`.
 * @returns The message's `origin` when set; otherwise a fallback from direction and `providerTimestamp`.
 */
export function originOf(message: CanonicalMessage): OriginClassification {
  return (
    message.origin ??
    classifyConversationOrigin({
      payload: {},
      direction: message.direction,
      evidenceAt: message.providerTimestamp,
    })
  );
}

/**
 * Merges stored and incoming origin, preferring AD evidence over weaker signals.
 *
 * @param stored - Origin already persisted on the conversation, or null on first insert.
 * @param next - Origin derived from the incoming message.
 * @returns `stored` when it is AD; otherwise `next` when it is AD; otherwise `stored` when present, else `next`.
 */
export function mergeOrigin(
  stored: OriginClassification | null,
  next: OriginClassification,
): OriginClassification {
  if (!stored) {
    return next;
  }
  if (stored.sourceType === "AD") {
    return stored;
  }
  if (next.sourceType === "AD") {
    return next;
  }
  return stored;
}

/**
 * Formats origin classification for structured worker logs.
 *
 * @param origin - Classification to log.
 * @returns Single-line summary with source type, evidence type, and last four chars of reference when present.
 */
export function formatOriginLog(origin: OriginClassification) {
  const ref = origin.evidenceReference;
  const tail = ref ? ` ref …${ref.slice(-4)}` : "";
  return `conversation origin ${origin.sourceType} ${origin.evidenceType}${tail}`;
}

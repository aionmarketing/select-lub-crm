/**
 * Reading Evolution's wire format: provider timestamps, Baileys session states,
 * which JIDs are groups or broadcasts, and the two envelope fields every webhook
 * carries. Pure; no database, no clock.
 *
 * Channel owns Evolution, so channel owns how its payloads are read; the
 * `conversations` module's parsers import these rather than keep copies. Before
 * 4A there were two copies of each — `apps/worker/src/ingest/parse.ts`, and
 * channel's `internal/evolution-values.ts`, `receive-webhook`'s envelope readers
 * and `backfill-history`'s JID filter — kept byte-identical by hand. They were
 * checked identical when joined here.
 */
import type { ConnectionState } from "./connections.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown) {
  return typeof value === "string" ? value : null;
}

/**
 * Parses Evolution unix seconds or milliseconds into a Date.
 *
 * @param value - Evolution timestamp as number or numeric string.
 * @returns Parsed `Date`, or null when the value is missing, non-numeric, or invalid.
 *   Never falls back to the wall clock.
 */
export function parseTimestamp(value: unknown): Date | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return parseTimestamp(numeric);
    }
  }
  return null;
}

/**
 * Maps Baileys session state strings to CRM connection state.
 *
 * @param raw - Evolution `data.state` string (`open`, `connecting`, `close`).
 * @returns Mapped {@link ConnectionState}, or null for unknown values (including
 *   `DEGRADED`, which has no confirmed trigger); callers treat null as "unknown —
 *   leave the stored state alone".
 */
export function mapEvolutionSessionState(raw: string | null): ConnectionState | null {
  if (raw === "open") {
    return "CONNECTED";
  }
  if (raw === "connecting") {
    return "CONNECTING";
  }
  if (raw === "close") {
    return "DISCONNECTED";
  }
  return null;
}

/**
 * Returns true for group and broadcast JIDs that ingest skips.
 *
 * `@lid` used to be listed here. It is not a group address — it is how WhatsApp
 * addresses an ordinary 1:1 chat without exposing a phone number — and skipping
 * it here dropped 30 of 32 real one-to-one chats measured against the live
 * instance, on the webhook path as well as the history import. A LID-addressed
 * event is resolved through `resolvePhoneJid` (conversations' parser), which
 * finds the phone on the alternate JID the provider sends beside it, and only an
 * event with no phone anywhere is skipped.
 *
 * `@newsletter` is listed because a real import turned two WhatsApp newsletters
 * into customer conversations: a newsletter is a broadcast channel, and its
 * 18-digit channel id passed every check that asked only for digits.
 *
 * @param remoteJid - WhatsApp remote JID from the message key.
 * @returns True for `@g.us`, `@broadcast`, `status@broadcast`, and `@newsletter` addresses.
 */
export function isGroupOrBroadcastJid(remoteJid: string) {
  return (
    remoteJid.includes("@g.us") ||
    remoteJid.includes("@broadcast") ||
    remoteJid === "status@broadcast" ||
    remoteJid.includes("@newsletter")
  );
}

/**
 * Reads the Evolution instance name from a webhook envelope.
 *
 * @param payload - Unparsed Evolution webhook JSON body.
 * @returns Instance name string, or null when missing or not a string.
 */
export function envelopeInstance(payload: unknown) {
  return readString(asRecord(payload)?.instance);
}

/**
 * Reads the provider message id from a webhook envelope data block.
 *
 * @param payload - Unparsed Evolution webhook JSON body.
 * @returns External message id from `data.key.id`, `keyId`, or `id` (of `data`, or
 *   of `data[0]`); null when none are present.
 */
export function envelopeExternalId(payload: unknown) {
  const data = asRecord(payload)?.data;
  const record = Array.isArray(data) ? asRecord(data[0]) : asRecord(data);
  return (
    readString(asRecord(record?.key)?.id) ??
    readString(record?.keyId) ??
    readString(record?.id)
  );
}

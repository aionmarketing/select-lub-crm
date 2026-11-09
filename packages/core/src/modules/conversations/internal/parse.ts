/**
 * Evolution webhook and history payload parsing into canonical messages and status updates.
 *
 * Moved from `apps/worker/src/ingest/parse.ts` (4A). Pure. The five readers of
 * Evolution's wire format it used to hold — `parseTimestamp`,
 * `mapEvolutionSessionState`, `isGroupOrBroadcastJid`, `envelopeInstance`,
 * `envelopeExternalId` — are channel's `contracts/evolution-format.ts` now, which
 * held byte-identical copies; they are re-exported here so this module's callers
 * and tests read them from one place.
 */
import {
  envelopeExternalId,
  envelopeInstance,
  isGroupOrBroadcastJid,
  mapEvolutionSessionState,
  parseTimestamp,
  type ConnectionState,
} from "../../channel/contracts/index.js";
import { conversationChatKeyFromJid } from "../contracts/http.js";
import type { CanonicalMessage, ProviderStatus } from "./canonical-message.js";
import { classifyConversationOrigin } from "./origin.js";

export { envelopeExternalId, envelopeInstance, isGroupOrBroadcastJid, mapEvolutionSessionState, parseTimestamp };

const CANONICAL_EVENTS = new Set([
  "messages.upsert",
  "MESSAGES_UPSERT",
  "send.message",
  "SEND_MESSAGE",
]);

const STATUS_UPDATE_EVENTS = new Set([
  "messages.update",
  "MESSAGES_UPDATE",
  "send.message.update",
  "SEND_MESSAGE_UPDATE",
]);

const CONTENT_UNAVAILABLE_EVENTS = new Set(["messages.delete", "MESSAGES_DELETE"]);

const ACK_BY_NAME: Record<string, ProviderStatus> = {
  SERVER_ACK: "sent",
  PENDING: "sent",
  SENT: "sent",
  DELIVERY_ACK: "delivered",
  DELIVERED: "delivered",
  READ: "read",
  PLAYED: "read",
  ERROR: "failed",
  FAILED: "failed",
};

const ACK_BY_NUMBER: Record<number, ProviderStatus> = {
  0: "failed",
  1: "sent",
  2: "sent",
  3: "delivered",
  4: "read",
  5: "read",
};

/** Result of parsing a webhook envelope into insert, skip, or side-effect actions. */
export type ParseCanonicalResult =
  | { status: "skip" }
  | { status: "insert"; message: CanonicalMessage }
  | {
      status: "status-update";
      externalMessageId: string;
      providerStatus: ProviderStatus | null;
      at: Date | null;
    }
  | { status: "content-unavailable"; externalMessageId: string };

/**
 * Maps Evolution ack strings or numeric codes to CRM provider status.
 *
 * @param value - Evolution ack field (`status` or `ack`) as string or number.
 * @returns Mapped `ProviderStatus`, or null when the value is unrecognized.
 */
export function mapEvolutionAck(value: unknown): ProviderStatus | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return ACK_BY_NUMBER[value] ?? null;
  }
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  const trimmed = value.trim();
  const numeric = Number(trimmed);
  if (trimmed !== "" && Number.isFinite(numeric) && ACK_BY_NUMBER[numeric]) {
    return ACK_BY_NUMBER[numeric] ?? null;
  }
  return ACK_BY_NAME[trimmed.toUpperCase()] ?? null;
}

const CONNECTION_UPDATE_EVENTS = new Set(["connection.update", "CONNECTION_UPDATE"]);
const QRCODE_UPDATED_EVENTS = new Set(["qrcode.updated", "QRCODE_UPDATED"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function mediaCaption(record: Record<string, unknown>) {
  const caption = readString(record.caption);
  if (caption && caption.trim() !== "") {
    return caption;
  }
  const title = readString(record.title);
  if (title && title.trim() !== "") {
    return title;
  }
  return null;
}

function messageTypeAndText(message: Record<string, unknown> | null) {
  if (!message) {
    return { messageType: "unknown" as const, textBody: null };
  }
  if (typeof message.conversation === "string") {
    return { messageType: "text" as const, textBody: message.conversation };
  }
  const extended = asRecord(message.extendedTextMessage);
  if (extended && typeof extended.text === "string") {
    return { messageType: "text" as const, textBody: extended.text };
  }
  const image = asRecord(message.imageMessage);
  if (image) {
    return { messageType: "image" as const, textBody: mediaCaption(image) };
  }
  if (asRecord(message.audioMessage)) {
    return { messageType: "audio" as const, textBody: null };
  }
  const document = asRecord(message.documentMessage);
  if (document) {
    return { messageType: "document" as const, textBody: mediaCaption(document) };
  }
  const video = asRecord(message.videoMessage);
  if (video) {
    return { messageType: "video" as const, textBody: mediaCaption(video) };
  }
  return { messageType: "unknown" as const, textBody: null };
}

/**
 * The phone-bearing JID for an event, or null when it has none.
 *
 * WhatsApp addresses a 1:1 chat either by phone (`5511999999999@s.whatsapp.net`)
 * or by linked identity (`123456789012345@lid`), and a LID JID carries no phone.
 * When it addresses by LID the provider sends the phone JID alongside, as
 * `key.remoteJidAlt`; this returns that instead.
 *
 * Both candidates go through {@link conversationChatKeyFromJid} unchanged, so
 * "is this a phone JID" has exactly one definition in the system. That is also
 * what makes a bad alternate safe: a value that is not a phone JID yields no
 * key, so the event is skipped rather than opening a conversation keyed to the
 * wrong number — which would be worse than dropping it.
 *
 * Deliberately keyed off the content rather than off `key.addressingMode`. The
 * mode is a provider label whose vocabulary can grow, and a new value would
 * reintroduce this defect in exactly the invisible way it appeared the first
 * time.
 *
 * @param remoteJid - The event's own remote JID.
 * @param remoteJidAlt - The alternate JID beside it, when the provider sent one.
 * @returns Whichever JID yields a chat key, preferring the event's own; null when neither does.
 */
export function resolvePhoneJid(remoteJid: string, remoteJidAlt: string | null): string | null {
  if (conversationChatKeyFromJid(remoteJid)) {
    return remoteJid;
  }
  if (remoteJidAlt && conversationChatKeyFromJid(remoteJidAlt)) {
    return remoteJidAlt;
  }
  return null;
}

function parseMessageRecord(
  data: Record<string, unknown> | null,
  connectionId: string,
): { status: "skip" } | { status: "insert"; message: CanonicalMessage } {
  if (!data) {
    return { status: "skip" };
  }
  const key = asRecord(data.key);
  const externalMessageId = readString(key?.id);
  const remoteJid = readString(key?.remoteJid);
  if (!externalMessageId || !remoteJid) {
    return { status: "skip" };
  }
  if (isGroupOrBroadcastJid(remoteJid)) {
    return { status: "skip" };
  }
  // The address this conversation is keyed and replied to by. For a LID-addressed
  // event that is the alternate, not the `@lid` JID: `remoteJid` is stored as the
  // send address, and a LID JID cannot be sent to — storing it would leave a
  // normal-looking conversation whose next reply fails.
  const addressJid = resolvePhoneJid(remoteJid, readString(key?.remoteJidAlt));
  if (!addressJid) {
    return { status: "skip" };
  }
  const chatKey = conversationChatKeyFromJid(addressJid);
  if (!chatKey) {
    return { status: "skip" };
  }
  const providerTimestamp = parseTimestamp(data.messageTimestamp);
  if (!providerTimestamp) {
    return { status: "skip" };
  }
  const fromMe = key?.fromMe === true;
  const direction = fromMe ? "outbound" : "inbound";
  const { messageType, textBody } = messageTypeAndText(asRecord(data.message));
  return {
    status: "insert",
    message: {
      whatsappConnectionId: connectionId,
      remoteJid: addressJid,
      chatKey,
      externalMessageId,
      direction,
      messageType,
      textBody,
      providerTimestamp,
      origin: classifyConversationOrigin({
        payload: data,
        direction,
        evidenceAt: providerTimestamp,
      }),
    },
  };
}

/**
 * Parses a findMessages REST row into a canonical message insert.
 *
 * @param row - Single message record from Evolution `findMessages`.
 * @param connectionId - CRM WhatsApp connection id to attach to the canonical message.
 * @returns `{ status: "insert", message }` when parseable; `{ status: "skip" }` when `connectionId` is empty or the row is invalid.
 */
export function parseHistoryMessage(
  row: unknown,
  connectionId: string,
): { status: "skip" } | { status: "insert"; message: CanonicalMessage } {
  if (!connectionId) {
    return { status: "skip" };
  }
  return parseMessageRecord(asRecord(row), connectionId);
}

/**
 * Parses a live webhook envelope into message insert, status update, or skip.
 *
 * @param payload - Unparsed Evolution webhook JSON body.
 * @param connectionId - CRM connection id from instance lookup; null skips message events.
 * @returns Parse result: insert, status update, content-unavailable, or skip.
 */
export function parseCanonicalMessage(
  payload: unknown,
  connectionId: string | null,
): ParseCanonicalResult {
  const envelope = asRecord(payload);
  if (!envelope) {
    return { status: "skip" };
  }
  const event = readString(envelope.event);
  if (!event) {
    return { status: "skip" };
  }
  if (!connectionId) {
    return { status: "skip" };
  }
  const data = Array.isArray(envelope.data) ? asRecord(envelope.data[0]) : asRecord(envelope.data);
  if (STATUS_UPDATE_EVENTS.has(event)) {
    return parseStatusUpdate(data);
  }
  if (CONTENT_UNAVAILABLE_EVENTS.has(event)) {
    return parseContentUnavailable(data);
  }
  if (!CANONICAL_EVENTS.has(event)) {
    return { status: "skip" };
  }
  return parseMessageRecord(data, connectionId);
}

function readExternalId(data: Record<string, unknown> | null) {
  if (!data) {
    return null;
  }
  return readString(asRecord(data.key)?.id) ?? readString(data.keyId) ?? readString(data.id);
}

function readRemoteJid(data: Record<string, unknown> | null) {
  if (!data) {
    return null;
  }
  return readString(asRecord(data.key)?.remoteJid) ?? readString(data.remoteJid);
}

function readRemoteJidAlt(data: Record<string, unknown> | null) {
  if (!data) {
    return null;
  }
  return readString(asRecord(data.key)?.remoteJidAlt) ?? readString(data.remoteJidAlt);
}

function readAckValue(data: Record<string, unknown>) {
  const update = asRecord(data.update);
  if (update && (update.status !== undefined || update.ack !== undefined)) {
    return update.status ?? update.ack;
  }
  return data.status ?? data.ack;
}

function parseStatusUpdate(
  data: Record<string, unknown> | null,
): ParseCanonicalResult {
  const externalMessageId = readExternalId(data);
  const remoteJid = readRemoteJid(data);
  if (!externalMessageId || !remoteJid || isGroupOrBroadcastJid(remoteJid)) {
    return { status: "skip" };
  }
  // Same resolution as the insert path: a status update on a LID-addressed chat
  // names a message that now exists, so skipping it here would freeze those
  // conversations at their first recorded status.
  if (!resolvePhoneJid(remoteJid, readRemoteJidAlt(data))) {
    return { status: "skip" };
  }
  const at =
    parseTimestamp(data?.messageTimestamp) ??
    parseTimestamp(asRecord(data?.update)?.messageTimestamp) ??
    null;
  return {
    status: "status-update",
    externalMessageId,
    providerStatus: data ? mapEvolutionAck(readAckValue(data)) : null,
    at,
  };
}

function parseContentUnavailable(
  data: Record<string, unknown> | null,
): ParseCanonicalResult {
  const externalMessageId = readExternalId(data);
  const remoteJid = readRemoteJid(data);
  if (!externalMessageId || !remoteJid || isGroupOrBroadcastJid(remoteJid)) {
    return { status: "skip" };
  }
  if (!resolvePhoneJid(remoteJid, readRemoteJidAlt(data))) {
    return { status: "skip" };
  }
  return { status: "content-unavailable", externalMessageId };
}

/**
 * Parses Evolution connection lifecycle webhooks into CRM connection state updates.
 *
 * Evolution `CONNECTION_UPDATE` reports Baileys' own `state` string
 * (`open` / `connecting` / `close`) in `data.state`. `QRCODE_UPDATED`
 * carries no session state of its own: a QR is only issued before the
 * instance has finished pairing, so it always maps to `CONNECTING`
 * regardless of its payload shape (and this parser never reads the QR
 * image/pairing-code fields, so they cannot leak into the connection row).
 * `DEGRADED` has no confirmed trigger in the payloads observed so far
 * (see design.md "DEGRADED rarely emitted"); this parser does not invent
 * one, so it is never produced here.
 *
 * @param payload - Unparsed Evolution webhook JSON body.
 * @returns `{ status: "update", state }` for recognized connection events; `{ status: "skip" }` otherwise.
 */
export function parseConnectionEvent(
  payload: unknown,
): { status: "skip" } | { status: "update"; state: ConnectionState } {
  const envelope = asRecord(payload);
  if (!envelope) {
    return { status: "skip" };
  }
  const event = readString(envelope.event);
  if (!event) {
    return { status: "skip" };
  }
  if (QRCODE_UPDATED_EVENTS.has(event)) {
    return { status: "update", state: "CONNECTING" };
  }
  if (!CONNECTION_UPDATE_EVENTS.has(event)) {
    return { status: "skip" };
  }
  const data = Array.isArray(envelope.data) ? asRecord(envelope.data[0]) : asRecord(envelope.data);
  const mapped = mapEvolutionSessionState(readString(data?.state));
  if (!mapped) {
    return { status: "skip" };
  }
  return { status: "update", state: mapped };
}

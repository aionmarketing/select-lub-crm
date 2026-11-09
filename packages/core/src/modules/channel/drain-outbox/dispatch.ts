/**
 * Routes one claimed outbox row to the Evolution send that matches its type.
 *
 * Moved unchanged from `apps/worker/src/outbox/drain.ts`. It only chooses the
 * call and builds its payload; it never touches the database, so the drain can
 * await it outside any transaction (W2-C12).
 */
import type { EvolutionSend, EvolutionSendResult } from "../internal/ports.js";
import type { ClaimedOutbox } from "./queries.js";

function mediaBase64(bytes: Uint8Array | null) {
  if (!bytes || bytes.byteLength === 0) {
    return null;
  }
  return Buffer.from(bytes).toString("base64");
}

/**
 * Sends one claimed row through Evolution, or refuses it without calling out.
 *
 * @param evolution - The Evolution send port.
 * @param claimed - The claimed row with its routing fields.
 * @returns Evolution's result, or a non-disconnect refusal for a row that cannot
 *   be sent (no text, no media bytes, or a type the drain does not know).
 */
export function dispatchSend(evolution: EvolutionSend, claimed: ClaimedOutbox): Promise<EvolutionSendResult> {
  if (claimed.messageType === "text") {
    // Refused rather than sent blank, matching the media branch below that
    // refuses a row with no bytes. Whitespace-only counts as empty, as it already
    // does for a media caption. The HTTP route validates `trim().min(1)`, so this
    // is defensive — but "send an empty WhatsApp message" is the wrong thing for
    // it to do, and the refusal is only safe now that a refused row reaches a
    // terminal `failed` instead of being retried forever ahead of every other row.
    const text = claimed.textBody?.trim() ? claimed.textBody : null;
    if (text === null) {
      return Promise.resolve({ ok: false, kind: "refused", error: "missing text body" });
    }
    return evolution.sendText({
      instanceName: claimed.instanceName,
      number: claimed.customerPhoneNormalized,
      text,
    });
  }
  const media = mediaBase64(claimed.mediaBytes);
  if (!media) {
    return Promise.resolve({ ok: false, kind: "refused", error: "missing media bytes" });
  }
  if (claimed.messageType === "audio") {
    return evolution.sendWhatsAppAudio({
      instanceName: claimed.instanceName,
      number: claimed.customerPhoneNormalized,
      audio: media,
    });
  }
  if (claimed.messageType === "image" || claimed.messageType === "video" || claimed.messageType === "document") {
    const caption = claimed.textBody?.trim() ? claimed.textBody : undefined;
    return evolution.sendMedia({
      instanceName: claimed.instanceName,
      number: claimed.customerPhoneNormalized,
      mediatype: claimed.messageType,
      media,
      ...(claimed.mediaMimeType ? { mimetype: claimed.mediaMimeType } : {}),
      ...(claimed.mediaFileName
        ? { fileName: claimed.mediaFileName }
        : claimed.messageType === "document"
          ? { fileName: "file" }
          : {}),
      ...(caption ? { caption } : {}),
    });
  }
  return Promise.resolve({ ok: false, kind: "refused", error: "unsupported message type" });
}

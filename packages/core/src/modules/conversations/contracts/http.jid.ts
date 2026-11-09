/**
 * Helpers for normalizing WhatsApp JIDs into CRM conversation chat keys.
 *
 * Moved from `packages/shared-types/src/jid.ts` (5.1d) with declarations unchanged.
 */

/** Shortest and longest digit counts E.164 allows for a subscriber number including country code. */
const MIN_PHONE_DIGITS = 8;

const MAX_PHONE_DIGITS = 15;

/**
 * Builds the 1:1 inbox chat key from a WhatsApp JID: digits of the local part before `:` or `@`.
 *
 * Group `@g.us` keys are reserved for a later capability and are not produced here.
 *
 * Two rejections come from what a real import actually contained, not from
 * theory. `@newsletter` is a broadcast channel, and it was passing every earlier
 * check — its 18-digit channel id looks like "digits" — so two WhatsApp
 * newsletters became customer conversations that the demo seed then decorated
 * with names and vehicles. And `0@s.whatsapp.net`, WhatsApp's own system
 * address, produced a conversation keyed `0`.
 *
 * Hence the length bound: a chat key is a phone number, and E.164 allows 8 to 15
 * digits including the country code. A digit run outside that range is not a
 * number anyone can be called back on, so it is refused rather than stored — a
 * conversation keyed to something that is not a phone is worse than no
 * conversation, because everything downstream treats that key as one.
 *
 * @param remoteJid - Full JID as Evolution sends it (e.g. `5511999999999:12@s.whatsapp.net`).
 * @returns Digit-only chat key for a 1:1 phone, or `null` when the JID is a group, broadcast, newsletter, `@lid`, or its local part holds no plausible phone.
 */
export function conversationChatKeyFromJid(remoteJid: string): string | null {
  const at = remoteJid.indexOf("@");
  const host = at === -1 ? "" : remoteJid.slice(at + 1).toLowerCase();
  if (host === "g.us" || host === "broadcast" || host === "lid" || host === "newsletter") {
    return null;
  }
  const local = at === -1 ? remoteJid : remoteJid.slice(0, at);
  const colon = local.indexOf(":");
  const beforeDevice = colon === -1 ? local : local.slice(0, colon);
  const digits = beforeDevice.replace(/\D/g, "");
  if (digits.length < MIN_PHONE_DIGITS || digits.length > MAX_PHONE_DIGITS) {
    return null;
  }
  return digits;
}

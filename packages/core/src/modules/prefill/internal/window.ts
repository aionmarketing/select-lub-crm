/**
 * Derives the 60-second sliding prefill / shouldReply window from stored messages.
 */
export const PREFILL_WINDOW_MS = 60_000;

/** Message facts the derived window reads. */
export type WindowMessage = {
  id: string;
  direction: "inbound" | "outbound";
  messageType: string;
  textBody: string | null;
  providerTimestamp: Date;
};

/** A silence-closed window ready for one extraction call. */
export type ClosedWindow = {
  conversationId: string;
  inboundIds: string[];
  latestInboundAt: Date;
};

function isInboundText(message: WindowMessage) {
  return (
    message.direction === "inbound" &&
    message.messageType === "text" &&
    (message.textBody?.trim() ?? "") !== ""
  );
}

function byProviderTime(a: WindowMessage, b: WindowMessage) {
  return a.providerTimestamp.getTime() - b.providerTimestamp.getTime();
}

/**
 * Returns the silence-closed window for a conversation, or null when none is ready.
 *
 * A window is the latest live inbound text with no later outbound, age ≥ 60s,
 * and newer than `watermark`. Inbound ids are the inbound texts after the last
 * outbound before that latest inbound, through the latest inbound.
 *
 * @param conversationId - Conversation the messages belong to.
 * @param messages - Thread messages in any order.
 * @param watermark - `lastPrefillWindowClosedAt`; null means never extracted.
 * @param now - Clock used to measure silence age.
 * @returns The closed window, or `null` when still open, closed early, or already extracted.
 */
export function closedWindowForConversation(
  conversationId: string,
  messages: readonly WindowMessage[],
  watermark: Date | null,
  now: Date,
): ClosedWindow | null {
  const sorted = [...messages].sort(byProviderTime);
  const latestInbound = [...sorted].reverse().find(isInboundText);
  if (!latestInbound) {
    return null;
  }
  const latestAt = latestInbound.providerTimestamp.getTime();
  const laterOutbound = sorted.some(
    (message) => message.direction === "outbound" && message.providerTimestamp.getTime() > latestAt,
  );
  if (laterOutbound) {
    return null;
  }
  if (now.getTime() - latestAt < PREFILL_WINDOW_MS) {
    return null;
  }
  if (watermark && latestAt <= watermark.getTime()) {
    return null;
  }
  return {
    conversationId,
    inboundIds: windowInboundIds(sorted, latestInbound.providerTimestamp),
    latestInboundAt: latestInbound.providerTimestamp,
  };
}

/**
 * The inbound text ids of the window whose latest inbound is at
 * `latestInboundAt`: those after the last outbound before it, through it.
 *
 * Also used by a prefill retry (owner rulings, 2026-09-25) to label the failed
 * window's inbounds, whatever has arrived since.
 *
 * @param messages - Thread messages in any order.
 * @param latestInboundAt - The window's latest inbound time.
 * @returns The ids, in provider-time order.
 */
export function windowInboundIds(messages: readonly WindowMessage[], latestInboundAt: Date): string[] {
  const sorted = [...messages].sort(byProviderTime);
  const latestAt = latestInboundAt.getTime();
  const lastOutboundBefore = [...sorted]
    .reverse()
    .find(
      (message) =>
        message.direction === "outbound" && message.providerTimestamp.getTime() < latestAt,
    );
  const afterOutboundAt = lastOutboundBefore?.providerTimestamp.getTime() ?? Number.NEGATIVE_INFINITY;
  return sorted
    .filter(
      (message) =>
        isInboundText(message) &&
        message.providerTimestamp.getTime() > afterOutboundAt &&
        message.providerTimestamp.getTime() <= latestAt,
    )
    .map((message) => message.id);
}

/**
 * Shared shouldReply unanswered rule used by the Conversas list and REP-03.
 *
 * Moved from `packages/shared-types/src/should-reply.ts` (5.1d) with declarations unchanged.
 */

/** One message fact the unanswered rule reads. */
export type ShouldReplyMessage = {
  direction: string;
  providerTimestamp: Date;
  shouldReply?: boolean | null;
};

function sortedByProviderTime(messages: readonly ShouldReplyMessage[]) {
  return [...messages].sort(
    (a, b) => a.providerTimestamp.getTime() - b.providerTimestamp.getTime(),
  );
}

/**
 * True when at least one inbound labeled `shouldReply: true` has no outbound after it.
 *
 * Unlabeled (`null`/`undefined`) and `false` inbounds never make a conversation unanswered.
 *
 * @param messages - Thread messages in any order; compared by `providerTimestamp`.
 * @returns Whether the conversation matches the shouldReply unanswered rule.
 */
export function hasPendingShouldReply(messages: readonly ShouldReplyMessage[]): boolean {
  return oldestPendingShouldReplyAt(messages) !== null;
}

/**
 * Provider time of the oldest inbound still waiting on a reply under the shouldReply rule.
 *
 * @param messages - Thread messages in any order.
 * @returns The oldest pending `shouldReply: true` inbound's timestamp, or `null` when none is pending.
 */
export function oldestPendingShouldReplyAt(messages: readonly ShouldReplyMessage[]): Date | null {
  const sorted = sortedByProviderTime(messages);
  for (let index = 0; index < sorted.length; index += 1) {
    const message = sorted[index];
    if (!message || message.direction !== "inbound" || message.shouldReply !== true) {
      continue;
    }
    const laterOutbound = sorted
      .slice(index + 1)
      .some((later) => later.direction === "outbound");
    if (!laterOutbound) {
      return message.providerTimestamp;
    }
  }
  return null;
}

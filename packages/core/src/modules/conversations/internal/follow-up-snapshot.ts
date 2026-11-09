/**
 * The Follow-up read: loads one loja's snapshot and hands it to the pure
 * aggregation in `follow-up-aggregate.ts`.
 *
 * Moved from `apps/api/src/follow-up/prisma.ts` (4A) with the queries
 * unchanged. The store port is gone: `followUpSummary` and `followUpCounts`
 * are what the list and count slices call. Each read runs in its own
 * `db.tx("conversations", …)`, the four independent ones side by side.
 * `oil_quote`, `vehicle_return`, `customer` and `scheduled_message` are other
 * modules' tables, read under `module_conversations` (every table is
 * `readableBy "*"`).
 */
import type { FollowUpOptionalCounts, FollowUpResult } from "../contracts/http.js";
import type { Db } from "../../../kernel/db.js";
import { buildFollowUp, type FollowUpSnapshot, type FollowUpView } from "./follow-up-aggregate.js";
import { listClosedFollowUpEntries } from "./follow-up-closed.js";

/**
 * The four sections of one loja: the queue, or (`view: "closed"`) the entries
 * closed out of it — the complement, from the same predicate.
 *
 * @param db - The database handle.
 * @param unitId - The loja.
 * @param view - `"open"` for the queue, `"closed"` for the closed-entries view.
 * @returns Lists plus counts that equal the listed lengths after the cap.
 */
export async function followUpSummary(db: Db, unitId: string, view: FollowUpView = "open"): Promise<FollowUpResult> {
  const snapshot = await loadFollowUpSnapshot(db, unitId, view);
  return buildFollowUp(snapshot, unitId, new Date(), view);
}

/**
 * The four counts alone, for the navigation badge and the Relatórios alert strip.
 *
 * Derived from the SAME aggregation the lists come from, deliberately: counting
 * through separate queries would be cheaper and would let the badge drift from
 * the screen it points at.
 *
 * @param db - The database handle.
 * @param unitId - The loja.
 * @returns Each section's count, equal to the length its list would have.
 */
export async function followUpCounts(db: Db, unitId: string): Promise<FollowUpOptionalCounts> {
  return (await followUpSummary(db, unitId)).counts;
}

/**
 * Loads the unit-scoped snapshot the aggregator needs.
 *
 * @param db - The database handle.
 * @param unitId - Loja used on conversation connections and service rows.
 * @param view - `"open"` loads OPEN returns for the queue; `"closed"` loads the
 *   ARCHIVED ones the closed-entries view lists. The closed set of the two
 *   message-pendency sections is loaded either way — the queue subtracts it and
 *   the closed view selects by it.
 * @returns Quotes, inbounds, outbounds, returns, conversations and closed rows.
 */
async function loadFollowUpSnapshot(
  db: Db,
  unitId: string,
  view: FollowUpView,
): Promise<FollowUpSnapshot> {
  const now = new Date();
  const [quotes, returns, conversations, closedRows] = await Promise.all([
    db.tx("conversations", (tx) =>
      tx.oilQuote.findMany({
        where: { conversation: { whatsappConnection: { unitId } } },
        include: { conversation: true, customer: true } }),
    ),
    // Status filtered here rather than in the aggregator, so "a row that should
    // not be listed was never loaded" stays true. SUPERSEDED is in neither
    // view: a newer service replaced it, which is history rather than a queue
    // entry anyone can restore.
    db.tx("conversations", (tx) => tx.vehicleReturn.findMany({
      where: { status: view === "closed" ? "ARCHIVED" : "OPEN", sourceService: { unitId } },
      include: {
        vehicle: { include: { customer: true } },
        reminderMessages: {
          where: { cancelledAt: null },
          include: {
            scheduledMessages: {
              where: { status: { in: ["SCHEDULED", "SENT"] } },
              select: { scheduledAt: true, sentAt: true, status: true, frozenText: true },
              orderBy: { scheduledAt: "asc" } } } } } })),
    db.tx("conversations", (tx) =>
      tx.conversation.findMany({
        where: { whatsappConnection: { unitId } },
        include: {
          messages: { select: { direction: true, providerTimestamp: true, shouldReply: true } } } }),
    ),
    listClosedFollowUpEntries(db, unitId),
  ]);

  const conversationIds = [
    ...new Set(quotes.map((quote) => quote.conversationId).filter((id): id is string => id != null)),
  ];
  const inbounds =
    conversationIds.length === 0
      ? []
      : await db.tx("conversations", (tx) =>
          tx.message.findMany({
            where: { conversationId: { in: conversationIds }, direction: "inbound" },
            select: { conversationId: true, providerTimestamp: true } }),
        );

  // `Customer.name` is nullable — a pré-cadastro contact is phone-only until
  // someone names it. Both readers below already fall back, so the map carries
  // the column as it is rather than claiming a name always exists.
  const customerById = new Map<string, { name: string | null }>();
  for (const quote of quotes) {
    customerById.set(quote.customer.id, quote.customer);
  }
  const orphanCustomerIds = [
    ...new Set(
      conversations
        .map((conversation) => conversation.customerId)
        .filter((id): id is string => id != null && !customerById.has(id)),
    ),
  ];
  if (orphanCustomerIds.length > 0) {
    const extra = await db.tx("conversations", (tx) =>
      tx.customer.findMany({
        where: { id: { in: orphanCustomerIds } },
        select: { id: true, name: true } }),
    );
    for (const customer of extra) {
      customerById.set(customer.id, customer);
    }
  }

  const conversationOfCustomer = (customerId: string) =>
    conversations.find((conversation) => conversation.customerId === customerId)?.id ?? null;

  // Outbound bodies are loaded only for the threads something links INTO — the
  // quote conversations and the return conversations. Selecting every thread's
  // message bodies to find two of them would be the whole inbox on every read.
  const linkConversationIds = [
    ...new Set([
      ...conversationIds,
      ...returns
        .map((row) => conversationOfCustomer(row.vehicle.customerId))
        .filter((id): id is string => id != null),
    ]),
  ];
  const outbounds =
    linkConversationIds.length === 0
      ? []
      : await db.tx("conversations", (tx) => tx.message.findMany({
          where: { conversationId: { in: linkConversationIds }, direction: "outbound" },
          select: {
            id: true,
            conversationId: true,
            textBody: true,
            providerTimestamp: true } }));

  return {
    quotes: quotes.map((quote) => ({
      quoteId: quote.id,
      conversationId: quote.conversationId,
      unitId,
      createdAt: quote.createdAt,
      label: quote.customer.name ?? "",
      text: quote.generatedMessageText })),
    inbounds: inbounds.map((inbound) => ({
      conversationId: inbound.conversationId,
      providerTimestamp: inbound.providerTimestamp })),
    outbounds: outbounds.map((message) => ({
      conversationId: message.conversationId,
      messageId: message.id,
      textBody: message.textBody,
      providerTimestamp: message.providerTimestamp })),
    openReturns: returns.map((row) => {
      const moments = row.reminderMessages.flatMap((message) => message.scheduledMessages);
      // Un-sent means still to go out: a SCHEDULED row whose moment has not
      // passed. One whose instant is behind us will never fire, so counting it
      // would promise the customer a message nobody will send.
      const pending = moments
        .filter((moment) => moment.status === "SCHEDULED" && moment.scheduledAt > now)
        .map((moment) => moment.scheduledAt)
        .sort((a, b) => a.getTime() - b.getTime());
      const conversationId = conversationOfCustomer(row.vehicle.customerId);
      // The most recent reminder that actually went out, matched to its thread
      // message by the text it froze. `ScheduledMessage` has no foreign key to
      // `Message` — the row is written before the message exists.
      const lastSent = moments
        .filter((moment) => moment.status === "SENT" && moment.sentAt != null)
        .sort((a, b) => (b.sentAt as Date).getTime() - (a.sentAt as Date).getTime())[0];
      const sentMessage = lastSent
        ? outbounds.find(
            (message) =>
              message.conversationId === conversationId && message.textBody === lastSent.frozenText,
          )
        : undefined;
      return {
        returnId: row.id,
        vehicleId: row.vehicleId,
        plate: row.vehicle.plate,
        model: row.vehicle.model,
        customerId: row.vehicle.customerId,
        customerName: row.vehicle.customer.name ?? "",
        conversationId,
        sourceServiceId: row.sourceServiceId,
        // Stored as a DATE column, so the instant is midnight UTC of that day;
        // slicing the ISO string is the day itself, with no zone conversion to
        // shift it across a boundary.
        returnDate: row.returnDate.toISOString().slice(0, 10),
        plannedReminderCount: pending.length,
        nextReminderAt: pending[0]?.toISOString() ?? null,
        ...(sentMessage ? { sentReminderMessageId: sentMessage.id } : {}),
        ...(row.archivedAt && row.archivedByUserId
          ? { closed: { at: row.archivedAt.toISOString(), byUserId: row.archivedByUserId } }
          : {}) };
    }),
    conversations: conversations.map((conversation) => ({
      conversationId: conversation.id,
      unitId,
      label:
        (conversation.customerId && customerById.get(conversation.customerId)?.name) ||
        conversation.remoteJid,
      customerId: conversation.customerId,
      lastMessageAt: conversation.lastMessageAt,
      messages: conversation.messages })),
    closedEntries: closedRows.map((row) => ({
      section: row.section,
      conversationId: row.conversationId,
      anchor: row.anchor,
      closedAt: row.closedAt,
      closedByUserId: row.closedByUserId })) };
}

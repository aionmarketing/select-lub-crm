/**
 * Closing and reopening a Follow-up entry in the two message-pendency sections.
 *
 * Only **Orçamentos sem resposta** and **Mensagens aguardando resposta** live
 * here. A return section closes through the return itself
 * (the `services` module's `contracts/archive-vehicle-return.ts`), because its subject is a customer and a
 * vehicle rather than a conversation, and there is already a row to say so on.
 *
 * A closed row records the **anchor** that made the entry qualify, which is
 * what makes "returns on a newer trigger" work with no scheduled job and no
 * expiry column: the read compares each qualifying entry's current anchor
 * against the closed one, so a newer quote — a different anchor — simply stops
 * matching and the entry reappears. Nothing has to sweep the table.
 *
 * Suppression is per unit and per section, never per user: two attendants
 * working one loja's queue see the same closed set, because the alternative is
 * two people working the same row without knowing it (design D7).
 *
 * Moved from `packages/db/src/follow-up-closed-entries.ts` (4A) with the queries
 * unchanged; each now runs in `db.tx("conversations", …)`, since
 * `follow_up_closed_entry` is this module's table. The demo seed still writes the
 * model directly, as it writes every other.
 */
import type { Db } from "../../../kernel/db.js";

/** The two sections whose entries close through this table. */
export type ClosableFollowUpSection = "unansweredQuotes" | "waitingReply";

/** One closed entry, as the read path and the closed-entries view consume it. */
export type ClosedFollowUpEntry = {
  section: ClosableFollowUpSection;
  conversationId: string;
  /** The value that qualified the entry when it was closed. */
  anchor: string;
  closedAt: Date;
  closedByUserId: string;
};

/**
 * Closes one entry of one section, against the anchor that qualified it.
 *
 * Closing an already-closed entry is a no-op rather than an error: two
 * attendants can be looking at the same queue, and the second one clicking
 * Fechar means the same thing the first one meant.
 *
 * @param db - The database handle.
 * @param input.section - Which section the entry belongs to.
 * @param input.unitId - Loja the entry was listed under; the closed set is
 *   scoped by it.
 * @param input.conversationId - The entry's subject.
 * @param input.anchor - What made it qualify — the quote id, or the pending
 *   inbound instant. A newer one reopens the entry on its own.
 * @param input.userId - Who closed it.
 */
export async function closeFollowUpEntry(
  db: Db,
  input: {
    section: ClosableFollowUpSection;
    unitId: string;
    conversationId: string;
    anchor: string;
    userId: string;
  },
): Promise<void> {
  await db.tx("conversations", (tx) =>
    tx.followUpClosedEntry.upsert({
      where: {
        section_conversationId_anchor: {
          section: input.section,
          conversationId: input.conversationId,
          anchor: input.anchor,
        },
      },
      create: {
        section: input.section,
        unitId: input.unitId,
        conversationId: input.conversationId,
        anchor: input.anchor,
        closedByUserId: input.userId,
      },
      // Left as it was: who closed it first, and when, is the honest record.
      update: {},
    }),
  );
}

/**
 * Reopens a closed entry, putting it back in its section and its count.
 *
 * @param db - The database handle.
 * @param input.section - Which section the entry belongs to.
 * @param input.conversationId - The entry's subject.
 * @param input.anchor - The anchor it was closed against.
 * @returns Whether a closed row was actually removed. `false` means the entry
 *   was not closed — already reopened by someone else, or superseded by a newer
 *   anchor, both of which leave the entry listed, which is what the caller
 *   wanted anyway.
 */
export async function reopenFollowUpEntry(
  db: Db,
  input: { section: ClosableFollowUpSection; conversationId: string; anchor: string },
): Promise<boolean> {
  const { count } = await db.tx("conversations", (tx) =>
    tx.followUpClosedEntry.deleteMany({
      where: {
        section: input.section,
        conversationId: input.conversationId,
        anchor: input.anchor,
      },
    }),
  );
  return count > 0;
}

/**
 * Every closed entry of one loja, for the read path to subtract and for the
 * closed-entries view to list.
 *
 * Returns the whole loja's set rather than one section's: the Follow-up read
 * builds all four sections in one pass, so a per-section query would be two
 * round trips for the same rows.
 *
 * @param db - The database handle.
 * @param unitId - Loja whose closed set is loaded.
 * @returns The closed rows, newest first.
 */
export async function listClosedFollowUpEntries(db: Db, unitId: string): Promise<ClosedFollowUpEntry[]> {
  const rows = await db.tx("conversations", (tx) =>
    tx.followUpClosedEntry.findMany({
      where: { unitId },
      orderBy: { closedAt: "desc" },
    }),
  );
  return rows.map((row) => ({
    section: row.section as ClosableFollowUpSection,
    conversationId: row.conversationId,
    anchor: row.anchor,
    closedAt: row.closedAt,
    closedByUserId: row.closedByUserId,
  }));
}

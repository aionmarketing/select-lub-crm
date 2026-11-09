/**
 * Test design (testing-strategy)
 *
 * Setup: live Prisma against DATABASE_URL, skipped when unset. Every fixture id
 * carries the "fuclive" prefix and is deleted afterwards, so a run collides
 * neither with the seeded demo data nor with another run.
 *
 * Moved from `packages/db/src/follow-up-closed-entries.live.test.ts` (4A),
 * assertions unchanged; the three functions now take a `Db` and run under
 * `module_conversations`, so each call wraps the live client in `createDb`.
 *
 * SUT: closeFollowUpEntry / reopenFollowUpEntry / listClosedFollowUpEntries.
 * What can only be tested here is the half no fake observes: that the compound
 * unique (section, conversationId, anchor) really does make a second close an
 * upsert rather than a duplicate-key error, and that the anchor is part of the
 * key rather than decoration on it — a different anchor has to produce a SECOND
 * row, since that is the whole mechanism by which a closed entry comes back on
 * a newer quote. Which anchor VALUE each section stores is the read path's
 * decision and is tested there.
 *
 * Oracle: follow-up (align-shipped-ui-to-revised-canvas delta) — "a closed entry
 *   SHALL be absent from its section and from that section's count until the
 *   underlying condition changes — a newer quote, a newer service, or a newer
 *   pending inbound than the one that was closed — after which it returns as a
 *   new entry"; "closing SHALL be scoped to the entry and its section, not to
 *   the customer or conversation as a whole"; "the screen SHALL offer a way to
 *   see the entries currently closed in a section". Design D7: suppression is
 *   per unit and per section, not per user.
 *
 * Axes
 *   A1 close count on one (section, conversation, anchor) — first / repeated
 *   A2 anchor — the one closed against / a newer one
 *   A3 section — unansweredQuotes / waitingReply on the SAME conversation
 *   A4 reopen target — a row that exists / one that does not
 *   A5 unit — the fixture loja / a second loja
 *
 * Outputs
 *   O1 rows in follow_up_closed_entry for the conversation
 *   O2 the closer and the instant recorded on the row
 *   O3 listClosedFollowUpEntries contents, scoped by unit
 *   O4 reopenFollowUpEntry's boolean
 *
 * Sampled-cell
 *   first close             | A1 first       | O1 O2 | no row, or no actor recorded
 *   same close twice        | A1 repeated    | O1    | a unique-constraint error, or a duplicate row
 *   a newer anchor          | A2 newer       | O1    | the newer anchor reusing the old row
 *   both sections, one conv | A3 both        | O1 O3 | one section's close suppressing the other
 *   reopen an existing row  | A4 exists      | O1 O4 | the row surviving, or false reported
 *   reopen a missing row    | A4 missing     | O4    | a throw where a false is wanted
 *   another loja's rows     | A5 second loja | O3    | one loja seeing another's closed set
 *
 * Out of scope: which value each section uses as its anchor, and subtracting
 *   closed entries from the sections (both live in the API read path); closing a
 *   return entry (that is the return's own archive path).
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { shouldRunLiveTests } from "@select-lub/core/db";
import { createDb } from "../src/kernel/db.js";
import {
  closeFollowUpEntry,
  listClosedFollowUpEntries,
  reopenFollowUpEntry,
} from "../src/modules/conversations/internal/follow-up-closed.js";

const envPath = resolve(import.meta.dirname, "../../../.env");
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}
const hasDatabase = shouldRunLiveTests();
const P = "fuclive";
// User.id is a uuid, so it cannot carry the string prefix the other fixtures
// use; cleanup deletes it by this exact id instead.
const USER_ID = "00000000-0000-4000-8000-000000000031";

const prisma = hasDatabase ? new PrismaClient() : null;

async function cleanup() {
  if (!prisma) return;
  await prisma.followUpClosedEntry.deleteMany({ where: { conversationId: { startsWith: P } } });
  await prisma.conversation.deleteMany({ where: { id: { startsWith: P } } });
  await prisma.whatsAppConnection.deleteMany({ where: { id: { startsWith: P } } });
  await prisma.unit.deleteMany({ where: { id: { startsWith: P } } });
  await prisma.user.deleteMany({ where: { id: USER_ID } });
}

describe.skipIf(!hasDatabase)("follow-up closed entries, live", () => {
  beforeAll(async () => {
    await cleanup();
    const db = prisma as PrismaClient;
    await db.unit.createMany({
      data: [
        { id: P + "-unit", name: "Fechadas" },
        { id: P + "-other", name: "Outra loja" },
      ],
    });
    // Created rather than borrowed from ambient data: a close records who did
    // it, and a test that skips its assertions when no user happens to exist
    // passes green having checked nothing.
    await db.user.create({
      data: { id: USER_ID, email: P + "@example.test", name: "Fechada Fixture" },
    });
    await db.whatsAppConnection.create({
      data: { id: P + "-conn", unitId: P + "-unit", instanceName: P + "-instance" },
    });
    await db.conversation.createMany({
      data: [
        {
          id: P + "-conv",
          whatsappConnectionId: P + "-conn",
          remoteJid: "5519999990001@s.whatsapp.net",
          // Digits only: `conversation_chat_key_format` accepts a bare phone
          // or a `@g.us` group, so the fixture prefix cannot go here.
          chatKey: "5519999990001",
          startedAt: new Date("2026-08-01T12:00:00.000Z"),
          lastMessageAt: new Date("2026-08-20T12:00:00.000Z"),
        },
        {
          id: P + "-conv-other",
          whatsappConnectionId: P + "-conn",
          remoteJid: "5519999990002@s.whatsapp.net",
          chatKey: "5519999990002",
          startedAt: new Date("2026-08-01T12:00:00.000Z"),
          lastMessageAt: new Date("2026-08-20T12:00:00.000Z"),
        },
      ],
    });
  });

  afterAll(async () => {
    await cleanup();
    await prisma?.$disconnect();
  });

  it("records the closer and the instant on a first close", async () => {
    const db = prisma as PrismaClient;
    await closeFollowUpEntry(createDb(db), {
      section: "unansweredQuotes",
      unitId: P + "-unit",
      conversationId: P + "-conv",
      anchor: "quote-1",
      userId: USER_ID,
    });

    const rows = await db.followUpClosedEntry.findMany({
      where: { conversationId: P + "-conv" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.closedByUserId).toBe(USER_ID);
    expect(rows[0]?.closedAt).toBeInstanceOf(Date);
  });

  it("treats closing the same entry twice as the same statement", async () => {
    // Two attendants can be looking at one queue. The second one clicking
    // Fechar means what the first one meant, so this is an upsert rather than
    // the unique constraint surfacing as a 500.
    const db = prisma as PrismaClient;
    await closeFollowUpEntry(createDb(db), {
      section: "unansweredQuotes",
      unitId: P + "-unit",
      conversationId: P + "-conv",
      anchor: "quote-1",
      userId: USER_ID,
    });

    expect(
      await db.followUpClosedEntry.count({
        where: { conversationId: P + "-conv", anchor: "quote-1" },
      }),
    ).toBe(1);
  });

  it("keeps a newer anchor as its own row rather than reusing the old one", async () => {
    // This is the entire "returns on a newer trigger" mechanism: the anchor is
    // part of the key, so a newer quote is a different row and the older close
    // stops matching the entry the read is looking at.
    const db = prisma as PrismaClient;
    await closeFollowUpEntry(createDb(db), {
      section: "unansweredQuotes",
      unitId: P + "-unit",
      conversationId: P + "-conv",
      anchor: "quote-2",
      userId: USER_ID,
    });

    const anchors = (
      await db.followUpClosedEntry.findMany({
        where: { conversationId: P + "-conv", section: "unansweredQuotes" },
        orderBy: { anchor: "asc" },
      })
    ).map((row) => row.anchor);
    expect(anchors).toEqual(["quote-1", "quote-2"]);
  });

  it("closes one section of a conversation without touching the other", async () => {
    const db = prisma as PrismaClient;
    await closeFollowUpEntry(createDb(db), {
      section: "waitingReply",
      unitId: P + "-unit",
      conversationId: P + "-conv",
      anchor: "2026-08-20T12:00:00.000Z",
      userId: USER_ID,
    });

    const closed = await listClosedFollowUpEntries(createDb(db), P + "-unit");
    expect(closed.filter((row) => row.section === "waitingReply")).toHaveLength(1);
    // The quote closes are still there, untouched by the waiting-reply one.
    expect(closed.filter((row) => row.section === "unansweredQuotes")).toHaveLength(2);
  });

  it("lists only the asking loja's closed set", async () => {
    const db = prisma as PrismaClient;
    await closeFollowUpEntry(createDb(db), {
      section: "unansweredQuotes",
      unitId: P + "-other",
      conversationId: P + "-conv-other",
      anchor: "quote-other",
      userId: USER_ID,
    });

    const mine = await listClosedFollowUpEntries(createDb(db), P + "-unit");
    expect(mine.map((row) => row.conversationId)).not.toContain(P + "-conv-other");
    const theirs = await listClosedFollowUpEntries(createDb(db), P + "-other");
    expect(theirs.map((row) => row.anchor)).toEqual(["quote-other"]);
  });

  it("reopens the row it was given and reports a missing one as false", async () => {
    const db = prisma as PrismaClient;
    const removed = await reopenFollowUpEntry(createDb(db), {
      section: "unansweredQuotes",
      conversationId: P + "-conv",
      anchor: "quote-1",
    });
    expect(removed).toBe(true);

    // Already reopened, or superseded by a newer anchor. Either way the entry
    // is listed again, which is what the caller wanted — not an error.
    expect(
      await reopenFollowUpEntry(createDb(db), {
        section: "unansweredQuotes",
        conversationId: P + "-conv",
        anchor: "quote-1",
      }),
    ).toBe(false);
    // Reopening one anchor leaves the other close standing.
    expect(
      await db.followUpClosedEntry.count({
        where: { conversationId: P + "-conv", section: "unansweredQuotes" },
      }),
    ).toBe(1);
  });
});

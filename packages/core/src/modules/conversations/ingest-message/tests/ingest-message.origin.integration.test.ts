/**
 * Test design (testing-strategy)
 *
 * Moved from apps/worker/src/ingest/origin.ingest.test.ts (adopt-modular-vertical-slices 4A),
 * all cases, assertions unchanged. Ran under module roles: `conversations` for
 * conversation/message, `channel` (through its contracts) for webhook_event and
 * whatsapp_connection. Two mechanical changes: the store is `createIngestStore`
 * over the test transaction, and the insert hook the old cases counted is the
 * `conversations/message-received` event, counted at the same point.
 *
 * Setup: the real Prisma ingest store on the worktree database inside a
 * rolling-back test transaction (`withTestTransaction`), driven through
 * `persistRawEvent` / `canonicalizeEvent`. Logs collected from the canonicalize
 * `log` argument.
 *
 * Oracle: conversation-origin-classification task 2.1 / design D2 —
 *   first inbound + ctwa → AD; inbound without ctwa → ORGANIC;
 *   outbound-first → UNKNOWN; later ctwa upgrades ORGANIC→AD;
 *   follow-up without ctwa stays AD; logs MUST NOT contain the full clid.
 *   UNKNOWN is not rewritten to ORGANIC after insert.
 *
 * FAKE-ONLY ASSERTION SURFACED (route-tests-on-real-database, D10).
 * Every assertion in the old file read `store.conversations()[0]` — position zero
 * of the fake's whole conversation map. That is two fake-only things at once: an
 * absolute index over a table that on the real database also holds the pristine
 * base and the demo seed, and an ordering the adapter never promises. Each is
 * corrected to a lookup by the `(whatsappConnectionId, chatKey)` unique key, which
 * is the identity the schema actually gives a conversation and the one the fake
 * replaced with a flat unit+phone dedupe (proposal.md). `toHaveLength(1)` in the
 * upgrade case becomes a count scoped to this test's connection (design.md D9).
 *
 * What did NOT change, and is the point of migrating this file: the merge rule
 * itself. The old header listed "Prisma SQL (same merge rule)" as out of scope on
 * the belief that the fake's `apply` and the adapter's `ON CONFLICT ... DO UPDATE`
 * implemented one rule. This file now exercises that SQL directly — the
 * `CASE WHEN conversation.source_type IN ('UNKNOWN','ORGANIC') AND
 * EXCLUDED.source_type = 'AD'` arms in `prisma.ts` — so the upgrade, stay-AD and
 * stay-UNKNOWN cases are evidence about the shipped statement rather than about a
 * reimplementation of it. No behavioural divergence surfaced between the two; the
 * divergences were all in row identity and counting, above.
 *
 * Axes
 *   A1 first message — inbound+ctwa / inbound empty / outbound empty
 *   A2 later message — none / ctwa / empty inbound
 *   A3 stored class before later — ORGANIC / AD / UNKNOWN
 *
 * Outputs
 *   O1 AD + ctwa columns; O2 ORGANIC customer_initiated; O3 UNKNOWN;
 *   O4 upgrade AD; O5 stay AD; O6 stay UNKNOWN; O7 log without full clid
 *
 * Sampled-cell
 *   inbound + ctwa              | A1 ctwa     | O1 O7 | ORGANIC
 *   inbound without ctwa        | A1 inbound  | O2    | UNKNOWN
 *   outbound-first              | A1 outbound | O3    | ORGANIC
 *   later ctwa upgrades         | A2 A3       | O4    | stay ORGANIC
 *   follow-up without ctwa      | A2 A3 AD    | O5    | drop to ORGANIC
 *   later inbound on UNKNOWN    | A2 A3 UNK   | O6    | rewrite ORGANIC
 *   log omits full clid         | A1 ctwa     | O7    | SECRET in logs
 *
 * Decision / branch map (prisma.ts ON CONFLICT DO UPDATE)
 *   no existing row             T first-message its; F later-message its
 *   stored source_type = AD     T stay-AD it; F upgrade / stay-UNKNOWN
 *   incoming source_type = AD   T upgrade it; F stay-UNKNOWN it
 *
 * canonicalize.ts log after insert: T inbound+ctwa it; F (no insert) out
 *   of scope here — skip/status paths in canonicalize.test.ts.
 *
 * Out of scope: REST (history.test.ts); classifier key list (origin.test.ts).
 */
import { prisma, type PrismaClient } from "@select-lub/core/db";
import type { DbClient } from "@select-lub/core/db";
import {
  describeWithDatabase,
  seedConnection,
  seedUnit,
  withTestTransaction,
} from "../../../../testing/index.js";
import { expect, it } from "vitest";
import { canonicalizeEvent, persistRawEvent } from "../index.js";
import { upsertPayload } from "../../../../testing/index.js";
import { CLASSIFICATION_RULE_VERSION } from "../index.js";
import { ingestStoreOn } from "./ingest.fixture.js";
import type { IngestStore as Persistence } from "../index.js";

const SECRET_CLID = "CTWA-SECRET-CLICK-ID";

/** The chat key every `upsertPayload` default resolves to. */
const CHAT_KEY = "5511999999999";

const db = () => prisma as PrismaClient;

/**
 * Seeds a unit and a connection and builds the real ingest store on `tx`.
 *
 * @param tx - The test transaction.
 * @returns The connection row and the store built on `tx`.
 */
async function setup(tx: DbClient) {
  const unit = await seedUnit(tx);
  const connection = await seedConnection(tx, { unitId: unit.id });
  const store = ingestStoreOn(tx);
  return { connection, store };
}

/**
 * Persists and canonicalizes one webhook payload.
 *
 * @param store - The ingest store under test.
 * @param payload - Evolution webhook body.
 * @param logs - Optional sink for the canonicalize log lines.
 */
async function ingest(store: Persistence, payload: unknown, logs?: string[]) {
  const { id } = await persistRawEvent(store, payload);
  await canonicalizeEvent(
    store,
    id,
    (line) => logs?.push(line),
  );
}

/**
 * Reads the conversation back by the key the schema identifies it with.
 *
 * Not by index into the table: the database also holds the base and the demo seed.
 *
 * @param tx - The test transaction.
 * @param connectionId - The connection this test created.
 * @returns The conversation row.
 */
function conversationOf(tx: DbClient, connectionId: string) {
  return tx.conversation.findUniqueOrThrow({
    where: {
      whatsappConnectionId_chatKey: {
        whatsappConnectionId: connectionId,
        chatKey: CHAT_KEY,
      },
    },
  });
}

describeWithDatabase("ingest origin apply", () => {
  it("classifies a first inbound upsert with ctwa as AD", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, store } = await setup(tx);
      const logs: string[] = [];

      await ingest(
        store,
        upsertPayload({
          instance: connection.instanceName,
          id: "IN-CTWA",
          dataExtra: { ctwaClid: SECRET_CLID },
        }),
        logs,
      );

      const row = await conversationOf(tx, connection.id);
      expect(row.sourceType).toBe("AD");
      expect(row.sourceEvidenceType).toBe("ctwa");
      expect(row.ctwaClid).toBe(SECRET_CLID);
      expect(row.classificationRuleVersion).toBe(CLASSIFICATION_RULE_VERSION);
      expect(logs.join("\n")).not.toContain(SECRET_CLID);
      expect(logs.some((line) => line.includes("conversation origin AD ctwa"))).toBe(true);
    }));

  it("classifies a first inbound upsert without ctwa as ORGANIC", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, store } = await setup(tx);

      await ingest(store, upsertPayload({ instance: connection.instanceName, id: "IN-ORG" }));

      const row = await conversationOf(tx, connection.id);
      expect(row.sourceType).toBe("ORGANIC");
      expect(row.sourceEvidenceType).toBe("customer_initiated");
      expect(row.classificationRuleVersion).toBe(CLASSIFICATION_RULE_VERSION);
    }));

  it("classifies an outbound-first upsert as UNKNOWN", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, store } = await setup(tx);

      await ingest(
        store,
        upsertPayload({ instance: connection.instanceName, id: "OUT-1", fromMe: true }),
      );

      const row = await conversationOf(tx, connection.id);
      expect(row.sourceType).toBe("UNKNOWN");
      expect(row.sourceEvidenceType).toBe("none");
      expect(row.classificationRuleVersion).toBe(CLASSIFICATION_RULE_VERSION);
    }));

  it("upgrades ORGANIC to AD when a later upsert carries ctwa", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, store } = await setup(tx);

      await ingest(store, upsertPayload({ instance: connection.instanceName, id: "ORG-1" }));
      expect((await conversationOf(tx, connection.id)).sourceType).toBe("ORGANIC"); // precondition

      await ingest(
        store,
        upsertPayload({
          instance: connection.instanceName,
          id: "ORG-2",
          dataExtra: { ctwaClid: SECRET_CLID },
        }),
      );

      // One conversation, not two: the second message merged onto the same
      // (whatsappConnectionId, chatKey) row rather than opening another.
      expect(
        await tx.conversation.count({ where: { whatsappConnectionId: connection.id } }),
      ).toBe(1);
      const row = await conversationOf(tx, connection.id);
      expect(row.sourceType).toBe("AD");
      expect(row.ctwaClid).toBe(SECRET_CLID);
    }));

  it("keeps AD when a later upsert has no ctwa", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, store } = await setup(tx);

      await ingest(
        store,
        upsertPayload({
          instance: connection.instanceName,
          id: "AD-1",
          dataExtra: { ctwaClid: SECRET_CLID },
        }),
      );
      expect((await conversationOf(tx, connection.id)).sourceType).toBe("AD"); // precondition

      await ingest(store, upsertPayload({ instance: connection.instanceName, id: "AD-2" }));

      const row = await conversationOf(tx, connection.id);
      expect(row.sourceType).toBe("AD");
      expect(row.ctwaClid).toBe(SECRET_CLID);
    }));

  it("does not rewrite UNKNOWN to ORGANIC on a later inbound without ctwa", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, store } = await setup(tx);

      await ingest(
        store,
        upsertPayload({ instance: connection.instanceName, id: "UNK-1", fromMe: true }),
      );
      expect((await conversationOf(tx, connection.id)).sourceType).toBe("UNKNOWN"); // precondition

      await ingest(store, upsertPayload({ instance: connection.instanceName, id: "UNK-2" }));

      expect((await conversationOf(tx, connection.id)).sourceType).toBe("UNKNOWN");
    }));
});

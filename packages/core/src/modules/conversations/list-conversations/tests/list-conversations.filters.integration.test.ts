/**
 * Test design (testing-strategy) — conversations / list-conversations, filters
 *
 * Module role: `module_conversations`.
 *
 * Moved from `apps/api/src/conversations.filters.route.test.ts` (4A), assertions
 * unchanged: twelve of its fourteen cases. The tenancy-join case is
 * `list-conversations.integration.test.ts`; the chat-key uniqueness case chains
 * Nova conversa and stays on the whole app in
 * `apps/api/test/conversations.integration.test.ts`.
 *
 * SUT: the inbox filters — `GET /conversations` with `origin`, `stage`, `from`,
 *   `to`, `q`, `unanswered` and `tagId` — through `buildSliceApp` with this
 *   slice's route only, inside one rolling-back transaction.
 *
 * Oracle: `conversas` delta of `align-shipped-ui-to-revised-canvas`, requirement
 *   "Inbox can be filtered by origin, pipeline stage and period", plus
 *   `conversas` "Stage filter matches the funnel". The period is inclusive
 *   calendar days in America/Sao_Paulo converted to REP-15's half-open instant
 *   window (user's decision, 2026-09-03), which is why the boundary cases check
 *   the last day is included IN FULL while the day after is excluded.
 *
 * Axes
 *   A1 origin   — AD / ORGANIC / UNKNOWN / absent / a value naming none
 *   A2 stage    — each of the four / absent / a value naming none / a real
 *                 member the cumulative cut currently finds nothing at or past
 *   A3 period   — no bound / from only / to only / both
 *   A4 first-inbound time — set / null (a thread the shop opened)
 *   A5 composition — a filter alone / with search / with unanswered / with tag
 *
 *   BVA on A3, the only ordered axis. The window is `[from 00:00, to+1 00:00)`
 *   at −03:00: sampled at `from 00:00:00-03:00` (in), `to 23:59:59-03:00` (in),
 *   and `to+1 00:00:00-03:00` (out).
 *
 * Outputs: O1 200 with only the matching conversations; O2 200 with an empty
 *   array; O3 the unfiltered list (what an unknown value must NOT produce).
 *
 * The decision map is the original file's; its `create` rows went with the
 * uniqueness case.
 */
import { expect, it } from "vitest";
import { conversationSummaryListSchema } from "../../contracts/http.js";
import type { DbClient } from "@select-lub/core/db";
import { describeWithDatabase, seedConversation, withTestTransaction } from "@select-lub/core/testing";
import {
  addCustomer,
  addMessages,
  addQuoteSent,
  addServiceAttributed,
  db,
  idsOf,
  listIds,
  setup,
  type Msg,
} from "./conversation-list.fixture.js";

/** Seeds one conversation per origin, all inbound-only, so origin is the only separator. */
async function seedByOrigin(tx: DbClient) {
  const scope = await setup(tx);
  const made: Record<string, string> = {};
  for (const [key, sourceType, chatKey] of [
    ["ad", "AD", "11900000001"],
    ["organic", "ORGANIC", "11900000002"],
    ["unknown", "UNKNOWN", "11900000003"],
  ] as const) {
    const conversation = await seedConversation(tx, { connectionId: scope.connection.id, chatKey });
    await tx.conversation.update({ where: { id: conversation.id }, data: { sourceType } });
    await addMessages(tx, conversation.id, [{ direction: "inbound", textBody: "oi" }]);
    made[key] = conversation.id;
  }
  return { ...scope, made };
}

describeWithDatabase("GET /conversations filters", () => {
  it("lists only anúncio conversations when filtered by that origin", () =>
    withTestTransaction(db(), async (tx) => {
      const { app, made } = await seedByOrigin(tx);

      const response = await listIds(app, "?origin=AD");

      expect(response.statusCode).toBe(200);
      expect(idsOf(response)).toEqual([made.ad]);
      await app.close();
    }));

  it("selects on the same derived stage the read shape reports", () =>
    withTestTransaction(db(), async (tx) => {
      const { unit, connection, user, app } = await setup(tx);
      const replied = await seedConversation(tx, { connectionId: connection.id, chatKey: "11900000001" });
      await addMessages(tx, replied.id, [
        { direction: "inbound", textBody: "oi" },
        { direction: "outbound", textBody: "olá" },
      ]);
      const quoted = await seedConversation(tx, { connectionId: connection.id, chatKey: "11900000002" });
      await addMessages(tx, quoted.id, [
        { direction: "inbound", textBody: "oi" },
        { direction: "outbound", textBody: "segue o orçamento" },
      ]);
      await addQuoteSent(tx, { unitId: unit.id, conversationId: quoted.id, userId: user.id });

      const response = await listIds(app, "?stage=orcamentoEnviado");

      expect(response.statusCode).toBe(200);
      const rows = conversationSummaryListSchema.parse(response.json());
      expect(rows.map((row) => row.id)).toEqual([quoted.id]);
      // The cut agrees with what the row itself reports, which is the whole point
      // of filtering on the derived value rather than on the events behind it.
      expect(rows[0]?.pipelineStage).toBe("orcamentoEnviado");
      expect(rows.map((row) => row.id)).not.toContain(replied.id);
      await app.close();
    }));

  it("returns the stage-or-later set the funnel counts, not only the rows at that stage", () =>
    withTestTransaction(db(), async (tx) => {
      // The funnel is CUMULATIVE: Orcamento Enviado counts every conversation at
      // that point or further, which is what "ver as N" promises.
      const { unit, connection, user, app } = await setup(tx);
      const inboundOnly: Msg[] = [{ direction: "inbound", textBody: "oi" }];
      const replied: Msg[] = [...inboundOnly, { direction: "outbound", textBody: "ola" }];

      const novo = await seedConversation(tx, { connectionId: connection.id, chatKey: "11900000001" });
      await addMessages(tx, novo.id, inboundOnly);
      const atendimento = await seedConversation(tx, { connectionId: connection.id, chatKey: "11900000002" });
      await addMessages(tx, atendimento.id, replied);
      const orcamento = await seedConversation(tx, { connectionId: connection.id, chatKey: "11900000003" });
      await addMessages(tx, orcamento.id, replied);
      await addQuoteSent(tx, { unitId: unit.id, conversationId: orcamento.id, userId: user.id });
      const servico = await seedConversation(tx, { connectionId: connection.id, chatKey: "11900000004" });
      await addMessages(tx, servico.id, replied);
      await addQuoteSent(tx, { unitId: unit.id, conversationId: servico.id, userId: user.id });
      await addServiceAttributed(tx, { unitId: unit.id, conversationId: servico.id });

      // Written out rather than derived with `pipelineStageReached`: computing the
      // expectation with the same helper the filter uses would pass even if that
      // helper were wrong.
      const expected = [
        { stage: "novosContatos", ids: [novo.id, atendimento.id, orcamento.id, servico.id] },
        { stage: "emAtendimento", ids: [atendimento.id, orcamento.id, servico.id] },
        { stage: "orcamentoEnviado", ids: [orcamento.id, servico.id] },
        { stage: "servicosFeitos", ids: [servico.id] },
      ];

      for (const { stage, ids } of expected) {
        const response = await listIds(app, `?stage=${stage}`);
        expect(response.statusCode, stage).toBe(200);
        expect([...idsOf(response)].sort(), stage).toEqual([...ids].sort());
      }
      // Counts too, so a bug that emptied every cut could not pass by making both
      // sides equally wrong. Safe as an absolute: the loja is this transaction's.
      expect(expected.map((row) => row.ids.length)).toEqual([4, 3, 2, 1]);
      await app.close();
    }));

  it("includes the whole last day of the period and nothing after it", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, app } = await setup(tx);
      const rows = [
        ["11900000001", "2026-08-09T23:59:59.000-03:00"],
        ["11900000002", "2026-08-10T00:00:00.000-03:00"],
        ["11900000003", "2026-08-12T23:59:59.000-03:00"],
        ["11900000004", "2026-08-13T00:00:00.000-03:00"],
      ] as const;
      const [before, firstInstant, lastInstant, dayAfter] = await Promise.all(
        rows.map(async ([chatKey, at]) => {
          const conversation = await seedConversation(tx, { connectionId: connection.id, chatKey });
          await tx.conversation.update({ where: { id: conversation.id }, data: { firstInboundAt: new Date(at) } });
          return conversation.id;
        }),
      );

      const response = await listIds(app, "?from=2026-08-10&to=2026-08-12");

      expect(response.statusCode).toBe(200);
      const ids = idsOf(response);
      expect(ids).toContain(firstInstant);
      expect(ids).toContain(lastInstant);
      expect(ids).not.toContain(before);
      expect(ids).not.toContain(dayAfter);
      await app.close();
    }));

  it("leaves a thread with no first-inbound time out of a bounded period", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, app } = await setup(tx);
      const undated = await seedConversation(tx, { connectionId: connection.id, chatKey: "11900000001" });

      // Precondition: the fixture really has no first-inbound time, so the empty
      // result below cannot come from the row simply not existing.
      expect(
        (await tx.conversation.findUnique({ where: { id: undated.id }, select: { firstInboundAt: true } }))
          ?.firstInboundAt,
      ).toBeNull();

      const response = await listIds(app, "?from=2026-08-01&to=2026-08-31");

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([]);
      await app.close();
    }));

  it("keeps a thread with no first-inbound time when no period is asked for", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, app } = await setup(tx);
      const undated = await seedConversation(tx, { connectionId: connection.id, chatKey: "11900000001" });

      const response = await listIds(app, "");

      expect(response.statusCode).toBe(200);
      expect(idsOf(response)).toEqual([undated.id]);
      await app.close();
    }));

  it("composes origin with a period that excludes every conversation of that origin", () =>
    withTestTransaction(db(), async (tx) => {
      const { app } = await seedByOrigin(tx);

      const response = await listIds(app, "?origin=AD&from=2026-09-01&to=2026-09-30");

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([]);
      await app.close();
    }));

  it("composes stage with search and tag", () =>
    withTestTransaction(db(), async (tx) => {
      const { unit, connection, user, app } = await setup(tx);
      const wanted = await seedConversation(tx, { connectionId: connection.id, chatKey: "11900000001" });
      await addMessages(tx, wanted.id, [
        { direction: "inbound", textBody: "oi" },
        { direction: "outbound", textBody: "orçamento" },
      ]);
      await addCustomer(tx, { unitId: unit.id, name: "Maria Silva", conversationId: wanted.id });
      const otherStage = await seedConversation(tx, { connectionId: connection.id, chatKey: "11900000002" });
      await addMessages(tx, otherStage.id, [
        { direction: "inbound", textBody: "oi" },
        { direction: "outbound", textBody: "olá" },
      ]);
      await addCustomer(tx, { unitId: unit.id, name: "Maria Souza", conversationId: otherStage.id });
      await addQuoteSent(tx, { unitId: unit.id, conversationId: wanted.id, userId: user.id });

      const tag = await tx.tag.create({ data: { unitId: unit.id, name: "VIP", color: null }, select: { id: true } });
      // Both threads carry the tag and both match the search, so only the stage
      // can separate them — which is what makes this a composition test.
      await tx.conversationTag.createMany({
        data: [
          { conversationId: wanted.id, tagId: tag.id },
          { conversationId: otherStage.id, tagId: tag.id },
        ],
      });

      const response = await listIds(app, `?stage=orcamentoEnviado&q=Maria&tagId=${tag.id}`);

      expect(response.statusCode).toBe(200);
      expect(idsOf(response)).toEqual([wanted.id]);
      await app.close();
    }));

  it("composes stage with the unanswered filter", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, app } = await setup(tx);
      const waiting = await seedConversation(tx, { connectionId: connection.id, chatKey: "11900000001" });
      await addMessages(tx, waiting.id, [
        { direction: "outbound", textBody: "olá" },
        {
          direction: "inbound",
          textBody: "e o preço?",
          providerTimestamp: new Date("2026-08-10T13:00:00.000-03:00"),
          shouldReply: true,
        },
      ]);
      const answered = await seedConversation(tx, { connectionId: connection.id, chatKey: "11900000002" });
      await addMessages(tx, answered.id, [
        { direction: "inbound", textBody: "oi" },
        { direction: "outbound", textBody: "olá" },
      ]);

      const response = await listIds(app, "?stage=emAtendimento&unanswered=true");

      expect(response.statusCode).toBe(200);
      expect(idsOf(response)).toEqual([waiting.id]);
      await app.close();
    }));

  it("returns an empty cut for a valid pipeline stage nothing has reached yet", () =>
    withTestTransaction(db(), async (tx) => {
      // Distinct from "answers an empty cut for a pipeline stage that does not
      // exist": this samples the VALID partition's empty case — a real stage the
      // cut itself finds nothing at or past — which must answer a well-formed
      // empty list, not an error and not the unfiltered list.
      const { connection, app } = await setup(tx);
      const novo = await seedConversation(tx, { connectionId: connection.id, chatKey: "11900000001" });
      await addMessages(tx, novo.id, [{ direction: "inbound", textBody: "oi" }]);
      const atendimento = await seedConversation(tx, { connectionId: connection.id, chatKey: "11900000002" });
      await addMessages(tx, atendimento.id, [
        { direction: "inbound", textBody: "oi" },
        { direction: "outbound", textBody: "ola" },
      ]);

      const unfiltered = await listIds(app, "");
      // Pinned so a bug that empties every cut, or one that falls back to the
      // unfiltered list on a valid-but-empty cut, cannot pass by coincidence.
      expect([...idsOf(unfiltered)].sort()).toEqual([novo.id, atendimento.id].sort());

      const response = await listIds(app, "?stage=servicosFeitos");

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([]);
      await app.close();
    }));

  it("answers an empty cut for a pipeline stage that does not exist", () =>
    withTestTransaction(db(), async (tx) => {
      const { app } = await seedByOrigin(tx);

      const response = await listIds(app, "?stage=naoExiste");

      // Not 400 — a Relatórios link carrying a renamed stage must not break the
      // screen — and not the unfiltered list, which would look like it worked.
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([]);
      await app.close();
    }));

  it("answers an empty cut for an origin that does not exist", () =>
    withTestTransaction(db(), async (tx) => {
      const { app } = await seedByOrigin(tx);

      const response = await listIds(app, "?origin=TELEPATIA");

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([]);
      await app.close();
    }));
});

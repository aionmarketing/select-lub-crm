/**
 * Test design (testing-strategy)
 *
 * SUT: the derived pipeline stage of task 8.1 — `conversationPipelineStage`
 *   and `pipelineStageReached` in `packages/shared-types/src/reports.ts`, the
 *   REP-15 funnel that derives its counts from them, and `summaryFrom` in
 *   `conversations/store.ts`, which puts the result on the conversation read
 *   shape.
 *
 * The funnel side is the PUBLISHED funnel rule: `reportFunnel`, exported from
 *   the reports module's contracts (`@select-lub/core/modules/reports/contracts`)
 *   since adopt-modular-vertical-slices stream 2C. The reports module's own
 *   insights call that same function for the funnel they draw, so this test pins
 *   the rule the screen uses, not a copy of it. It used to call the whole
 *   `buildPeriodInsights` and read `.funnel` off it, passing stub `result`,
 *   `services` and `customers` inputs that only the wider signature needed; those
 *   stubs are gone and both funnel assertions are unchanged.
 *
 * Oracle: `conversas` delta of `align-shipped-ui-to-revised-canvas`,
 *   requirement "A conversation carries a derived pipeline stage" — its four
 *   scenarios are the first, second, fourth and fifth `it` here. The stage is
 *   the furthest point reached; it is derived from the same events REP-15 uses;
 *   grouping by it agrees with the funnel; and no interface sets it.
 *
 * The agreement test is the point of the whole task, so it is built the way it
 * could actually fail: not by asserting two constants, but by running
 * `buildPeriodInsights` over a population whose stages are ALSO computed
 * independently through the read shape, then asserting the two arrive at the
 * same four numbers. A second implementation of the rule would show up here.
 *
 * Axes (the three funnel events; each yes/no, so no BVA applies)
 *   A1 team reply        — an outbound message exists / none
 *   A2 quote sent        — a quote names the conversation / none
 *   A3 service attributed— an attribution names it / none
 *
 * Decision table over A1×A2×A3 — 8 rows, no don't-cares collapsed before
 * listing, because the nesting makes three of them counter-intuitive:
 *   A1 A2 A3 | stage
 *   ---------|---------------------------------------------
 *    F  F  F | novosContatos
 *    F  F  T | novosContatos   ← attribution without a reply does NOT advance
 *    F  T  F | novosContatos   ← a quote without a reply does NOT advance
 *    F  T  T | novosContatos
 *    T  F  F | emAtendimento
 *    T  F  T | emAtendimento   ← attribution without a quote does NOT advance
 *    T  T  F | orcamentoEnviado
 *    T  T  T | servicosFeitos
 *   The three marked rows are the ones REP-15's nesting produces and a naive
 *   "furthest event wins" would get wrong; they are the reason this table is
 *   exhaustive rather than sampled.
 *
 * Outputs
 *   O1 one of the four stage values
 *   O2 funnel counts equal to the counts of stages at or past each level
 *   O3 the conversation read shape carrying the stage
 *   O4 no write surface accepting a stage
 *
 * Sampled cells beyond the table (one row per `it`)
 *   read shape carries it     | the summary DTO | O3
 *                               | fails if the field is absent or not derived
 *   inbound-only is first     | A1 F            | O1
 *   totals match the funnel   | mixed population| O2
 *                               | fails if either side re-implements the rule
 *   write surface rejects it  | POST body       | O4
 *                               | fails if a client could pin a stage
 *
 * Decision / branch map
 *   `conversationPipelineStage` `!facts.hasTeamReply`
 *     T — the four A1-false table rows; F — the four A1-true rows
 *   `conversationPipelineStage` `!facts.hasQuoteSent`
 *     T — rows T/F/F and T/F/T; F — rows T/T/F and T/T/T
 *   `conversationPipelineStage` `hasServiceAttributed ? … : …`
 *     T — row T/T/T; F — row T/T/F
 *   `pipelineStageReached` comparison
 *     T and F — both, at every level, in the agreement `it`: its population
 *     holds conversations at all four stages, so each of the three `reached`
 *     calls counts some rows in and some out
 *   `summaryFrom` `input.stageFacts ?? {…}`
 *     T (absent) — the inbound-only `it`, which passes no facts
 *     F (present) — the read-shape `it`
 *
 * Out of scope, with reason
 *   - The Prisma list read's two set queries: covered by
 *     `conversations/prisma.test.ts`, whose fake client now models both tables.
 *   - Task 8.2's thread header, which shows the stage — `apps/web` is another
 *     session's lane.
 *   - The measured query cost: that is task 8.3, recorded on the task itself.
 */
import { CONVERSATION_PIPELINE_STAGES, conversationPipelineStage, type ConversationPipelineStage } from "../src/modules/reports/contracts/http.js";
import { createConversationBodySchema, sendTextBodySchema } from "../src/modules/conversations/contracts/http.js";
import { describe, expect, it } from "vitest";
import { reportFunnel, type FunnelConversation } from "../src/modules/reports/contracts/index.js";
import { summaryFrom } from "../src/modules/conversations/internal/conversation-dto.js";

const UNIT = "unit-a";
const PERIOD = { periodStart: "2026-08-01T00:00:00.000Z", periodEnd: "2026-09-01T00:00:00.000Z" };

describe("conversationPipelineStage", () => {
  it.each([
    { hasTeamReply: false, hasQuoteSent: false, hasServiceAttributed: false, expected: "novosContatos" },
    { hasTeamReply: false, hasQuoteSent: false, hasServiceAttributed: true, expected: "novosContatos" },
    { hasTeamReply: false, hasQuoteSent: true, hasServiceAttributed: false, expected: "novosContatos" },
    { hasTeamReply: false, hasQuoteSent: true, hasServiceAttributed: true, expected: "novosContatos" },
    { hasTeamReply: true, hasQuoteSent: false, hasServiceAttributed: false, expected: "emAtendimento" },
    { hasTeamReply: true, hasQuoteSent: false, hasServiceAttributed: true, expected: "emAtendimento" },
    { hasTeamReply: true, hasQuoteSent: true, hasServiceAttributed: false, expected: "orcamentoEnviado" },
    { hasTeamReply: true, hasQuoteSent: true, hasServiceAttributed: true, expected: "servicosFeitos" },
  ])(
    "reply=$hasTeamReply quote=$hasQuoteSent service=$hasServiceAttributed → $expected",
    ({ expected, ...facts }) => {
      expect(conversationPipelineStage(facts)).toBe(expected);
    },
  );

  it("puts a conversation with a team reply and a sent quote at Orçamento enviado", () => {
    const stage = conversationPipelineStage({
      hasTeamReply: true,
      hasQuoteSent: true,
      hasServiceAttributed: false,
    });

    expect(stage).toBe("orcamentoEnviado");
  });
});

describe("the conversation read shape", () => {
  it("carries the stage derived from its facts", () => {
    const summary = summaryFrom({
      id: "conv-1",
      phone: "11999990000",
      lastSnippet: "olá",
      lastMessageAt: new Date("2026-08-20T12:00:00.000Z"),
      sourceType: "ORGANIC",
      stageFacts: { hasTeamReply: true, hasQuoteSent: true, hasServiceAttributed: true },
    });

    expect(summary.pipelineStage).toBe("servicosFeitos");
  });

  it("puts a conversation with inbound messages only at the first stage", () => {
    const summary = summaryFrom({
      id: "conv-2",
      phone: "11999990001",
      lastSnippet: "bom dia",
      lastMessageAt: new Date("2026-08-20T12:00:00.000Z"),
      sourceType: "ORGANIC",
    });

    expect(summary.pipelineStage).toBe("novosContatos");
  });
});

describe("stage totals and the REP-15 funnel", () => {
  it("agrees with the funnel for the same period and cut", () => {
    // A population covering all four stages, so every `reached` comparison
    // counts some rows in and some out.
    const population = [
      { id: "c1", reply: false, quote: false, service: false },
      { id: "c2", reply: false, quote: true, service: false },
      { id: "c3", reply: true, quote: false, service: false },
      { id: "c4", reply: true, quote: false, service: true },
      { id: "c5", reply: true, quote: true, service: false },
      { id: "c6", reply: true, quote: true, service: false },
      { id: "c7", reply: true, quote: true, service: true },
    ];
    const rows: FunnelConversation[] = population.map((row) => ({
      conversationId: row.id,
      unitId: UNIT,
      sourceType: "ORGANIC",
      firstInboundAt: new Date("2026-08-10T12:00:00.000Z"),
      firstOutboundAt: row.reply ? new Date("2026-08-10T13:00:00.000Z") : null,
      campaignId: null,
      adSetId: null,
      adId: null,
      tags: [],
      messages: [],
      customerId: null,
    }));
    const quotes = population
      .filter((row) => row.quote)
      .map((row, index) => ({
        quoteId: `q-${row.id}`,
        conversationId: row.id,
        customerId: `cus-${index}`,
        unitId: UNIT,
        createdAt: new Date("2026-08-11T12:00:00.000Z"),
      }));
    const conversationAttributions = population
      .filter((row) => row.service)
      .map((row) => ({ serviceId: `svc-${row.id}`, conversationId: row.id, ruleVersion: 1 }));

    const funnel = reportFunnel({
      rows,
      unitId: UNIT,
      periodStart: new Date(PERIOD.periodStart),
      periodEnd: new Date(PERIOD.periodEnd),
      quotes,
      conversationAttributions,
    });

    // The same conversations, staged through the read shape's own path.
    const stages: ConversationPipelineStage[] = population.map(
      (row) =>
        summaryFrom({
          id: row.id,
          phone: "11999990000",
          lastSnippet: "",
          lastMessageAt: new Date("2026-08-10T12:00:00.000Z"),
          sourceType: "ORGANIC",
          stageFacts: {
            hasTeamReply: row.reply,
            hasQuoteSent: row.quote,
            hasServiceAttributed: row.service,
          },
        }).pipelineStage,
    );
    const countFrom = (floor: ConversationPipelineStage) =>
      stages.filter(
        (stage) =>
          CONVERSATION_PIPELINE_STAGES.indexOf(stage) >=
          CONVERSATION_PIPELINE_STAGES.indexOf(floor),
      ).length;

    expect(funnel).toEqual({
      novosContatos: countFrom("novosContatos"),
      emAtendimento: countFrom("emAtendimento"),
      orcamentoEnviado: countFrom("orcamentoEnviado"),
      servicosFeitos: countFrom("servicosFeitos"),
    });
    // Stated absolutely too, so a bug that zeroed BOTH sides could not pass.
    expect(funnel).toEqual({
      novosContatos: 7,
      emAtendimento: 5,
      orcamentoEnviado: 3,
      servicosFeitos: 1,
    });
  });
});

describe("the conversation write surface", () => {
  it("accepts no pipeline stage on either write body", () => {
    const created = createConversationBodySchema.parse({
      phone: "11999990000",
      pipelineStage: "servicosFeitos",
    });
    const sent = sendTextBodySchema.parse({ text: "olá", pipelineStage: "servicosFeitos" });

    // Parsed away rather than carried: a client cannot pin a stage, so the
    // derived value can never be overridden by whoever posts last.
    expect(created).toEqual({ phone: "11999990000" });
    expect(sent).toEqual({ text: "olá" });
  });
});

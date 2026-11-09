/**
 * Test design (testing-strategy)
 *
 * Setup: the two pure functions in `inboxLink.ts`. No DOM, no HTTP, no router.
 *
 * Oracle: `conversas/spec.md`, "Inbox can be filtered by origin, pipeline
 * stage and period" — all three filters "SHALL compose with each other" and
 * "SHALL be expressible in the inbox's address so a link can carry them",
 * plus its scenario "Applied filters are visible and removable", which opens
 * the inbox "from a report link carrying an origin, a stage and a period".
 * That scenario is why the origin+stage case is tested even though no caller
 * builds one today: `RelatoriosPage.tsx:916` passes a stage and `:1124` an
 * origin, never both, so the composed form the spec requires is reachable
 * only through this builder's contract. A link shape that silently dropped
 * one of the two would be caught here and nowhere else.
 *
 * The reverse direction is asserted with `URLSearchParams` rather than by
 * string comparison alone, because the contract this module exists to protect
 * is that the WRITER (Relatórios) and the READER (`ConversasPage.tsx:47`,
 * which calls `searchParams.get("stage")`) agree on param NAMES. Comparing
 * whole strings would pin the parameter ORDER too, which nothing specifies.
 *
 * Axes
 *   A1 origin present / absent
 *   A2 stage present / absent
 *     A1×A2 is a 2×2 decision table, enumerated in full below — four rules,
 *     no collapse, since each `if` in the builder is independent and cheap
 *     to sample.
 *   A3 period shape: a single day / within one month / spanning two months
 *
 * Outputs
 *   O1 the param NAMES present on the link
 *   O2 the value carried under each name
 *   O3 the chip string
 *
 * Decision table (A1×A2), one `it` per rule
 *   rule | origin | stage | expected params
 *   R1   | yes    | yes   | origin, stage, from, to   ← the spec's drill link
 *   R2   | yes    | no    | origin, from, to
 *   R3   | no     | yes   | stage, from, to
 *   R4   | no     | no    | from, to
 *   R2/R3/R4 each assert the ABSENCE of the omitted key, not merely the
 *   presence of the others: `params.set(k, undefined)` would stringify to
 *   "undefined" and still satisfy a presence-only assertion.
 *
 * Sampled cells (one row per `it`)
 *   R1 both filters      | A1,A2 | O1,O2 | fails if either is dropped
 *   R2 origin only       | A1    | O1    | fails if `stage=undefined` is written
 *   R3 stage only        | A2    | O1    | fails if `origin=undefined` is written
 *   R4 period only       | —     | O1    | fails if an empty filter still emits a key
 *   period always sent   | R4    | O2    | fails if from/to become conditional
 *   chip, single day     | A3    | O3    | fails if a from===to period collapses
 *                                          to one end or renders a blank side
 *   chip, one month      | A3    | O3    | fails if the day/month pair inverts
 *   chip, two months     | A3    | O3    | fails if the month is taken from `from`
 *                                          for both ends
 *
 * Decision / branch map
 *   `inboxDrillLink` `if (filters.origin)`
 *     T — R1, R2; F — R3, R4
 *   `inboxDrillLink` `if (filters.stage)`
 *     T — R1, R3; F — R2, R4
 *   `formatPeriodChip` — no decision; it is straight-line slicing, so it gets
 *     BVA-style samples on the month rollover instead of a branch map.
 *
 * Out of scope, with reason
 *   - Falsy-but-present filter values (`origin: ""`). Both fields are typed
 *     as unions of non-empty literals, so an empty string is unrepresentable
 *     without casting; the truthiness check and an `!== undefined` check
 *     cannot be told apart by any legal input. Contract-hidden, not skipped.
 *   - A period that SPANS A YEAR BOUNDARY (`from` 2025-12-28, `to`
 *     2026-01-03). `formatPeriodChip` prints only `to`'s year, so that period
 *     renders "28/12 – 03/01/2026" with 28/12 actually falling in 2025.
 *     NOT asserted here in either direction: the artboard the function cites
 *     shows a within-month period only, and no requirement says what a
 *     cross-year chip should read. Reported to the coordinator on 2026-09-07
 *     rather than settled by a test, because writing one would freeze
 *     whichever reading I picked.
 *   - PERCENT-ENCODING of parameter values. Considered and found
 *     contract-hidden: every value the builder can receive is either a
 *     `ConversationSourceType` / `ConversationPipelineStage` literal (ASCII
 *     camelCase, no space or accent) or a `YYYY-MM-DD` date string. The
 *     accented Portuguese text in this module — "Anúncio", "Orçamento
 *     Enviado" — lives in the LABEL maps, which are rendered, never written
 *     into a URL. So no legal input can produce a value needing escaping,
 *     and a test would have to cast past the types to build one.
 *   - `FUNNEL_STAGE_LABELS` / `THREAD_STAGE_LABELS` / `ORIGIN_LABELS` KEY
 *     completeness: typed Records, so a missing key fails the build.
 *   - Label VALUE casing is split: funnel title-case from relatorios:417;
 *     thread sentence-case from design-system:451 and conversas:507. Sampled
 *     below for the two keys that actually differ.
 */
import { describe, expect, it } from "vitest";
import { FUNNEL_STAGE_LABELS, THREAD_STAGE_LABELS, formatPeriodChip, inboxDrillLink } from "./inboxLink.js";

const AUG = { from: "2026-08-01", to: "2026-08-28" };

/** The query half of a built link, parsed so assertions read param names. */
function paramsOf(link: string): URLSearchParams {
  return new URLSearchParams(link.slice(link.indexOf("?")));
}

describe("inboxDrillLink", () => {
  it("carries an origin, a stage and a period together on one link", () => {
    const params = paramsOf(inboxDrillLink({ origin: "AD", stage: "orcamentoEnviado", ...AUG }));

    expect(Object.fromEntries(params)).toEqual({
      origin: "AD",
      stage: "orcamentoEnviado",
      from: "2026-08-01",
      to: "2026-08-28",
    });
  });

  it("omits the stage key entirely when only an origin is cut on", () => {
    const params = paramsOf(inboxDrillLink({ origin: "ORGANIC", ...AUG }));

    expect(params.get("origin")).toBe("ORGANIC");
    expect(params.has("stage")).toBe(false);
  });

  it("omits the origin key entirely when only a stage is cut on", () => {
    const params = paramsOf(inboxDrillLink({ stage: "novosContatos", ...AUG }));

    expect(params.get("stage")).toBe("novosContatos");
    expect(params.has("origin")).toBe(false);
  });

  it("carries the period alone when neither filter is given", () => {
    const params = paramsOf(inboxDrillLink({ ...AUG }));

    expect([...params.keys()]).toEqual(["from", "to"]);
  });

  it("addresses the inbox itself, not a nested route", () => {
    // The reader is the root route (`ConversasPage`), so the path is bare `/`.
    expect(inboxDrillLink({ stage: "servicosFeitos", ...AUG })).toMatch(/^\/\?/);
  });
});

describe("formatPeriodChip", () => {
  it("still shows both ends when the period is a single day", () => {
    // The lower boundary of the period domain: from === to. A chip that
    // collapsed to one end here would read as an open range.
    expect(formatPeriodChip("2026-08-01", "2026-08-01")).toBe("01/08 – 01/08/2026");
  });

  it("reads a within-month period as day/month, day/month/year", () => {
    expect(formatPeriodChip("2026-08-01", "2026-08-28")).toBe("01/08 – 28/08/2026");
  });

  it("takes each end's own month rather than repeating the first", () => {
    expect(formatPeriodChip("2026-07-30", "2026-09-02")).toBe("30/07 – 02/09/2026");
  });
});

describe("stage label maps", () => {
  it("keeps Relatórios title case on the two captions the funnel spec pins", () => {
    expect(FUNNEL_STAGE_LABELS.orcamentoEnviado).toBe("Orçamento Enviado");
    expect(FUNNEL_STAGE_LABELS.servicosFeitos).toBe("Serviços Feitos");
  });

  it("keeps thread sentence case on those same two captions", () => {
    expect(THREAD_STAGE_LABELS.orcamentoEnviado).toBe("Orçamento enviado");
    expect(THREAD_STAGE_LABELS.servicosFeitos).toBe("Serviços feitos");
  });
});

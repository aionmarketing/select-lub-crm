/**
 * Test design (testing-strategy) — the Motul adapter's report and its degraded answer (oil-research-web-retrieval D6)
 *
 * SUT: createMotulRetriever with an injected `resolve` (the Oil Advisor call). No socket.
 *
 * Oracle: specs/quotes/motul-client-resilience "A gateway that has been failing for hours is
 * degraded, and no longer makes research incomplete": a degraded Motul's `unavailable` is
 * answered `none`, any answer is reported as an answer, and before degrading an `unavailable`
 * stays an outage.
 *
 * Axes
 *   M1 the Oil Advisor's answer — unavailable / ok / needs (one or several options) / unmatched
 *   M2 degraded — yes / no
 *
 * Sampled cells (one row per `it`)
 *   unavailable, not degraded | M1,M2 | reported \`unavailable\`, answers \`unavailable\`
 *   unavailable, degraded     | M1,M2 | reported \`unavailable\`, answers \`none\`
 *   every other answer        | M1    | reported \`answered\`, whatever the degraded flag; the answers
 *      themselves are unchanged (found / needs_clarification / none)
 *   no report callback        | —     | works as before (the quote-side callers pass none)
 *
 * Out of scope: how the runner stamps or clears the moment (oil-research-runner live suite) and
 * the threshold (runner-row.test.ts).
 */
import { describe, expect, it, vi } from "vitest";
import type { ResolveOilResult } from "../../../../kernel/clients/motul/index.js";
import type { VehicleIdentity } from "../store/store.js";
import { createMotulRetriever, type MotulOutcome } from "./sources.js";

const identity: VehicleIdentity = { make: "Fiat", year: 2021, model: "Argo", version: "1.0 Firefly" };

function motul(answer: ResolveOilResult, options: { degraded?: boolean } = {}) {
  const reports: MotulOutcome[] = [];
  const retrieve = createMotulRetriever({ ...options, report: (outcome) => reports.push(outcome), resolve: vi.fn(async () => answer) });
  return { retrieve, reports };
}

describe("createMotulRetriever", () => {
  it("reports an outage and answers unavailable while Motul is not degraded", async () => {
    const { retrieve, reports } = motul({ status: "unavailable" });

    expect(await retrieve(identity)).toEqual({ status: "unavailable" });
    expect(reports).toEqual(["unavailable"]);
  });

  it("reports an outage and answers none once Motul is degraded", async () => {
    const { retrieve, reports } = motul({ status: "unavailable" }, { degraded: true });

    expect(await retrieve(identity)).toEqual({ status: "none" });
    expect(reports).toEqual(["unavailable"]);
  });

  it.each([false, true])("reports an answer, and changes none of its answers (degraded %s)", async (degraded) => {
    const needsMany = motul({ status: "needs", field: "submodel", options: ["1.0", "1.3"] }, { degraded });
    const needsOne = motul({ status: "needs", field: "submodel", options: ["1.0"] }, { degraded });
    const unmatched = motul({ status: "unmatched", field: "model", options: [] }, { degraded });

    expect(await needsMany.retrieve(identity)).toEqual({ status: "needs_clarification", options: ["1.0", "1.3"] });
    expect(await needsOne.retrieve(identity)).toEqual({ status: "none" });
    expect(await unmatched.retrieve(identity)).toEqual({ status: "none" });
    expect([needsMany.reports, needsOne.reports, unmatched.reports]).toEqual([["answered"], ["answered"], ["answered"]]);
  });

  it("needs no report callback", async () => {
    const retrieve = createMotulRetriever({ resolve: async () => ({ status: "unavailable" }) });

    expect(await retrieve(identity)).toEqual({ status: "unavailable" });
  });
});

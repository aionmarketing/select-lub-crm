/**
 * Test design (testing-strategy)
 *
 * SUT: chainRetrievers (apps/api/src/oil-quote/sources.ts). Adapters are injected fakes;
 * no HTTP, no Motul, no fixture file read.
 *
 * Oracle: oil-quote-liters-pricing D16 — the chain collects every adapter's documents so
 * the pipeline can compare them; prompt.md "a lower-priority source must not silently
 * override a higher-priority source", which is only checkable with both in hand; and
 * "Ambiguous engine is clarification", which no further document can undo.
 *
 * Axes
 *   S1 what each adapter answers — found / none / unavailable / needs_clarification
 *   S2 how many adapters answer found — 0 / 1 / 2
 *
 * Outputs: O1 combined status; O2 the source list, in adapter order; O3 whether later
 *          adapters were still called
 *
 * Sampled cells (one row per `it`)
 *   found + found            | S2 two   | O2 both, first adapter's first |
 *      fails if the chain stops at the first hit — the regression that made conflict
 *      detection dead in practice
 *   found + unavailable      | S1 mixed | O1 found | fails if one adapter being down
 *      hides another's document
 *   none + unavailable       | S1 mixed | O1 unavailable | fails if "down" degrades to
 *      "this car is not covered", which would deny the attendant the previous cache row
 *   none + none              | S2 zero  | O1 none
 *   needs_clarification first| S1       | O1 clarification, O3 second adapter NOT called
 *
 * Out of scope: authority ordering (the pipeline sorts; the chain keeps adapter order);
 * the fixture and Motul adapters themselves (they wrap I/O and are covered by the demo
 * scripts, not by Vitest — D8).
 */
import { describe, expect, it, vi } from "vitest";
import { chainRetrievers, gateWebSearch } from "../retrieval/sources.js";
import type {
  AuthoritativeSourceRetriever,
  RetrieveResult,
  RetrievedSource,
} from "../pipeline/oil-spec.js";
import type { VehicleIdentity } from "../store/store.js";

const identity: VehicleIdentity = { make: "Volkswagen", year: 2021, model: "Polo", version: "1.0 TSI" };

function source(publisher: string, authority: 1 | 2 | 3 | 4 | 5): RetrievedSource {
  return { publisher, document: "doc", page: "p", authority, content: { kind: "text", text: publisher } };
}

const manual = source("Volkswagen do Brasil", 1);
const catalog = source("CarroRac", 5);

function answering(result: Awaited<ReturnType<AuthoritativeSourceRetriever>>) {
  return vi.fn<AuthoritativeSourceRetriever>().mockResolvedValue(result);
}

describe("chainRetrievers", () => {
  it("collects documents from every adapter instead of stopping at the first", async () => {
    const chain = chainRetrievers([
      answering({ status: "found", sources: [catalog] }),
      answering({ status: "found", sources: [manual] }),
    ]);

    const result = await chain(identity);

    expect(result).toEqual({ status: "found", sources: [catalog, manual] });
  });

  it("keeps a document when another adapter was down", async () => {
    const chain = chainRetrievers([
      answering({ status: "unavailable" }),
      answering({ status: "found", sources: [manual] }),
    ]);

    const result = await chain(identity);

    // Kept, and marked incomplete: the adapter that was down left a source unread, which
    // research retries rather than resting on (background-oil-research D10).
    expect(result).toEqual({ status: "found", sources: [manual], incomplete: true });
  });

  it("does not mark a walk incomplete when every adapter answered", async () => {
    const chain = chainRetrievers([answering({ status: "none" }), answering({ status: "found", sources: [manual] })]);

    expect(await chain(identity)).toEqual({ status: "found", sources: [manual] });
  });

  it("reports unavailable, not none, when nothing was found and some adapter was down", async () => {
    const chain = chainRetrievers([
      answering({ status: "none" }),
      answering({ status: "unavailable" }),
    ]);

    expect(await chain(identity)).toEqual({ status: "unavailable" });
  });

  it("reports none when every adapter answered and none held a document", async () => {
    const chain = chainRetrievers([answering({ status: "none" }), answering({ status: "none" })]);

    expect(await chain(identity)).toEqual({ status: "none" });
  });

  it("returns clarification at once and does not consult later adapters", async () => {
    const later = answering({ status: "found", sources: [catalog] });
    const chain = chainRetrievers([
      answering({ status: "needs_clarification", options: ["1.0 TSI", "1.6 MSI"] }),
      later,
    ]);

    const result = await chain(identity);

    expect(result).toEqual({ status: "needs_clarification", options: ["1.0 TSI", "1.6 MSI"] });
    expect(later).not.toHaveBeenCalled();
  });
});

/**
 * Added by web-search-source-adapter task 5.1.
 *
 * Oracle: specs/quotes/oil-spec-web-search/spec.md "Web search runs only when local sources are
 * missing or low-authority", and design D1 — the gate is what keeps prompt.md's "not on
 * every request" true while still letting a manufacturer page outrank a catalog.
 *
 * Axes
 *   G1 best local tier — 1 / 3 / 5 / none at all
 *   G2 local status — found / none / unavailable / needs_clarification
 *   G3 web result — found / none
 *
 * Outputs: O1 whether the web adapter was called; O2 the merged sources; O3 the status
 *
 * Sampled cells (one row per `it`)
 *   local tier 1        | G1 | O1 not called — the hierarchy already has its best answer
 *   local tier 3        | G1 | O1 not called — the boundary, and it is inclusive
 *   local tier 5        | G1 | O1 called, O2 both. The case the owner asked for: the catalog
 *      becomes a fallback rather than a ceiling
 *   no local            | G1 | O1 called
 *   local unavailable   | G2 | O3 unavailable when the web also finds nothing, so the dialog
 *      can still offer the previous row rather than claim the car is uncovered
 *   clarification local | G2 | O1 not called — more documents cannot disambiguate an engine
 */
describe("gateWebSearch", () => {
  const webSource: RetrievedSource = {
    publisher: "honda.com.br",
    document: "Manual",
    page: "Capacidades",
    authority: 1,
    url: "https://honda.com.br/manual",
    content: { kind: "text", text: "0W-20 — 3,7 L" },
  };

  function localOf(result: Awaited<ReturnType<AuthoritativeSourceRetriever>>) {
    return vi.fn<AuthoritativeSourceRetriever>().mockResolvedValue(result);
  }

  function tiered(authority: 1 | 2 | 3 | 4 | 5): RetrievedSource {
    return { ...source("local", authority) };
  }

  // 1 is a manufacturer manual; 3 is the inclusive boundary — good enough, so no search.
  it.each([1, 3] as const)("does not search when the best local source is tier %i", async (tier) => {
    const web = vi.fn<AuthoritativeSourceRetriever>();
    const gated = gateWebSearch(
      localOf({ status: "found", sources: [tiered(tier)] }),
      web,
    );

    const result = await gated(identity);

    expect(web).not.toHaveBeenCalled();
    expect(result.status).toBe("found");
  });

  it("searches when the best local source is only a catalog, and merges both", async () => {
    const web = localOf({ status: "found", sources: [webSource] });
    const gated = gateWebSearch(localOf({ status: "found", sources: [tiered(5)] }), web);

    const result = await gated(identity);

    expect(web).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("found");
    if (result.status !== "found") throw new Error("expected found");
    expect(result.sources.map((s) => s.authority).sort()).toEqual([1, 5]);
  });

  it("searches when there is no local source at all", async () => {
    const web = localOf({ status: "found", sources: [webSource] });
    const gated = gateWebSearch(localOf({ status: "none" }), web);

    const result = await gated(identity);

    expect(web).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("found");
  });

  it("keeps unavailable when the locals were down and the web found nothing", async () => {
    const gated = gateWebSearch(localOf({ status: "unavailable" }), localOf({ status: "none" }));

    // Only `unavailable` may offer the previous cache row; degrading it to `none` would tell
    // the attendant the car is uncovered when the truth is that a lookup failed.
    expect(await gated(identity)).toEqual({ status: "unavailable" });
  });

  it("does not search when the locals asked for clarification", async () => {
    const web = vi.fn<AuthoritativeSourceRetriever>();
    const gated = gateWebSearch(
      localOf({ status: "needs_clarification", options: ["1.8 16V", "1.5 Turbo"] }),
      web,
    );

    const result = await gated(identity);

    expect(web).not.toHaveBeenCalled();
    expect(result.status).toBe("needs_clarification");
  });

  /*
   * What research reads beside the sources (background-oil-research D10): `incomplete` when a
   * source was left unread — a page the search admitted and could not read, the provider down
   * while a local source answered, a local adapter down — and `notSearched` when the web did not
   * run at all. Neither when the search completed.
   */
  it("marks a search that left an admitted page unread incomplete, with nothing found", async () => {
    const result = await gateWebSearch(localOf({ status: "none" }), localOf({ status: "none", unreadAdmitted: 1 }))(identity);

    expect(result).toEqual({ status: "none", incomplete: true });
  });

  it("marks the provider's outage incomplete when a local source still answered", async () => {
    const result = await gateWebSearch(localOf({ status: "found", sources: [tiered(4)] }), localOf({ status: "unavailable" }))(identity);

    expect(result).toMatchObject({ status: "found", incomplete: true });
  });

  it("carries a local adapter's outage through the search", async () => {
    const web = localOf({ status: "found", sources: [webSource] });
    const result = await gateWebSearch(localOf({ status: "found", sources: [tiered(4)], incomplete: true }), web)(identity);

    expect(result).toMatchObject({ status: "found", incomplete: true });
  });

  it("says the web did not search, and is not incomplete for it", async () => {
    const result = await gateWebSearch(localOf({ status: "none" }), localOf({ status: "none", notSearched: true }))(identity);

    expect(result).toEqual({ status: "none", notSearched: true });
  });

  it("marks nothing when the search completed", async () => {
    const result = await gateWebSearch(localOf({ status: "found", sources: [tiered(4)] }), localOf({ status: "found", sources: [webSource] }))(identity);

    expect(result).not.toHaveProperty("incomplete");
    expect(result).not.toHaveProperty("notSearched");
  });

  it("carries manual candidates from the web up to the caller", async () => {
    const web = localOf({
      status: "none",
      manualCandidates: [
        {
          url: "https://honda.com.br/manual.pdf",
          publisher: "honda.com.br",
          classification: "manufacturer_manual" as const,
          tier: 1 as const,
        },
      ],
    });
    const gated = gateWebSearch(localOf({ status: "none" }), web);

    const result = await gated(identity);

    expect(result.status).toBe("none");
    if (result.status !== "none") throw new Error("expected none");
    expect(result.manualCandidates).toHaveLength(1);
  });

  /**
   * Added by oil-quote-retrieval-hardening task 3.1.
   *
   * SUT: `gateWebSearch`'s negative cache. The miss port and the clock are injected fakes.
   *
   * Oracle: specs/quotes/oil-spec-web-search/spec.md "A miss is not searched again within a window" —
   * a remembered miss suppresses a new search, an explicit refetch searches regardless, the
   * window expires, and the miss never becomes a cache row or changes the quote's status.
   *
   * Axes
   *   N1 remembered miss — none / fresh / expired
   *   N2 caller's intent — ordinary quote / explicit refetch
   *   N3 what the web returns — sources / nothing
   *   N4 the local result the miss must not alter — found tier 5 / unavailable / none
   *
   * Outputs: O1 whether the web adapter was called; O2 the result handed back; O3 whether a
   *          miss was recorded
   *
   * Sampled cells (one row per `it`)
   *   fresh miss                  | N1,N4 | O1 web NEVER called, O2 the local result unchanged
   *      | THE case: every quote for a car the fixtures miss was re-buying the same empty search
   *   fresh miss + refetch        | N1,N2 | O1 web called — the attendant re-asked, so the
   *      remembered absence must not answer for them
   *   expired miss                | N1    | O1 web called
   *   no miss recorded            | N1    | O1 web called
   *   web finds nothing           | N3    | O3 a miss is recorded, with the identity and a reason
   *   web finds something         | N3    | O3 nothing recorded — there was no absence
   *   miss with unavailable local | N4    | O2 still `unavailable`, not `none`: the status the
   *      dialog uses to offer the previous row must survive the shortcut
   *   no miss port                | —     | O1 web called; a store-less retriever still works
   *
   * Decision map of the miss branch
   *   misses && !forceWebSearch   both: fresh-miss test vs refetch test and no-port test
   *   remembered && missIsFresh   both: fresh-miss test vs expired-miss test
   *   webSources.length === 0     both: web-finds-nothing vs web-finds-something
   */
  describe("gateWebSearch — a miss is not searched twice", () => {
    const CLOCK = Date.parse("2026-09-14T12:00:00.000Z");

    /** A miss port that starts with `existing` and records what it is told. */
    function missPort(existing: { searchedAt: string } | null) {
      const recorded: Array<{ reason: string; make: string }> = [];
      return {
        recorded,
        port: {
          latestSearchMiss: async () => existing,
          recordSearchMiss: async (row: { reason: string; make: string }) => {
            recorded.push(row);
            return row;
          },
        },
      };
    }

    const hoursAgo = (h: number) => new Date(CLOCK - h * 3_600_000).toISOString();

    it("does not call the web adapter while a miss is fresh", async () => {
      const web = vi.fn<AuthoritativeSourceRetriever>();
      const { port } = missPort({ searchedAt: hoursAgo(1) });
      const localResult: RetrieveResult = { status: "found", sources: [tiered(5)] };

      const result = await gateWebSearch(localOf(localResult), web, port, () => CLOCK)(identity);

      expect(web).not.toHaveBeenCalled();
      expect(result).toEqual(localResult);
    });

    it("searches anyway when the attendant explicitly refetches", async () => {
      const web = localOf({ status: "none" });
      const webSpy = vi.fn<AuthoritativeSourceRetriever>(web);
      const { port } = missPort({ searchedAt: hoursAgo(1) });

      await gateWebSearch(localOf({ status: "found", sources: [tiered(5)] }), webSpy, port, () => CLOCK)(
        identity,
        { forceWebSearch: true },
      );

      expect(webSpy).toHaveBeenCalled();
    });

    it("searches again once the window has passed", async () => {
      const webSpy = vi.fn<AuthoritativeSourceRetriever>(localOf({ status: "none" }));
      const { port } = missPort({ searchedAt: hoursAgo(200) });

      await gateWebSearch(localOf({ status: "found", sources: [tiered(5)] }), webSpy, port, () => CLOCK)(identity);

      expect(webSpy).toHaveBeenCalled();
    });

    it("searches when nothing was ever remembered", async () => {
      const webSpy = vi.fn<AuthoritativeSourceRetriever>(localOf({ status: "none" }));
      const { port } = missPort(null);

      await gateWebSearch(localOf({ status: "found", sources: [tiered(5)] }), webSpy, port, () => CLOCK)(identity);

      expect(webSpy).toHaveBeenCalled();
    });

    it("records the absence when the search finds nothing", async () => {
      const { port, recorded } = missPort(null);

      await gateWebSearch(localOf({ status: "found", sources: [tiered(5)] }), localOf({ status: "none" }), port, () => CLOCK)(
        identity,
      );

      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({ make: identity.make });
      expect(recorded[0]!.reason).toBeTruthy();
    });

    it("records nothing when the search found a source", async () => {
      const { port, recorded } = missPort(null);

      await gateWebSearch(
        localOf({ status: "found", sources: [tiered(5)] }),
        localOf({ status: "found", sources: [webSource] }),
        port,
        () => CLOCK,
      )(identity);

      expect(recorded).toEqual([]);
    });

    it("keeps an unavailable local result unavailable when it skips the search", async () => {
      // `unavailable` is what lets the dialog offer the previous cache row; collapsing it to
      // `none` would tell the attendant the car has no data rather than that Motul is down.
      const { port } = missPort({ searchedAt: hoursAgo(1) });

      const result = await gateWebSearch(localOf({ status: "unavailable" }), vi.fn(), port, () => CLOCK)(identity);

      expect(result.status).toBe("unavailable");
    });

    it("works with no miss port at all", async () => {
      const webSpy = vi.fn<AuthoritativeSourceRetriever>(localOf({ status: "none" }));

      await gateWebSearch(localOf({ status: "found", sources: [tiered(5)] }), webSpy)(identity);

      expect(webSpy).toHaveBeenCalled();
    });
  });
});

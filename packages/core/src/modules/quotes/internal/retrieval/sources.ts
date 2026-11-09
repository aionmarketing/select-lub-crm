/**
 * Retrieval adapters for the grounded oil-spec pipeline (oil-quote-liters-pricing D10, D11).
 *
 * Each adapter answers one question: "do you hold a citable document about this exact
 * vehicle?" None of them searches the open web per quote, and none of them decides which
 * oil to sell. They are tried in the source hierarchy's order, so an owner-manual-grade
 * ingested passage outranks a lubricant-manufacturer application guide.
 */
import { createStoredManualRetriever, type ManualReadingPort } from "./stored-manuals.js";
import { motulIdentitiesMatch, resolveOil } from "../../../../kernel/clients/motul/index.js";
import { oilSourceFixtures } from "@select-lub/core/db";
import type { OilSourceFixture } from "@select-lub/core/db";
import { createWebSearchRetriever } from "./web-search.js";
import { createModelDocumentLinkSelector } from "./document-links.js";
import type { AuthoritativeSourceRetriever, RetrieveResult, RetrievedSource } from "../pipeline/oil-spec.js";
import type { VehicleIdentity } from "../store/store.js";

/**
 * Ingested-passage adapter: the committed fixtures, matched on the cache's identity rule.
 *
 * Offline by construction, which is what lets `db:seed` and the whole test suite reproduce a
 * real quote without a network.
 *
 * @param fixtures - Ingested sources; defaults to the committed set.
 * @returns A retriever answering `found` or `none`, never `unavailable` (a local file
 * cannot be "down", so a miss here must not suppress the adapters below it).
 */
export function createFixtureRetriever(
  fixtures: OilSourceFixture[] = oilSourceFixtures(),
): AuthoritativeSourceRetriever {
  return async (identity: VehicleIdentity) => {
    const matches = fixtures.filter((fixture) =>
      motulIdentitiesMatch(
        {
          make: fixture.make,
          year: fixture.year,
          model: fixture.model,
          version: fixture.version,
        },
        identity,
      ),
    );
    if (matches.length === 0) {
      return { status: "none" };
    }
    return {
      status: "found",
      sources: matches.map(
        (fixture): RetrievedSource => ({
          publisher: fixture.publisher,
          document: fixture.document,
          page: fixture.page,
          authority: fixture.authority,
          url: fixture.url,
          content: { kind: "text", text: fixture.excerpt },
        }),
      ),
    };
  };
}

/** Whether the Motul Oil Advisor answered a call (any answer, "not covered" included) or was down. */
export type MotulOutcome = "unavailable" | "answered";

/** What the Motul adapter is told about the run it serves (oil-research-web-retrieval D6). */
export type MotulRetrieverOptions = {
  degraded?: boolean;
  report?: (outcome: MotulOutcome) => void;
  /** The Oil Advisor call; injected so a test never reaches Motul. Defaults to the real client. */
  resolve?: typeof resolveOil;
};

/**
 * Motul Oil Advisor adapter: the flattened recommendation, offered as a document to read.
 *
 * Motul sits at the application-guide tier of the hierarchy, below owner manuals. What is
 * returned here is a payload to extract grades and motor liters from — deliberately not the
 * list of products the workshop should quote.
 *
 * @param options.report - Told whether Motul answered or was unavailable, for the research runner
 * to stamp or clear the moment it began failing (oil-research-web-retrieval D6).
 * @param options.resolve - The Oil Advisor call; tests inject one.
 * @param options.degraded - Motul has been failing for hours: its `unavailable` is then answered
 * `none`, so the run stays complete instead of being retried for an outage that is not passing.
 * @returns A retriever answering `found`, `needs_clarification` when Motul matched more than
 * one submodel, `none` when Motul does not cover the car, or `unavailable` on a gateway
 * failure such as the HTTP 500 the Oil Advisor front door has been returning.
 */
export function createMotulRetriever(options: MotulRetrieverOptions = {}): AuthoritativeSourceRetriever {
  return async (identity: VehicleIdentity): Promise<RetrieveResult> => {
    const result = await (options.resolve ?? resolveOil)({
      brand: identity.make,
      year: String(identity.year),
      model: identity.model,
      submodel: identity.version,
    });
    options.report?.(result.status === "unavailable" ? "unavailable" : "answered");
    if (result.status === "unavailable") {
      return options.degraded ? { status: "none" } : { status: "unavailable" };
    }
    if (result.status === "needs") {
      const options = result.options ?? [];
      return options.length > 1
        ? { status: "needs_clarification", options }
        : { status: "none" };
    }
    if (result.status !== "ok") {
      return { status: "none" };
    }
    return {
      status: "found",
      sources: [
        {
          publisher: "Motul",
          document: "Oil Advisor — guia de aplicação",
          page: result.recommendation.vehicle,
          // Tier 4: a lubricant manufacturer's application guide, below any owner manual.
          authority: 4,
          content: { kind: "motul_flatten", recommendation: result.recommendation },
        },
      ],
    };
  };
}

/**
 * Runs every adapter and returns all the documents they hold, together.
 *
 * It does not stop at the first hit. Stopping would make conflict detection dead in
 * practice — a tier-5 catalog and a tier-4 application guide would never be read side by
 * side — and prompt.md asks that a lower-priority source not silently override a higher
 * one, which needs both in hand to judge. The pipeline then orders by authority.
 *
 * `needs_clarification` from any adapter returns at once: an ambiguous car is not made less
 * ambiguous by more documents. An adapter being down does not end the walk, but if every
 * adapter was down the result is `unavailable` rather than `none`, so the dialog can offer
 * the previous cache row instead of claiming the car is uncovered.
 *
 * @param adapters - Retrievers, highest authority first (order is kept, then re-sorted by
 * each source's own tier in the pipeline).
 * @returns One combined retriever.
 */
export function chainRetrievers(
  adapters: AuthoritativeSourceRetriever[],
): AuthoritativeSourceRetriever {
  return async (identity) => {
    const sources: RetrievedSource[] = [];
    let sawUnavailable = false;
    for (const adapter of adapters) {
      const result = await adapter(identity);
      if (result.status === "needs_clarification") {
        return result;
      }
      if (result.status === "found") {
        sources.push(...result.sources);
      } else if (result.status === "unavailable") {
        sawUnavailable = true;
      }
    }
    if (sources.length > 0) {
      // An adapter that was down left a source unread: research retries it (D10).
      return { status: "found", sources, ...(sawUnavailable ? { incomplete: true as const } : {}) };
    }
    return sawUnavailable ? { status: "unavailable" } : { status: "none" };
  };
}

/** The tier at or above which local sources are good enough to skip the web (D1). */
export const LOCAL_GOOD_ENOUGH_TIER = 3;

/**
 * Runs the local adapters, then the web adapter only when the locals left something to gain.
 *
 * The gate is the whole point of D1: searching on every miss is what `prompt.md` forbids,
 * and never searching leaves the aftermarket catalog as a ceiling. So the web runs when the
 * best local source is tier 4-5, or when there is none at all — and does not run when a
 * manual-grade source already answered.
 *
 * Both sets are merged into one `found`, so the authority ordering, conflict detection and
 * escalation that already exist treat a web page and a fixture identically.
 *
 * @param local - The local adapters, highest authority first.
 * @param web - The web adapter.
 * @returns One retriever for `loadQuoteOptions`.
 */
export const WEB_SEARCH_DEFAULT_MISS_TTL_HOURS = 168;

/**
 * The miss reason when the search found pages and none verified a spec. Recorded by the
 * quote, not the gate, because verifying happens after retrieval (owner, 2026-09-25).
 */
export const UNVERIFIED_SEARCH_REASON = "fontes encontradas na busca, nenhuma verificada";

/**
 * What the gate needs from the store to avoid buying the same empty search twice.
 *
 * A narrow port rather than the whole `OilQuoteStore`: the retrieval layer has no business
 * reading the spec cache, and a miss is emphatically not one — it records an absence, and
 * offering it to an attendant as a previous result is the one thing it must never do.
 */
export type SearchMissPort = {
  latestSearchMiss(identity: VehicleIdentity): Promise<{ searchedAt: string } | null>;
  recordSearchMiss(row: {
    make: string;
    year: number;
    model: string;
    version: string;
    reason: string;
    searchedAt: string;
  }): Promise<unknown>;
};

/** Hours a remembered miss suppresses a new search for the same identity. */
export function missTtlHours(): number {
  const raw = Number(process.env.WEB_SEARCH_MISS_TTL_HOURS);
  return Number.isFinite(raw) && raw >= 0 ? raw : WEB_SEARCH_DEFAULT_MISS_TTL_HOURS;
}

/**
 * Whether a remembered miss is still young enough to speak for the present.
 *
 * @param searchedAt - When the empty search happened, ISO.
 * @param now - Milliseconds since the epoch.
 */
export function missIsFresh(searchedAt: string, now: number): boolean {
  const at = Date.parse(searchedAt);
  if (!Number.isFinite(at)) {
    return false;
  }
  return now - at < missTtlHours() * 3_600_000;
}

export function gateWebSearch(
  local: AuthoritativeSourceRetriever,
  web: AuthoritativeSourceRetriever,
  misses?: SearchMissPort,
  now: () => number = () => Date.now(),
): AuthoritativeSourceRetriever {
  return async (identity, options) => {
    const localResult = await local(identity);

    // An ambiguous car is not made less ambiguous by more documents.
    if (localResult.status === "needs_clarification") {
      return localResult;
    }

    const localSources = localResult.status === "found" ? localResult.sources : [];
    // A source that says it must not spare the search does not count toward "good enough".
    const bestLocalTier = localSources.reduce<number | null>(
      (best, source) =>
        source.sparesWebSearch !== false && source.authority != null && (best == null || source.authority < best)
          ? source.authority
          : best,
      null,
    );
    if (bestLocalTier != null && bestLocalTier <= LOCAL_GOOD_ENOUGH_TIER) {
      return localResult;
    }

    // A car the web had nothing on an hour ago still has nothing on it. Every quote for a
    // vehicle the fixtures miss was buying the same empty search again — the search costs
    // the same whether it finds a manual or a marketplace.
    if (misses && !options?.forceWebSearch) {
      const remembered = await misses.latestSearchMiss(identity);
      if (remembered && missIsFresh(remembered.searchedAt, now())) {
        return localResult;
      }
    }

    const webResult = await web(identity, options);
    if (webResult.status === "needs_clarification") {
      return webResult;
    }
    const webSources = webResult.status === "found" ? webResult.sources : [];
    const manualCandidates = [
      ...(localResult.status === "found" || localResult.status === "none"
        ? (localResult.manualCandidates ?? [])
        : []),
      ...(webResult.manualCandidates ?? []),
    ];

    // Complete: the search ran and every page it admitted was read. Only a complete search
    // is evidence of absence; an outage, "not searched", or a page left unread is not
    // (review of #176, 2026-09-25).
    const searchedAt = new Date(now()).toISOString();
    const webComplete =
      webResult.status === "found"
        ? !webResult.unreadAdmitted
        : webResult.status === "none" && !webResult.notSearched && !webResult.unreadAdmitted;
    if (misses && webSources.length === 0 && webComplete) {
      // Remember the absence, not the outcome: the quote still reports whatever the local
      // sources allow, and this row is never offered as a previous result.
      await misses.recordSearchMiss({ ...identity, reason: "nenhuma fonte admitida na busca", searchedAt });
    }

    const sources = [...localSources, ...webSources];
    // What research needs beside the sources (D10): something left unread — a local adapter
    // down, the provider down, a page unread — and whether the web did not search at all.
    const localIncomplete = localResult.status === "unavailable" || (localResult.status === "found" && localResult.incomplete === true);
    const webNotSearched = webResult.status === "none" && webResult.notSearched === true;
    const webIncomplete = webResult.status === "unavailable" || (!webComplete && !webNotSearched);
    const flags = {
      ...(localIncomplete || webIncomplete ? { incomplete: true as const } : {}),
      ...(webNotSearched ? { notSearched: true as const } : {}),
    };
    if (sources.length > 0) {
      return {
        status: "found",
        sources,
        ...flags,
        ...(manualCandidates.length > 0 ? { manualCandidates } : {}),
        // What the web found and whether the search was complete, so a quote that verifies
        // none of it can be remembered as a miss too, at this clock's time; the gate cannot,
        // since verifying comes after it.
        ...(webResult.status === "found" || webResult.status === "none"
          ? { webSearch: { sources: webSources.length, complete: webComplete, searchedAt } }
          : {}),
      };
    }
    // Nothing found anywhere: an adapter that was DOWN still outranks "not covered", because
    // only `unavailable` may offer the attendant the previous cache row. The search provider
    // counts as an adapter here: its outage is not "the web has nothing".
    if (localResult.status === "unavailable" || webResult.status === "unavailable") {
      // The leads the web found survive the outage (oil-research-web-retrieval D4).
      return manualCandidates.length > 0 ? { status: "unavailable", manualCandidates } : { status: "unavailable" };
    }
    return { status: "none", ...flags, ...(manualCandidates.length > 0 ? { manualCandidates } : {}) };
  };
}

/**
 * The production retriever: ingested passages, the stored manual readings, then Motul Oil
 * Advisor, then — when those left something to gain — a web search. A verified manual reading
 * is tier 1 or 2, so on its own it spares the quote the paid search.
 *
 * @param store - The search-miss port, and the manual readings when the caller has them.
 * @returns A retriever suitable for `loadQuoteOptions`.
 */
export function createProductionRetriever(store?: SearchMissPort & Partial<ManualReadingPort>): AuthoritativeSourceRetriever {
  const manuals = store?.listManualReadings ? [createStoredManualRetriever(store as ManualReadingPort)] : [];
  return gateWebSearch(
    chainRetrievers([createFixtureRetriever(), ...manuals, createMotulRetriever()]),
    createWebSearchRetriever({ selectLinks: createModelDocumentLinkSelector() }),
    store,
  );
}

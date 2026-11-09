/**
 * The web source adapter (web-search-source-adapter D2, D3, D5, D7, D10).
 *
 * A model searches; it does not read. Its whole output is a list of candidate URLs, each
 * with a document class and a one-line reason. Everything after that is code: the blocklist
 * and the class→tier map decide admission, the fetcher decides what can be read, and the
 * existing extractor decides what the page says. The model never sees a tier and never hands
 * us page content we then trust.
 *
 * One model, one pass. The research model (`gpt-6.1-sol`) both searches here and extracts in
 * `spec-extractor.ts` — prompt.md's routing puts "tool use and extraction" on the same model —
 * but they stay separate calls with OUR fetch in between, because that fetch is what honours `robots.txt` under our
 * own identity, refuses PDFs into the manual-candidate trail, and produces a passage we can
 * store and re-verify. Owner decision 2026-09-10 removed the second, stronger search pass:
 * across every working showcase run it accepted zero sources.
 */
import { admitCandidate, type SearchCandidate } from "./admit.js";
import { fetchPage, PAGE_FETCH_TIMEOUT_MS, type FetchRefusal, type FetchTransport } from "./page-fetcher.js";
import { chooseDocumentLinks, type DocumentLinkSelector } from "./document-links.js";
import { costUsdOf, type TokenUsage } from "./search-cost.js";
import { buildManualQuery, buildSearchQuery, pageKey } from "./search-hits.js";
import { createOpenAISearch } from "./openai-search.js";
import type { SearchFn } from "./search-fn.js";
import { limitsFor } from "../model-calls/limits.js";
import { researchModel } from "../model-calls/research-model.js";
import { concernsModel, namesModel } from "../model-named.js";
import type { UsageMeter } from "../model-calls/meter.js";
import type {
  AuthoritativeSourceRetriever,
  ManualCandidate,
  RetrieveResult,
  RetrievedSource,
} from "../pipeline/oil-spec.js";
import type { VehicleIdentity } from "../store/store.js";
import { webSearchAvailable } from "./search-availability.js";

/**
 * Pages whose body may be READ per quote.
 *
 * The expensive budget: a read costs a fetch, an HTML reduction, a passage-selection call
 * and a slice of the extractor's prompt. `WEB_SEARCH_MAX_FETCHES` keeps its name so an
 * existing deployment's env still means what it meant.
 */
export const WEB_SEARCH_DEFAULT_MAX_READS = 3;

/**
 * URLs that may be ATTEMPTED per quote, whether or not a body comes back.
 *
 * A 404, a network refusal, a robots disallow and a PDF refusal each cost one round trip and
 * must not spend a read. Measured 2026-09-14: three dead URLs exhausted a three-fetch budget
 * on the Polo and left a real page untried. This is the loop's own bound, so a search that
 * returns fifty corpses still stops.
 */
export const WEB_SEARCH_DEFAULT_MAX_ATTEMPTS = 8;

/**
 * Wall-clock budget for the whole adapter: `WEB_SEARCH_TIMEOUT_MS`, else the web wall clock of
 * the research model's (model, effort) row in the limits table — 300 s, up from the old 60 s,
 * because the classification reasons at the configured effort (background-oil-research D2).
 * It is enforced ON every call, as their outer signal, not merely read before them.
 *
 * @param model - The search model.
 */
export function webSearchTimeoutMs(model: string): number {
  return limitsFor(model).webMs;
}

/** One pass's worth of what happened, for the D10 log. */
export type SearchPassLog = {
  model: string;
  query: string;
  candidates: Array<{
    url: string;
    classification: string;
    reason: string;
    tier: number | null;
    outcome: string;
  }>;
};

/** What the adapter did for one quote. */
export type WebSearchLog = {
  identity: string;
  passes: SearchPassLog[];
  fetched: number;
  bytes: number;
  elapsedMs: number;
  manualCandidates: number;
  /** Present only for the real provider; injected fakes report none. */
  usage?: TokenUsage;
  /**
   * Billable web-search tool calls, as reported by the provider — two per search since the
   * manual query was added; zero for an injected fake, which bills nothing.
   */
  searchCalls: number;
  /** What this search cost at the configured list prices, USD. */
  costUsd: number;
  /**
   * False when the provider reported no token usage.
   *
   * Without it a `costUsd` of 0.02 reads as a cheap search rather than as the tool fee with
   * the tokens unaccounted for, and summing a month of logs would quietly understate spend.
   */
  usageKnown: boolean;
};

/** Ports injected so tests exercise every path without a socket (D9). */
export type WebSearchDeps = {
  /**
   * Runs one search and returns the model's candidates.
   *
   * `budgetMs` is what remains of the wall clock, and the signal its abort. An implementation
   * MUST NOT outlive them — see {@link webSearchTimeoutMs}.
   */
  search?: SearchFn;
  /** Where the provider search reports each request (D3); the runner passes one per run. */
  meter?: UsageMeter;
  /** An outer bound on the whole search (the research run's signal, from PR 3). */
  signal?: AbortSignal;
  transport?: FetchTransport;
  /**
   * How the MODEL calls are made (distinct from `transport`, which fetches pages).
   *
   * Injected so a test can drive the rate-limit retry without a socket, per D9.
   */
  httpFetch?: typeof fetch;
  /** Sleeps between the rate-limited call and its retry; a test passes a no-op. */
  wait?: (ms: number) => Promise<void>;
  log?: (entry: WebSearchLog) => void;
  now?: () => number;
  /**
   * Ranks an over-cap gateway page's documents (D8). Absent — as in every test — the page's
   * own order decides; production passes the model selector (`createProductionRetriever`).
   */
  selectLinks?: DocumentLinkSelector;
};

function envInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/** An admitted candidate: what `admitCandidate` returns once it has said yes. */
type AdmittedCandidate = Extract<ReturnType<typeof admitCandidate>, { admitted: true }>;

/**
 * Orders admitted candidates by tier, keeping the search's own order within a tier.
 *
 * The budget is spent top-down, so this decides which sources a quote can afford. Measured
 * 2026-09-14: in the tool's order the vehicle query's parts shops came first and the
 * manufacturer PDF the manual query found was never attempted.
 *
 * @param admitted - Candidates in the order the search returned them.
 * @returns A new array, tier 1 first; ties keep their original order.
 */
export function byTier(admitted: readonly AdmittedCandidate[]): AdmittedCandidate[] {
  return admitted
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => a.candidate.tier - b.candidate.tier || a.index - b.index)
    .map((entry) => entry.candidate);
}

/**
 * Creates the web source adapter.
 *
 * @param deps - Injected search, transport, log and clock. Production defaults use the
 * provider's web-search tool and global `fetch`.
 * @returns A retriever answering `found` with the accepted pages, or `none` when the search
 * completed and admitted nothing readable — each with `unreadAdmitted` when an admitted page
 * was left unread (a status, robots, a network failure, or the budget). `none` with
 * `notSearched` when it did not search at all (disabled, or no key). `unavailable` only when
 * the search itself failed: an outage is not an empty web, and only an empty web may be
 * remembered as a miss (review of #176, 2026-09-25).
 */
export function createWebSearchRetriever(deps: WebSearchDeps = {}): AuthoritativeSourceRetriever {
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? ((entry: WebSearchLog) => console.info("web-search", JSON.stringify(entry)));

  return async (identity: VehicleIdentity): Promise<RetrieveResult> => {
    // Not searching is not a search that found nothing: neither may be remembered as a miss.
    if (process.env.WEB_SEARCH_ENABLED === "false" || (!deps.search && !webSearchAvailable())) {
      return { status: "none", notSearched: true };
    }

    let searchCalls = 0;
    let usage: TokenUsage | undefined;
    const addUsage = (spent: TokenUsage) => {
      usage = {
        input: (usage?.input ?? 0) + spent.input,
        cachedInput: (usage?.cachedInput ?? 0) + spent.cachedInput,
        reasoning: (usage?.reasoning ?? 0) + spent.reasoning,
        output: (usage?.output ?? 0) + spent.output,
      };
    };

    const maxReads = envInt("WEB_SEARCH_MAX_FETCHES", WEB_SEARCH_DEFAULT_MAX_READS);
    const maxAttempts = envInt("WEB_SEARCH_MAX_ATTEMPTS", WEB_SEARCH_DEFAULT_MAX_ATTEMPTS);
    // The research model itself, so the log's `passes[].model` names what actually searched
    // (a stale GLM label survived the 2026-10-12 benchmark's first log).
    const configured = researchModel();
    const searchModel = configured.model;
    const timeoutMs = webSearchTimeoutMs(searchModel);

    // Built per quote so the provider can report that quote's own token spend.
    const search =
      deps.search ??
      createOpenAISearch({
        model: searchModel,
        effort: configured.effort,
        meter: deps.meter,
        onUsage: addUsage,
        onToolCall: () => {
          searchCalls += 1;
        },
        httpFetch: deps.httpFetch,
        wait: deps.wait,
      });

    const started = now();
    // The budget as a signal, so every call inside the search is aborted when it runs out (D2).
    const budget = new AbortController();
    const budgetTimer = setTimeout(() => budget.abort(new DOMException("web search budget spent", "TimeoutError")), timeoutMs);
    const signal = deps.signal ? AbortSignal.any([budget.signal, deps.signal]) : budget.signal;
    const query = buildSearchQuery(identity);
    const manualQuery = buildManualQuery(identity);
    const identityWords = [identity.make, identity.model, String(identity.year), identity.version]
      .join(" ")
      .split(/[\s.]+/)
      .filter((word) => word.length > 2);
    const passes: SearchPassLog[] = [];
    const sources: RetrievedSource[] = [];
    const manualCandidates: ManualCandidate[] = [];
    let reads = 0;
    let attempts = 0;
    /** Admitted URLs left unread — a failure or the budget. Any one means no miss. */
    let unreadAdmitted = 0;
    let searchFailed = false;
    let bytes = 0;
    const seenPages = new Set<string>();
    /** Pages whose body was read, by the URL that answered: a redirect can make two results one page. */
    const readPages = new Set<string>();

    const outOfTime = () => now() - started >= timeoutMs;

    /** Runs one pass and appends whatever it accepted. */
    async function runPass(model: string): Promise<void> {
      // One pass, so the only way not to search is the kill switch or a spent clock.
      if (outOfTime()) {
        return;
      }
      let candidates: SearchCandidate[];
      try {
        candidates = await search(model, query, timeoutMs - (now() - started), manualQuery, signal);
      } catch (err) {
        // The provider or its tool failed: an outage, answered `unavailable` below.
        console.error("web-search: search unavailable", err);
        searchFailed = true;
        return;
      }
      const passLog: SearchPassLog = { model, query, candidates: [] };
      /** One admitted candidate's line in the pass log. */
      const note = (verdict: AdmittedCandidate, outcome: string, url = verdict.url) =>
        passLog.candidates.push({ url, classification: verdict.classification, reason: verdict.reason, tier: verdict.tier, outcome });

      // Admit everything FIRST, then order by tier. Measured 2026-09-14: with two queries,
      // the vehicle query's parts shops and blogs arrive before the manual query's
      // manufacturer pages, and on the HR-V a network refusal and a 404 among them spent the
      // budget before the real honda.com.br owner-manual PDF was ever attempted. Reading in
      // the tool's order means the cheapest source wins the budget by accident of ranking.
      const admitted: AdmittedCandidate[] = [];
      for (const candidate of candidates) {
        const verdict = admitCandidate(candidate);
        if (!verdict.admitted) {
          passLog.candidates.push({
            url: verdict.url,
            classification: candidate.classification ?? "none",
            reason: candidate.reason ?? "",
            tier: null,
            outcome: `rejected: ${verdict.rejection}`,
          });
          continue;
        }

        const key = pageKey(verdict.url);
        if (seenPages.has(key)) {
          note(verdict, "skipped: same page already seen");
          continue;
        }
        seenPages.add(key);
        admitted.push(verdict);
      }

      for (const verdict of byTier(admitted)) {
        // Two budgets, not one. A URL that dies before its body is read costs one round trip;
        // a page that is read costs a fetch, a text reduction and a slice of the prompt. The
        // read cap is the expensive one and a 404 must not spend it — measured, three dead
        // URLs used to exhaust a three-fetch budget and leave real pages untried.
        if (reads >= maxReads || attempts >= maxAttempts || outOfTime()) {
          // Say WHICH limit stopped it. Someone reading this log to tune the budget will
          // raise the wrong number otherwise — the failure modes look identical.
          const why =
            reads >= maxReads
              ? "read cap reached"
              : attempts >= maxAttempts
                ? "attempt cap reached"
                : "out of time";
          note(verdict, `not fetched: budget spent (${why})`);
          unreadAdmitted += 1;
          continue;
        }

        attempts += 1;
        const outcome = await fetchPage(verdict.url, {
          transport: deps.transport,
          relevantTo: identityWords,
          // Never let one page outlive the quote's own budget, even when the per-page
          // timeout is the larger of the two.
          timeoutMs: Math.max(1_000, Math.min(PAGE_FETCH_TIMEOUT_MS, timeoutMs - (now() - started))),
        });
        if (!outcome.ok) {
          if (outcome.refusal.kind === "document") {
            // The #77 case: a manual we can see but cannot read yet. One HEAD request told
            // us that, so it spent an attempt and not a read.
            // The document that answered, which a redirect may have moved (D1).
            const documentUrl = outcome.refusal.url;
            // A lead only when it concerns this car (D3): a price list or a promotion's terms
            // the model called a manual is not one, and `chooseManuals` could never queue it.
            // The search title is the label when it names the model; a generic one ("Download")
            // is no label, so the URL decides, exactly as it does when the manual is queued.
            const label = namesModel([verdict.title], identity.model) ? verdict.title!.slice(0, 200) : null;
            const concerns = concernsModel({ label, url: documentUrl }, identity.model);
            if (concerns && !manualCandidates.some((m) => m.url === documentUrl)) {
              manualCandidates.push({
                url: documentUrl,
                publisher: hostLabel(documentUrl),
                classification: verdict.classification,
                tier: verdict.tier,
                label,
              });
            }
            note(verdict, concerns ? "manual candidate (document, not fetched)" : "document, not about this vehicle");
            continue;
          }
          note(verdict, `not read: ${outcome.refusal.kind}${outcome.refusal.kind === "status" ? ` ${outcome.refusal.status}` : ""}`);
          if (leftUnread(outcome.refusal)) {
            unreadAdmitted += 1;
          }
          continue;
        }

        // Two results can redirect to one page (D1): the second is the same page, read once.
        const answeredKey = pageKey(outcome.page.url);
        if (readPages.has(answeredKey)) {
          note(verdict, `skipped: same page already read (${outcome.page.url})`);
          continue;
        }
        readPages.add(answeredKey);
        seenPages.add(answeredKey);
        reads += 1;
        bytes += outcome.page.text.length;

        // A gateway page's links are the documents it exists to hand out. They are the same
        // publisher (harvesting is same-origin only), so they inherit this page's class and
        // tier — but `discoveredVia` records that no model ever classified them one by one.
        // Over the cap, the labels decide which are recorded, and why (D8).
        // The selector spends from this quote's clock and its tally, so neither the timeout
        // nor `costUsd` can hide it.
        // Only the links that concern this car (D3), so the cap and the selector's tokens go to
        // them and a price list linked beside the manual is not recorded as a lead.
        const linked = outcome.page.documentLinks.filter((link) => concernsModel(link, identity.model));
        if (linked.length < outcome.page.documentLinks.length) {
          note(verdict, `${outcome.page.documentLinks.length - linked.length} linked documents not about this vehicle`, outcome.page.url);
        }
        const chosen = await chooseDocumentLinks(linked, identity, deps.selectLinks, undefined, {
          timeoutMs: timeoutMs - (now() - started),
          signal,
          onUsage: addUsage,
        });
        for (const link of chosen) {
          if (manualCandidates.some((existing) => existing.url === link.url)) {
            continue;
          }
          manualCandidates.push({
            url: link.url,
            publisher: hostLabel(link.url),
            classification: verdict.classification,
            tier: verdict.tier,
            discoveredVia: outcome.page.url,
            label: link.label,
            selectionReason: link.selectionReason,
          });
        }

        sources.push({
          publisher: hostLabel(outcome.page.url),
          document: outcome.page.title ?? outcome.page.url,
          page: outcome.page.title ?? outcome.page.url,
          authority: verdict.tier,
          url: outcome.page.url,
          classification: verdict.classification,
          // The page is not committed anywhere, so the passage the extractor reads is kept
          // on the cache row: the URL alone stops being evidence the day the page changes.
          excerpt: outcome.page.text,
          content: { kind: "text", text: outcome.page.text },
        });
        note(verdict, "accepted");
      }
      passes.push(passLog);
    }

    try {
      await runPass(searchModel);
    } finally {
      clearTimeout(budgetTimer);
    }

    log({
      identity: `${identity.make} ${identity.model} ${identity.year} ${identity.version}`,
      passes,
      fetched: reads,
      bytes,
      elapsedMs: now() - started,
      manualCandidates: manualCandidates.length,
      searchCalls,
      costUsd: costUsdOf(usage, searchCalls, searchModel),
      usageKnown: usage != null,
      ...(usage ? { usage } : {}),
    });

    if (searchFailed) {
      // Whatever the web found before the provider failed is kept (oil-research-web-retrieval D4).
      return manualCandidates.length > 0 ? { status: "unavailable", manualCandidates } : { status: "unavailable" };
    }
    const unread = unreadAdmitted > 0 ? { unreadAdmitted } : {};
    if (sources.length === 0) {
      return manualCandidates.length > 0
        ? { status: "none", manualCandidates, ...unread }
        : { status: "none", ...unread };
    }
    return { status: "found", sources, manualCandidates, ...unread };
  };
}

/**
 * Whether a refusal left the page's content unknown, so the search is incomplete and may not
 * be remembered as a miss (review of #176, 2026-09-25).
 *
 * A definite answer counts as read: a 4xx other than 408 and 429 (the page is gone, or is
 * not ours to read, and a retry would say the same), a robots.txt disallow (we may never
 * fetch it — as definite as a 403), a URL the SSRF guard refuses (not public https: it will
 * never be fetched), and "not a page". A transient one does not: a 5xx, 408,
 * 429, a network failure or timeout (orchestrator rulings on #176, 2026-09-25). A redirect
 * that was not followed — off-host, blocked, too long, or without a `Location` — is definite
 * too: a retry meets the same redirect (oil-research-web-retrieval D1).
 *
 * @param refusal - Why the page was not read.
 * @returns True when its content is unknown.
 */
export function leftUnread(refusal: FetchRefusal): boolean {
  if (refusal.kind === "not_html" || refusal.kind === "document" || refusal.kind === "robots" || refusal.kind === "blocked" || refusal.kind === "redirect") {
    return false;
  }
  if (refusal.kind === "status") {
    const definite = refusal.status >= 400 && refusal.status < 500 && refusal.status !== 408 && refusal.status !== 429;
    return !definite;
  }
  return true;
}

/** A readable publisher label from a URL's host, for the citation. */
function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

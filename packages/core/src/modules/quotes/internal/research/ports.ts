/**
 * The research runner's ports (background-oil-research D9, D21): ONE injected object, with no
 * per-port fallback to the production clients. Tests pass fakes for the whole object, so a suite
 * can never reach Motul, Tecfil or OpenAI through a port it forgot; the worker's composition
 * root passes {@link createProductionResearchPorts}.
 *
 * The ports are built per run, over that run's {@link ResearchRunContext}: its meter, its signal
 * (the stop signal and the run ceiling together), the lease-renewing `step` every stage goes
 * through, and where a refused OpenAI request is reported.
 */
import type { Db } from "../../../../kernel/db.js";
import { createResearchTecfilLookup, type ResearchTecfilLookup } from "../catalog/tecfil-lookup.js";
import type { UsageMeter } from "../model-calls/meter.js";
import type { ModelPortOptions } from "../model-calls/ports.js";
import { createOilSpecExtractor, type AuthoritativeSourceRetriever, type OilSpecPorts } from "../pipeline/oil-spec.js";
import { createModelPassageSelector } from "../pipeline/passage-selector.js";
import { createEscalationExtractor, createModelOilSpecExtractor } from "../pipeline/spec-extractor.js";
import { createModelDocumentLinkSelector } from "../retrieval/document-links.js";
import { createStoredManualRetriever } from "../retrieval/stored-manuals.js";
import { chainRetrievers, createFixtureRetriever, createMotulRetriever, gateWebSearch, type MotulOutcome } from "../retrieval/sources.js";
import { createWebSearchRetriever } from "../retrieval/web-search.js";
import { webSearchAvailable } from "../retrieval/search-availability.js";
import { tapProviderRefusals, type ProviderReport } from "./provider-events.js";
import { storePerCall } from "./store-per-call.js";

/** The stages a run times (D14): the run row's `stage_ms` keys. */
export type ResearchStage = "motul" | "webSearch" | "passage" | "extraction" | "escalation" | "tecfil";

/** What a run's ports are built over. */
export type ResearchRunContext = {
  /** The run's own meter (D3). */
  meter: UsageMeter;
  /** The stop signal and the run ceiling, together (D9, step 7). */
  signal: AbortSignal;
  /**
   * Renews the lease and flushes the meter (a compare-and-set), then runs `fn`, timing it under
   * `stage` when one is named. Throws when the claim was lost or the run was aborted: nothing
   * more may be written or spent.
   */
  step<T>(stage: ResearchStage | null, fn: () => Promise<T>): Promise<T>;
  /** Where a refused OpenAI request is reported (D9). */
  report: ProviderReport;
  /** A `manual_resolve`: the web search is skipped (D11). */
  skipWebSearch: boolean;
  /**
   * Motul has been failing, continuously, for `MOTUL_DEGRADED_AFTER_MS`: its `unavailable` no
   * longer makes this run incomplete (oil-research-web-retrieval D6).
   */
  motulDegraded: boolean;
  /** Where the Motul adapter reports whether it answered, for the runner to stamp or clear (D6). */
  reportMotul: (outcome: MotulOutcome) => void;
};

/** The one ports object the runner is given. */
export type OilResearchPorts = {
  /** Whether the model key is set; without it nothing is claimed (D9, step 2). */
  keySet(): boolean;
  /**
   * Whether this worker can web-search right now: `WEB_SEARCH_ENABLED` and a search key. The
   * heartbeat records it, so a quote-open re-opens a "not searched" no-source only while a search
   * could run (review of #188).
   */
  searchAvailable(): boolean;
  /** The pipeline's ports for one run. The runner wraps each call in `step`. */
  specPorts(run: ResearchRunContext): OilSpecPorts;
  /** The Tecfil lookup for one run, telling a picker failure from "none" (D12). */
  tecfil(run: ResearchRunContext): ResearchTecfilLookup;
};

/** A retriever whose every call goes through the run's `step` under `stage`. */
function stepped(run: ResearchRunContext, stage: ResearchStage, retriever: AuthoritativeSourceRetriever): AuthoritativeSourceRetriever {
  return (identity, options) => run.step(stage, () => retriever(identity, options));
}

/**
 * The production ports: the fixtures, the stored manual readings and Motul, then — unless the run
 * is a re-resolve — the gated web search; model extraction, passage selection and escalation. Every
 * OpenAI request carries the effort (D1), is metered on the run's meter (D3), is bounded by the
 * run's signal (D9), and reports its refusals. Motul's and Tecfil's own 8 s GETs are not threaded.
 *
 * @param db - The database handle: the search misses and the manual readings are read, and a
 *   miss recorded, through a store whose every call is its own short transaction.
 */
export function createProductionResearchPorts(db: Db): OilResearchPorts {
  const store = storePerCall(db);
  return {
    keySet: () => Boolean(process.env.OPENAI_API_KEY?.trim()),
    searchAvailable: () => webSearchAvailable(),
    specPorts: (run) => {
      // The call sites put the effort seam over it (D1); the tap only listens.
      const transport = tapProviderRefusals(fetch, run.report);
      const model: ModelPortOptions = { meter: run.meter, signal: run.signal, transport };
      const local = chainRetrievers([createFixtureRetriever(), createStoredManualRetriever(store), stepped(run, "motul", createMotulRetriever({ degraded: run.motulDegraded, report: run.reportMotul }))]);
      const retrieve = run.skipWebSearch
        ? local
        : gateWebSearch(
            local,
            stepped(
              run,
              "webSearch",
              createWebSearchRetriever({ selectLinks: createModelDocumentLinkSelector(model), meter: run.meter, signal: run.signal, httpFetch: transport }),
            ),
            store,
          );
      return {
        retrieve,
        extract: createOilSpecExtractor(createModelOilSpecExtractor(model)),
        selectPassage: createModelPassageSelector(model),
        escalate: createEscalationExtractor(model),
      };
    },
    tecfil: (run) => createResearchTecfilLookup({ meter: run.meter, signal: run.signal }),
  };
}

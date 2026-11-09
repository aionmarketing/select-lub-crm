/**
 * The web search step's port: what the web adapter injects as its `search`, and the one error a
 * search that did not work throws. Split out of the retired Zhipu provider module, which owned
 * them first.
 */
import type { SearchCandidate } from "./admit.js";

/** A search that could not run or did not finish: an outage, never an empty result. */
export class SearchUnavailableError extends Error {
  override name = "SearchUnavailableError";
}

/**
 * Runs one search and returns the model's candidates.
 *
 * `budgetMs` is what remains of the web search's wall clock, and `signal`, when given, an outer
 * bound (the research run's). An implementation MUST NOT outlive either.
 */
export type SearchFn = (
  model: string,
  query: string,
  budgetMs: number,
  manualQuery?: string,
  signal?: AbortSignal,
) => Promise<SearchCandidate[]>;

/**
 * What a web search cost: the tokens it spent and the list price they are costed at. Split out
 * of the web source adapter so the arithmetic, and the reason reasoning tokens bill as output,
 * sit in one place.
 */
import { costOfUsage, priceFor, SEARCH_TOOL_FEE_USD } from "../model-calls/meter.js";
import { moneySetting } from "../model-calls/money.js";
import { OIL_RESEARCH_DEFAULT_MODEL } from "../model-calls/research-model.js";

/**
 * Tokens one search spent, split the way `prompt.md` asks for them.
 *
 * Reasoning is called out separately because it is invisible in the reply: a search that returns
 * two candidate URLs can still have spent two thousand tokens deciding on them, and a cap set
 * without knowing that truncates the answer to nothing.
 */
export type TokenUsage = {
  /** Uncached input: excludes cached input and cache writes. */
  input: number;
  cachedInput: number;
  reasoning: number;
  output: number;
  /**
   * Input written to the prompt cache, billed at its own rate (OpenAI's
   * `input_tokens_details.cache_write_tokens`); absent when the provider reports none.
   */
  cacheWrite?: number;
};

/**
 * What one search cost, at the model's list price and the tool fee.
 *
 * Reasoning tokens bill as output — they are invisible in the reply, so a cost that ignored them
 * would understate every search. With no usage reported the figure is the call fee alone, and
 * `usageKnown` says so rather than letting a small number read as a cheap search.
 *
 * @param usage - Token split, or undefined when the provider reported none.
 * @param searchCalls - Billable web-search tool calls.
 * @param model - The model that spent the tokens; the default research model when absent.
 */
export function costUsdOf(usage: TokenUsage | undefined, searchCalls: number, model: string = OIL_RESEARCH_DEFAULT_MODEL): number {
  const calls = searchCalls * moneySetting("WEB_SEARCH_PRICE_PER_CALL", SEARCH_TOOL_FEE_USD);
  if (!usage) {
    return calls;
  }
  return costOfUsage(usage, priceFor("openai", model).price) + calls;
}

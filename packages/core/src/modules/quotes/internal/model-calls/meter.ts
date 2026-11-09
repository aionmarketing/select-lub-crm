/**
 * A per-run usage meter (background-oil-research D3; `research-model-calls` "Each research call
 * reports what it spent, priced at its model's list price").
 *
 * Every port reports each request it sends — answered, failed or aborted — with
 * `onCall({ model, usage | null, timedOut, accepted })`. The runner builds a fresh meter per run
 * and per manual reading, so two runs that overlap in one process never mix their spend.
 *
 * What a call costs:
 * - with usage, its tokens at its model's price (`provider:model`), reasoning billed as output;
 * - accepted and no usage (aborted, or cut after the response started), `OIL_RESEARCH_UNKNOWN_CALL_USD`,
 *   whose default is the model's limits row (US$ 0.25): an upper bound, so the charge never falls
 *   below what an aborted call was billed;
 * - refused before any body (a 401, a refused parameter), nothing.
 * A web-search tool call's fee is booked once per `web_search_call` item. The Tecfil picker is
 * metered apart: it is outside the cap (owner).
 *
 * Runs recorded before GLM was removed keep their `glm:*` token keys and their cost on disk; this
 * meter never reads them, and nothing re-prices them (`research-model-calls` "Spend recorded
 * under the retired GLM provider stays readable").
 */
import type { ReasoningEffort } from "./effort.js";
import { hasOpenAILimitsEntry, limitsFor } from "./limits.js";
import { moneySetting, parseMoney } from "./money.js";
import type { TokenUsage } from "../retrieval/search-cost.js";

/** Who served a call: the key it was billed on. */
export type CallProvider = "openai";

/** One request a port sent. */
export type CallEvent = {
  model: string;
  /** `openai` when absent. */
  provider?: CallProvider;
  /** What the server reported, or `null` when it reported nothing. */
  usage: TokenUsage | null;
  /** Aborted by a limit (idle, ceiling or budget). */
  timedOut: boolean;
  /** The server accepted the request: a 2xx arrived, or the call was aborted waiting for one. */
  accepted: boolean;
  /** The Tecfil picker: counted apart, outside the cap. */
  picker?: true;
  /** The effort this call was sent, recorded with the model; absent means the caller did not say. */
  effort?: ReasoningEffort | "none";
};

/**
 * A USD price per million tokens. `cacheWrite` prices input written to the prompt cache; absent,
 * it is charged as input. `longContext` is the whole-request price when a call's input exceeds
 * {@link LONG_CONTEXT_INPUT_TOKENS} (OpenAI's pricing page, 2026-10-10).
 */
export type ModelPrice = {
  input: number;
  cachedInput: number;
  output: number;
  cacheWrite?: number;
  longContext?: { input: number; cachedInput: number; output: number; cacheWrite?: number };
};

/** Above this many input tokens a request is priced at its model's long-context rates. */
export const LONG_CONTEXT_INPUT_TOKENS = 272_000;

/** One `web_search_call` item's kind: a search action, or a page action (open or find in page). */
export type ToolCallKind = "search" | "page";

/**
 * What one model spent in a run. `pricedByFallback` is true when the model had no price entry
 * and was charged the conservative fallback price instead.
 */
export type ModelTally = TokenUsage & { calls: number; unknownCalls: number; costUsd: number; pricedByFallback: boolean };

/** Everything the meter counted. */
export type MeterSnapshot = {
  /** Per `provider:model`, the non-picker calls. */
  models: Record<string, ModelTally>;
  /** Model requests sent, the picker's excluded. The run records it in `glm_calls`, which keeps its old name. */
  modelCalls: number;
  /** `web_search` tool calls that were billed (page actions included unless configured free). */
  searchCalls: number;
  /** Of the tool calls reported, those that were page actions (open or find in page). */
  pageActions: number;
  /** Calls aborted by a limit. */
  timedOutCalls: number;
  /** False when some accepted call reported no usage, or a model had no price entry. */
  usageKnown: boolean;
  /** Every (model, effort sent) pair used, `none` when no effort was sent. */
  efforts: { model: string; effort: ReasoningEffort | "none" }[];
  /** The capped spend: model calls and tool fees, the picker excluded, USD. */
  costUsd: number;
  /** The picker, apart. */
  picker: { calls: number; usage: TokenUsage; costUsd: number };
};

/** The meter a port reports to. */
export type UsageMeter = {
  onCall(event: CallEvent): void;
  /**
   * One tool call. A page action is charged the fee unless `WEB_SEARCH_BILL_PAGE_ACTIONS=false`
   * (switch-oil-research-to-openai D2: conservative while it is not known whether OpenAI bills it).
   */
  onToolCall(event: { answered: boolean; kind?: ToolCallKind }): void;
  snapshot(): MeterSnapshot;
};

/** The flat fee per `web_search` tool call, when `WEB_SEARCH_PRICE_PER_CALL` is unset. */
export const SEARCH_TOOL_FEE_USD = 0.01;

/** `gpt-6.1-sol` at OpenAI's Standard list, USD per million tokens, with its long-context rates. */
export const GPT_6_1_SOL_PRICE: ModelPrice = {
  input: 2,
  cachedInput: 0.1,
  cacheWrite: 2.5,
  output: 10,
  // The cache-write rate of 5.00 is an extrapolation (2 × 2.50): OpenAI says only that input and
  // cache rates double above 272K.
  longContext: { input: 4, cachedInput: 0.2, cacheWrite: 5, output: 15 },
};

/**
 * The built-in price table, keyed `provider:model` (D5). The one model listed is `gpt-6.1-sol`, at
 * the list OpenAI publishes (model and pricing pages, read 2026-10-10). Any other model — an
 * escalation override or the Tecfil picker's — is priced by `OIL_RESEARCH_MODEL_PRICES`, else at
 * the conservative {@link unpricedModelPrice}, marked priced by fallback.
 */
export function builtInPrices(): Record<string, ModelPrice> {
  return { "openai:gpt-6.1-sol": { ...GPT_6_1_SOL_PRICE } };
}

/** Parses `OIL_RESEARCH_MODEL_PRICES`: `{"provider:model": {input, cachedInput, output}}`; bad entries are logged and ignored. */
function overridePrices(): Record<string, ModelPrice> {
  const raw = process.env.OIL_RESEARCH_MODEL_PRICES?.trim();
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn("money-setting", JSON.stringify({ outcome: "invalid", name: "OIL_RESEARCH_MODEL_PRICES" }));
    return {};
  }
  const prices: Record<string, ModelPrice> = {};
  for (const [key, value] of Object.entries((parsed ?? {}) as Record<string, unknown>)) {
    const entry = value as Record<string, unknown> | null;
    const read = (field: string) => (typeof entry?.[field] === "number" || typeof entry?.[field] === "string" ? parseMoney(String(entry[field])) : null);
    const input = read("input");
    const cachedInput = read("cachedInput");
    const output = read("output");
    const cacheWrite = entry?.cacheWrite === undefined ? undefined : read("cacheWrite");
    if (input === null || cachedInput === null || output === null || cacheWrite === null) {
      console.warn("money-setting", JSON.stringify({ outcome: "invalid", name: "OIL_RESEARCH_MODEL_PRICES", entry: key }));
      continue;
    }
    // An override replaces the list price; a built-in long-context schedule no longer applies.
    prices[key] = { input, cachedInput, output, ...(cacheWrite !== undefined ? { cacheWrite } : {}) };
  }
  return prices;
}

/** The table in force: built-in entries with `OIL_RESEARCH_MODEL_PRICES` over them. */
export function modelPrices(): Record<string, ModelPrice> {
  return { ...builtInPrices(), ...overridePrices() };
}

/** The conservative input price, USD per million tokens, for a model with no entry. */
export const UNPRICED_MODEL_DEFAULT_INPUT_USD_PER_MTOK = 5;

/** The conservative output price, USD per million tokens, for a model with no entry. */
export const UNPRICED_MODEL_DEFAULT_OUTPUT_USD_PER_MTOK = 15;

/**
 * The price for a model with no entry (an escalation override or the Tecfil picker's), charged "at
 * the highest price" so the cap errs safe (owner ruling on #184).
 * `OIL_RESEARCH_UNPRICED_MODEL_USD_PER_MTOK_INPUT` / `_OUTPUT` set it; cached input is charged as
 * input.
 */
export function unpricedModelPrice(): ModelPrice {
  const input = moneySetting("OIL_RESEARCH_UNPRICED_MODEL_USD_PER_MTOK_INPUT", UNPRICED_MODEL_DEFAULT_INPUT_USD_PER_MTOK);
  const output = moneySetting("OIL_RESEARCH_UNPRICED_MODEL_USD_PER_MTOK_OUTPUT", UNPRICED_MODEL_DEFAULT_OUTPUT_USD_PER_MTOK);
  return { input, cachedInput: input, output };
}

/** The price a call is charged at: its own entry, else {@link unpricedModelPrice}. */
export function priceFor(
  provider: CallProvider,
  model: string,
  prices: Record<string, ModelPrice> = modelPrices(),
): { price: ModelPrice; byFallback: boolean } {
  const entry = prices[`${provider}:${model}`];
  if (entry) return { price: entry, byFallback: false };
  return { price: unpricedModelPrice(), byFallback: true };
}

/**
 * What `usage` costs at `price`, reasoning billed as output, cache writes at their own rate
 * (input's when the price has none). A request whose input — uncached, cached and written — is
 * over {@link LONG_CONTEXT_INPUT_TOKENS} is priced whole at the long-context rates, when the
 * price has them.
 */
export function costOfUsage(usage: TokenUsage, price: ModelPrice): number {
  const cacheWrite = usage.cacheWrite ?? 0;
  const totalInput = usage.input + usage.cachedInput + cacheWrite;
  const rates = price.longContext && totalInput > LONG_CONTEXT_INPUT_TOKENS ? price.longContext : price;
  return (
    (usage.input * rates.input) / 1e6 +
    (usage.cachedInput * rates.cachedInput) / 1e6 +
    (cacheWrite * (rates.cacheWrite ?? rates.input)) / 1e6 +
    ((usage.output + usage.reasoning) * rates.output) / 1e6
  );
}

/** Output tokens per second a call is assumed to stream at, for the unknown-call charge of a model with no limits entry. */
const UNKNOWN_CALL_TOKENS_PER_S = 160;

/** The input a call is assumed to have sent, for that same charge (D3). */
const UNKNOWN_CALL_INPUT_TOKENS = 7_000;

/**
 * The charge for an accepted call that reported no usage. `OIL_RESEARCH_UNKNOWN_CALL_USD` when
 * set. Otherwise, for a model with a limits entry, that row's estimate (US$ 0.25). For any other
 * model, D3's rule at its price: the call ceiling at 160 tokens/s of output plus a 7,000-token
 * input, rounded up to a cent — about US$ 0.62 at the unpriced default.
 *
 * @param model - The model the call named.
 */
export function unknownCallUsd(model: string): number {
  const limits = limitsFor(model);
  if (hasOpenAILimitsEntry(model)) return moneySetting("OIL_RESEARCH_UNKNOWN_CALL_USD", limits.unknownCallUsd);
  const { price } = priceFor("openai", model);
  const usd = ((limits.callMs / 1_000) * UNKNOWN_CALL_TOKENS_PER_S * price.output + UNKNOWN_CALL_INPUT_TOKENS * price.input) / 1e6;
  return moneySetting("OIL_RESEARCH_UNKNOWN_CALL_USD", Math.ceil(usd * 100) / 100);
}

const zero = (): TokenUsage => ({ input: 0, cachedInput: 0, reasoning: 0, output: 0 });

function add(into: TokenUsage, usage: TokenUsage): void {
  into.input += usage.input;
  into.cachedInput += usage.cachedInput;
  into.reasoning += usage.reasoning;
  into.output += usage.output;
  if (usage.cacheWrite) into.cacheWrite = (into.cacheWrite ?? 0) + usage.cacheWrite;
}

/** Whether a page action is charged the tool fee (`WEB_SEARCH_BILL_PAGE_ACTIONS`, default true). */
export function billPageActions(): boolean {
  return process.env.WEB_SEARCH_BILL_PAGE_ACTIONS?.trim().toLowerCase() !== "false";
}

/** @returns A fresh meter; build one per run. */
export function createUsageMeter(): UsageMeter {
  const models: Record<string, ModelTally> = {};
  const efforts = new Map<string, { model: string; effort: ReasoningEffort | "none" }>();
  const picker = { calls: 0, usage: zero(), costUsd: 0 };
  let modelCalls = 0;
  let searchCalls = 0;
  let pageActions = 0;
  let timedOutCalls = 0;
  let usageKnown = true;
  let toolFees = 0;

  return {
    onCall(event) {
      const provider = event.provider ?? "openai";
      const key = `${provider}:${event.model}`;
      if (event.timedOut) timedOutCalls += 1;
      const { price, byFallback } = priceFor(provider, event.model);
      if (event.picker) {
        picker.calls += 1;
        if (event.usage) {
          add(picker.usage, event.usage);
          picker.costUsd += costOfUsage(event.usage, price);
        }
        return;
      }
      modelCalls += 1;
      if (event.effort !== undefined) {
        efforts.set(`${event.model}|${event.effort}`, { model: event.model, effort: event.effort });
      }
      const tally = (models[key] ??= { ...zero(), calls: 0, unknownCalls: 0, costUsd: 0, pricedByFallback: false });
      tally.calls += 1;
      if (event.usage) {
        add(tally, event.usage);
        if (byFallback) {
          usageKnown = false;
          tally.pricedByFallback = true;
        }
        tally.costUsd += costOfUsage(event.usage, price);
      } else if (event.accepted) {
        usageKnown = false;
        tally.unknownCalls += 1;
        if (byFallback) tally.pricedByFallback = true;
        tally.costUsd += unknownCallUsd(event.model);
      }
    },
    onToolCall({ answered, kind }) {
      if (!answered) return;
      if (kind === "page") {
        pageActions += 1;
        if (!billPageActions()) return;
      }
      searchCalls += 1;
      toolFees += moneySetting("WEB_SEARCH_PRICE_PER_CALL", SEARCH_TOOL_FEE_USD);
    },
    snapshot() {
      const costUsd = Object.values(models).reduce((sum, tally) => sum + tally.costUsd, toolFees);
      return {
        models: structuredClone(models),
        modelCalls,
        searchCalls,
        pageActions,
        timedOutCalls,
        usageKnown,
        efforts: [...efforts.values()],
        costUsd,
        picker: structuredClone(picker),
      };
    },
  };
}

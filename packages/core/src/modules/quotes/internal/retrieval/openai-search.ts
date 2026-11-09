/**
 * The OpenAI search step (switch-oil-research-to-openai D3; `oil-spec-web-search` "The web search
 * runs on OpenAI's hosted search tool, and only the system's own fetch reads a page"). It is the
 * web search adapter's default `search` and the benchmark's.
 *
 * The tool cap (`max_tool_calls`) is SOFT: the 2026-10-12 benchmark asked for 1 and got 2 items,
 * asked for 3 and got 4. So the adapter never trusts it. It reads the `web_search_call` items the
 * response actually carries, books and bills every one of them (an overrun is logged as
 * `over_cap`), and takes the sources of every one as candidates.
 *
 * Two streamed Responses API calls:
 *
 * 1. **The search.** The research model with the hosted `web_search` tool, forced to run
 *    (`tool_choice: "required"`), its tool calls capped (`max_tool_calls`), a Brazilian location,
 *    and the blocklist's plain domains as `blocked_domains`. The candidates are each search
 *    action's consulted sources (`include: ["web_search_call.action.sources"]`) plus each page
 *    the model opened. The reply text, any URL only it names, and whatever the provider read are
 *    discarded: the system fetches every page itself (the web search adapter's `fetchPage`).
 * 2. **The classification.** The candidates that pass the code blocklist and the site-root rule —
 *    never the others (owner, 2026-10-11) — go to the research model with no tools, answering a
 *    strict JSON schema: a class and a reason per index. The tier is derived later, in code.
 *
 * A failed request, a failed `web_search_call`, an incomplete response, the budget, or a
 * classification with no verdict throws {@link SearchUnavailableError}: an outage, never a miss.
 */
import { findBlock, oilSourceBlocklist, type BlockedDomain } from "@select-lub/core/db";
import { isSiteRoot, type SearchCandidate } from "./admit.js";
import { citationTitles, emptyReply, readResponsesStream, readSearchActions, type ResponsesReply, type SearchActions } from "./openai-responses.js";
import type { TokenUsage } from "./search-cost.js";
import { formatHits, pageKey, parseVerdicts, WEB_SEARCH_CLASSIFY_PROMPT, type SearchHit } from "./search-hits.js";
import { SearchUnavailableError, type SearchFn } from "./search-fn.js";
import { isQuotaError, isRetryableStatus, retryWaitMs } from "../model-calls/openai-retry.js";
import { openaiBaseUrl, openaiMaxOutputTokens } from "../model-calls/research-model.js";
import type { ReasoningEffort } from "../model-calls/effort.js";
import { limitsFor } from "../model-calls/limits.js";
import { billPageActions, costOfUsage, priceFor, SEARCH_TOOL_FEE_USD, type UsageMeter } from "../model-calls/meter.js";
import { moneySetting } from "../model-calls/money.js";
import { startWatchdog } from "../model-calls/watchdog.js";

/** The tool-call cap per search response, when `WEB_SEARCH_MAX_SEARCHES` is unset (D2). */
export const WEB_SEARCH_DEFAULT_MAX_SEARCHES = 3;

/** The search context size, when `WEB_SEARCH_CONTEXT_SIZE` is unset (D2). */
export const WEB_SEARCH_DEFAULT_CONTEXT_SIZE = "medium";

/** The approximate location every search is sent: São Paulo, Brazil (D3). */
export const SEARCH_USER_LOCATION = {
  type: "approximate",
  country: "BR",
  city: "São Paulo",
  region: "São Paulo",
  timezone: "America/Sao_Paulo",
} as const;

/** The six document classes the classification may answer. */
const CLASSES = [
  "manufacturer_manual",
  "manufacturer_technical",
  "licensed_database",
  "lubricant_maker_guide",
  "aftermarket_catalog",
  "other",
] as const;

/** The strict schema the classification answers in: no tier field, by construction. */
export const CLASSIFICATION_SCHEMA = {
  type: "json_schema",
  name: "verdicts",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["verdicts"],
    properties: {
      verdicts: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["index", "classification", "reason"],
          properties: {
            index: { type: "integer" },
            classification: { type: "string", enum: [...CLASSES] },
            reason: { type: "string" },
          },
        },
      },
    },
  },
} as const;

/** A positive integer from the environment, else `fallback`. */
function envInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isInteger(raw) && raw > 0 ? raw : fallback;
}

/** The tool-call cap: `WEB_SEARCH_MAX_SEARCHES`, default 3. */
export function maxSearches(): number {
  return envInt("WEB_SEARCH_MAX_SEARCHES", WEB_SEARCH_DEFAULT_MAX_SEARCHES);
}

/** The search context size: `WEB_SEARCH_CONTEXT_SIZE` when it is `low`, `medium` or `high`. */
export function searchContextSize(): "low" | "medium" | "high" {
  const raw = process.env.WEB_SEARCH_CONTEXT_SIZE?.trim().toLowerCase();
  return raw === "low" || raw === "medium" || raw === "high" ? raw : WEB_SEARCH_DEFAULT_CONTEXT_SIZE;
}

/**
 * The blocklist patterns OpenAI's `blocked_domains` can carry: plain domains only — the filter
 * takes no wildcards, at most 100, without protocol, subdomains included (web-search guide). The
 * code blocklist still runs on every candidate first; the filter is OpenAI's, not our guard.
 */
export function blockedDomainsFilter(blocklist: readonly BlockedDomain[] = oilSourceBlocklist()): string[] {
  return blocklist
    .map((entry) => entry.pattern.trim().toLowerCase())
    .filter((pattern) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(pattern))
    .slice(0, 100);
}

/** The search prompt: the vehicle and both intents, in Portuguese (`user_location` has no language). */
export function buildOpenAISearchPrompt(query: string, manualQuery?: string): string {
  return [
    "Pesquise na web páginas que informem a especificação do óleo do motor deste veículo",
    "(viscosidade SAE e capacidade de óleo em litros) e o manual do proprietário da montadora.",
    `Consulta do veículo: ${query}`,
    ...(manualQuery ? [`Consulta do manual: ${manualQuery}`] : []),
    "Prefira o site oficial da montadora no Brasil. Não responda com a especificação: só pesquise.",
  ].join("\n");
}



/** What the adapter is built with. */
export type OpenAISearchOptions = {
  apiKey?: string;
  /**
   * The research model to name. The web adapter passes its configured model as the search
   * argument too; when both are given, this one wins.
   */
  model?: string;
  /** The effort the research model is sent; `null` for none. */
  effort: ReasoningEffort | null;
  /** The socket; global `fetch` when absent. */
  httpFetch?: typeof fetch;
  /** Sleeps before the one retry. */
  wait?: (ms: number) => Promise<void>;
  meter?: UsageMeter;
  /** Receives each answered call's tokens (the web search log's tally). */
  onUsage?: (usage: TokenUsage) => void;
  /** Called once per billed tool call. */
  onToolCall?: () => void;
  /** The committed blocklist; the shipped one when absent. */
  blocklist?: BlockedDomain[];
  baseUrl?: string;
  log?: (line: string, detail: string) => void;
};

/** A timer-driven signal: aborted after `ms`, with a way to stop the timer. */
function timerSignal(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("web search budget spent", "TimeoutError")), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

/**
 * Creates the OpenAI search step.
 *
 * @returns A {@link SearchFn}: the classified candidates, plus — unclassified, so the adapter's
 * admission logs their rejection — those the blocklist or the site-root rule kept from the
 * classifier. An empty list only when the search ran and consulted nothing.
 */
export function createOpenAISearch(options: OpenAISearchOptions): SearchFn {
  const httpFetch = options.httpFetch ?? fetch;
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = options.log ?? ((line: string, detail: string) => console.info(line, detail));
  const blocklist = options.blocklist ?? oilSourceBlocklist();

  return async (passedModel, query, budgetMs, manualQuery, outer) => {
    const model = options.model ?? passedModel;
    const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) throw new SearchUnavailableError("OPENAI_API_KEY is not set");
    const base = options.baseUrl ?? openaiBaseUrl();
    const limits = limitsFor(model, options.effort);
    const effortField = { effort: options.effort ?? ("none" as const) };
    const deadline = Date.now() + Math.max(1_000, budgetMs);
    const remaining = () => Math.max(1_000, deadline - Date.now());
    const budgetTimer = timerSignal(Math.max(1_000, budgetMs));
    const budget = outer ? AbortSignal.any([budgetTimer.signal, outer]) : budgetTimer.signal;
    const reasoning = { ...(options.effort ? { effort: options.effort } : {}), summary: "auto" };
    let feesUsd = 0;
    let tokenUsd = 0;
    let searchActions = 0;
    let pageActions = 0;

    const send = (payload: unknown, signal: AbortSignal) =>
      httpFetch(`${base}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        signal,
        body: JSON.stringify(payload),
      });


    /** Books the fees of the `web_search_call` items a response carried, whatever became of it. */
    const bookActions = (items: readonly Record<string, unknown>[], cap: number) => {
      const actions = readSearchActions(items);
      searchActions = actions.searchActions;
      pageActions = actions.pageActions;
      for (let i = 0; i < actions.searchActions; i += 1) {
        options.meter?.onToolCall({ answered: true, kind: "search" });
        options.onToolCall?.();
      }
      for (let i = 0; i < actions.pageActions; i += 1) {
        options.meter?.onToolCall({ answered: true, kind: "page" });
        if (billPageActions()) options.onToolCall?.();
      }
      // Every item reported is charged, an overrun of the cap included (spec).
      feesUsd = (actions.searchActions + (billPageActions() ? actions.pageActions : 0)) * moneySetting("WEB_SEARCH_PRICE_PER_CALL", SEARCH_TOOL_FEE_USD);
      if (actions.searchActions + actions.pageActions > cap) {
        log("openai-web-search", JSON.stringify({ outcome: "over_cap", cap, items: actions.searchActions + actions.pageActions }));
      }
      return actions;
    };

    /**
     * One streamed call with the one bounded retry (never on a spent quota), reported to the meter.
     * `onItems` sees every output item that arrived — on success, on an incomplete or failed
     * response, on a stream cut short — before any outage is thrown, so the search's fees are
     * always booked. Throws {@link SearchUnavailableError} as an outage.
     */
    const call = async (payload: Record<string, unknown>, label: string, onItems?: (items: readonly Record<string, unknown>[]) => void): Promise<ResponsesReply> => {
      const dog = startWatchdog({ idleMs: limits.idleMs, ceilingMs: Math.min(limits.callMs, remaining()), outer: budget });
      const reply = emptyReply();
      let accepted = false;
      let streamed = false;
      try {
        let res = await send(payload, dog.signal);
        if (isRetryableStatus(res.status)) {
          options.meter?.onCall({ model, provider: "openai", usage: null, timedOut: false, accepted: false, ...effortField });
          // Read the first answer whatever happens next, so its connection is released.
          const first = await res.text();
          if (res.status === 429 && isQuotaError(first)) throw new SearchUnavailableError(`${label} refused: insufficient_quota (not retried)`);
          const waitMs = retryWaitMs(res.headers.get("retry-after"));
          if (remaining() <= waitMs + 1_000) throw new SearchUnavailableError(`${label} answered ${res.status}, no time to retry`);
          log("openai-web-search", JSON.stringify({ outcome: "retry", label, status: res.status, waitMs }));
          await wait(waitMs);
          res = await send(payload, dog.signal);
        }
        if (!res.ok) {
          options.meter?.onCall({ model, provider: "openai", usage: null, timedOut: false, accepted: false, ...effortField });
          throw new SearchUnavailableError(`${label} answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
        }
        accepted = true;
        dog.bump();
        if (!res.body) throw new SearchUnavailableError(`${label} answered with no body`);
        streamed = true;
        await readResponsesStream(res.body, () => dog.bump(), dog.signal, reply);
        options.meter?.onCall({ model, provider: "openai", usage: reply.usage, timedOut: false, accepted: true, ...effortField });
        if (reply.usage) {
          options.onUsage?.(reply.usage);
          tokenUsd += costOfUsage(reply.usage, priceFor("openai", model).price);
        }
        if (reply.status !== "completed") throw new SearchUnavailableError(`${label} ended ${reply.status ?? "without a status (the stream was cut short)"}`);
        return reply;
      } catch (err) {
        const fired = dog.fired();
        if (fired) {
          options.meter?.onCall({ model, provider: "openai", usage: null, timedOut: true, accepted: true, ...effortField });
          throw new SearchUnavailableError(`${label} aborted: ${fired}`);
        }
        if (!(err instanceof SearchUnavailableError)) {
          options.meter?.onCall({ model, provider: "openai", usage: null, timedOut: false, accepted, ...effortField });
          throw new SearchUnavailableError(`${label} failed: ${String(err).slice(0, 200)}`);
        }
        throw err;
      } finally {
        dog.dispose();
        if (streamed) onItems?.(reply.items);
      }
    };

    try {
      const cap = maxSearches();
      const blocked = blockedDomainsFilter(blocklist);
      let actions: SearchActions | null = null;
      // `onItems` runs in the call's `finally`, so the fees are booked before any outage is thrown.
      const searched = await call(
        {
          model,
          stream: true,
          store: false,
          reasoning,
          max_output_tokens: openaiMaxOutputTokens(),
          tools: [
            {
              type: "web_search",
              search_context_size: searchContextSize(),
              user_location: SEARCH_USER_LOCATION,
              ...(blocked.length > 0 ? { filters: { blocked_domains: blocked } } : {}),
            },
          ],
          tool_choice: "required",
          max_tool_calls: cap,
          include: ["web_search_call.action.sources"],
          input: buildOpenAISearchPrompt(query, manualQuery),
        },
        "search",
        (items) => {
          actions = bookActions(items, cap);
        },
      );
      const found = actions as SearchActions | null;
      if (!found || found.searchActions + found.pageActions === 0) {
        // The model answered without searching (it ignored `tool_choice`): the web was not
        // searched, so this is an outage to retry, never a week-long miss.
        throw new SearchUnavailableError("the response carried no web_search_call: no search was made");
      }
      if (found.failed) throw new SearchUnavailableError("a web_search_call failed");

      const titles = citationTitles(searched.items);
      const all: SearchHit[] = found.urls.map((url) => ({ link: url, title: titles.get(pageKey(url)) ?? "", content: "" }));
      // The code blocklist and the site-root rule BEFORE classification: those never reach the model.
      const kept = all.filter((hit) => !findBlock(hit.link, blocklist) && !isSiteRoot(hit.link));
      const held: SearchCandidate[] = all
        .filter((hit) => !kept.includes(hit))
        .map((hit) => ({ url: hit.link, ...(hit.title ? { title: hit.title } : {}) }));
      if (kept.length === 0) return held;

      const classified = await call(
        {
          model,
          stream: true,
          store: false,
          reasoning,
          max_output_tokens: openaiMaxOutputTokens(),
          instructions: WEB_SEARCH_CLASSIFY_PROMPT,
          input: `Veículo e busca: ${query}\n\n${formatHits(kept)}`,
          text: { format: CLASSIFICATION_SCHEMA },
        },
        "classification",
      );
      const verdicts = parseVerdicts(classified.text, kept);
      if (verdicts.length === 0) throw new SearchUnavailableError("no verdicts parsed from the classification reply");
      return [...verdicts, ...held];
    } finally {
      budgetTimer.clear();
      log(
        "openai-web-search",
        JSON.stringify({ model, searchActions, pageActions, feesUsd, tokenUsd, costUsd: feesUsd + tokenUsd }),
      );
    }
  };
}

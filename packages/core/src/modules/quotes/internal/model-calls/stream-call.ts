/**
 * The streaming call helper every research call whose reply is read goes through
 * (background-oil-research D2): the extractor, the passage selector, the link selector and
 * escalation. (The web search reads its own server-sent events, over the same watchdog.)
 *
 * Every call goes to OpenAI's Responses API (switch-oil-research-to-openai D3), where the
 * reasoning effort, reasoning summaries and `store: false` exist. A call ends when it answers,
 * when it reaches its ceiling, or when the outer signal aborts — and when no event arrives for
 * the model's idle time, if its limits row has one — never at a fixed number of seconds chosen
 * apart from the effort. The limits come from the table by the model the call names and the
 * effort it sends ({@link limitsFor}).
 *
 * The call retries once on its own (`openai-retry.ts`): a rate limit or a 5xx, never a spent
 * quota. The SDK's retries are off, so that is the only one.
 *
 * Every request is reported to the meter: a refused one (non-2xx) as not accepted, and the
 * accepted one once it settles, with its usage or `null`.
 */
import { createOpenAI } from "@ai-sdk/openai";
import { streamText, type LanguageModelUsage } from "ai";
import type { TokenUsage } from "../retrieval/search-cost.js";
import type { ReasoningEffort } from "./effort.js";
import { limitsFor } from "./limits.js";
import { withOneRetry } from "./openai-retry.js";
import type { UsageMeter } from "./meter.js";
import { startWatchdog, tapResponse, type TimeoutKind } from "./watchdog.js";

/** One streamed call. */
export type ModelCallRequest = {
  apiKey: string;
  /** The SDK's default (OpenAI) when absent. */
  baseURL?: string;
  model: string;
  system: string;
  prompt: string;
  providerOptions?: Parameters<typeof streamText>[0]["providerOptions"];
  /** The effort this call sends, recorded on the run (`none` when null). */
  effort?: ReasoningEffort | null;
  /**
   * The output limit (`max_output_tokens`). Every research read sends one, a spend bound well
   * above the answer (`openaiMaxOutputTokens`).
   */
  maxOutputTokens?: number;
  /** Sleeps before the call's one retry; tests pass a fake. */
  retryWait?: (ms: number) => Promise<void>;
  /** The outer bound: a web search's budget, or the research run's. Its abort is `budget`. */
  signal?: AbortSignal;
  /** The socket. Tests inject a fake; production uses global `fetch`. */
  transport?: typeof fetch;
  meter?: UsageMeter;
  /** Names the caller in logs. */
  label: string;
};

/** What a call gave. `failed` is a model failure: a timeout, an error, or a length stop with no answer. */
export type ModelCallResult = {
  text: string;
  usage: TokenUsage | null;
  finishReason: string | null;
  timeout: TimeoutKind | null;
  error: unknown;
  failed: boolean;
};

/**
 * The SDK's usage in the split the meter prices: cached input and cache writes apart, and
 * reasoning apart from the rest of the output (it bills as output).
 *
 * @returns The split, or `null` when the provider reported no token count at all.
 */
export function tokenUsageOf(usage: LanguageModelUsage | undefined): TokenUsage | null {
  if (!usage || (usage.inputTokens == null && usage.outputTokens == null)) return null;
  const cachedInput = usage.inputTokenDetails?.cacheReadTokens ?? 0;
  // `input_tokens_details.cache_write_tokens`, billed at its own rate.
  const cacheWrite = usage.inputTokenDetails?.cacheWriteTokens ?? 0;
  const reasoning = usage.outputTokenDetails?.reasoningTokens ?? 0;
  return {
    input: Math.max(0, (usage.inputTokens ?? 0) - cachedInput - cacheWrite),
    cachedInput,
    reasoning,
    output: Math.max(0, (usage.outputTokens ?? 0) - reasoning),
    ...(cacheWrite > 0 ? { cacheWrite } : {}),
  };
}

/**
 * Runs one streamed call.
 *
 * @returns The text, the usage, the finish reason and why it timed out, if it did. Never throws.
 */
export async function streamModelCall(req: ModelCallRequest): Promise<ModelCallResult> {
  const limits = limitsFor(req.model, req.effort);
  const dog = startWatchdog({ idleMs: limits.idleMs, ceilingMs: limits.callMs, outer: req.signal });
  const base = withOneRetry(req.transport ?? fetch, req.retryWait);
  let accepted = false;
  const effortField = req.effort !== undefined ? { effort: req.effort ?? ("none" as const) } : {};

  const transport: typeof fetch = async (input, init) => {
    // Aborted before it was sent (an outer budget already spent, a bound fired during a retry's
    // wait): nothing reached the server, so nothing is reported or charged (review of #184).
    if (init?.signal?.aborted) throw init.signal.reason;
    let res: Response;
    try {
      res = await base(input, init);
    } catch (err) {
      // Aborted by a bound while waiting for the answer: the request was sent and the server may
      // be reasoning already, so it counts as accepted (an upper bound). Any other network
      // failure never reached it.
      if (dog.fired()) accepted = true;
      else req.meter?.onCall({ model: req.model, usage: null, timedOut: false, accepted: false, ...effortField });
      throw err;
    }
    dog.bump();
    if (!res.ok) {
      req.meter?.onCall({ model: req.model, usage: null, timedOut: false, accepted: false, ...effortField });
      return res;
    }
    accepted = true;
    return tapResponse(res, () => dog.bump(), dog.signal);
  };

  const client = createOpenAI({
    apiKey: req.apiKey,
    ...(req.baseURL ? { baseURL: req.baseURL } : {}),
    fetch: transport,
  });

  let text = "";
  let usage: TokenUsage | null = null;
  let finishReason: string | null = null;
  let error: unknown = null;
  try {
    const result = streamText({
      model: client.responses(req.model),
      system: req.system,
      prompt: req.prompt,
      ...(req.maxOutputTokens !== undefined ? { maxOutputTokens: req.maxOutputTokens } : {}),
      maxRetries: 0,
      ...(req.providerOptions ? { providerOptions: req.providerOptions } : {}),
      abortSignal: dog.signal,
      onError: () => undefined,
    });
    for await (const part of result.stream) {
      if (part.type === "text-delta") text += part.text;
      else if (part.type === "finish") {
        finishReason = part.rawFinishReason ?? part.finishReason;
        usage = tokenUsageOf(part.totalUsage);
      } else if (part.type === "error") error = part.error;
    }
  } catch (err) {
    error = err;
  } finally {
    dog.dispose();
  }

  const timeout = dog.fired();
  // Reported once, when the server accepted it; a call aborted before it was sent is not.
  if (accepted) {
    req.meter?.onCall({
      model: req.model,
      usage: timeout ? null : usage,
      timedOut: timeout !== null,
      accepted: true,
      ...effortField,
    });
  }
  // `max_output_tokens` is the Responses API's incomplete reason; `length` is the SDK's name for it.
  const lengthWithoutAnswer = (finishReason === "length" || finishReason === "max_output_tokens") && text.trim() === "";
  const failed = timeout !== null || error != null || lengthWithoutAnswer;
  if (failed) {
    console.error(
      `${req.label}: call failed`,
      JSON.stringify({ model: req.model, timeout, finishReason, error: error == null ? null : String(error).slice(0, 300) }),
    );
  }
  return { text, usage: timeout ? null : usage, finishReason, timeout, error, failed };
}

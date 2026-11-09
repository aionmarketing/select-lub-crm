/**
 * What every model port factory accepts (background-oil-research D2, D3): the socket, the run's
 * meter, and the run's outer signal. All optional — production passes none of them from the
 * composition root, and the research runner passes a fresh meter and its signal per run.
 *
 * `target` names the model a port calls. Without one, the port resolves the configured research
 * model from the environment at call time (`OPENAI_API_KEY`, `OIL_RESEARCH_MODEL`), and with the
 * key unset it makes no call at all. The benchmark and the tests hand a target explicitly.
 */
import type { UsageMeter } from "./meter.js";
import { openaiMaxOutputTokens, openaiReadOptions, openaiResearchTarget, type ModelTarget } from "./research-model.js";
import type { ModelCallRequest } from "./stream-call.js";

/** Options for a model port factory. */
export type ModelPortOptions = {
  /** The socket; tests inject a fake transport. Global `fetch` when absent. */
  transport?: typeof fetch;
  /** Where each request's spend is reported. */
  meter?: UsageMeter;
  /** An outer bound on every call the port makes; its abort is `budget`. */
  signal?: AbortSignal;
  /** Call this model instead of the configured research model. */
  target?: ModelTarget;
};

/** The part of a call request that says who is called and how. */
export type ResolvedCall = Pick<ModelCallRequest, "apiKey" | "model" | "providerOptions" | "effort" | "maxOutputTokens">;

/**
 * Who a port calls: the target it was given, else the configured research model — or `null` when
 * there is no key.
 *
 * @param options - The factory's options.
 * @param use - `escalation` names the escalation model and effort.
 */
export function resolveCall(options: ModelPortOptions, use: "read" | "escalation" = "read"): ResolvedCall | null {
  const target = options.target ?? openaiResearchTarget(use);
  if (!target) return null;
  const { apiKey, model, effort } = target;
  // No temperature: a reasoning model takes none. Every call carries the spend bound.
  return { apiKey, model, effort, maxOutputTokens: openaiMaxOutputTokens(), providerOptions: openaiReadOptions(effort) };
}

/** The socket, meter and signal of a factory's options, without its target. */
export function callPlumbing(options: ModelPortOptions): Pick<ModelCallRequest, "transport" | "meter" | "signal"> {
  return {
    ...(options.transport ? { transport: options.transport } : {}),
    ...(options.meter ? { meter: options.meter } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  };
}

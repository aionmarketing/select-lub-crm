/**
 * The limits a research call runs under, per (model, effort sent) (`research-model-calls` "A
 * research call is limited by a measured ceiling and its budget, not a fixed short timeout";
 * switch-oil-research-to-openai D6).
 *
 * A model and effort with a measured row runs on it; any other pair — another OpenAI model, or a
 * model sent no effort — runs on the placeholder row, and {@link reportUnmeasuredOpenAILimits}
 * logs it once at start-up.
 *
 * Environment overrides win over the row: `OIL_RESEARCH_CALL_TIMEOUT_MS`,
 * `WEB_SEARCH_TIMEOUT_MS` and `OIL_RESEARCH_UNKNOWN_CALL_USD`.
 */
import { OPENAI_EFFORT_TABLE, openaiEffortFor, type ReasoningEffort } from "./effort.js";

/** One row of limits. */
export type LimitRow = {
  /**
   * No event of any kind for this long aborts the call (`idle`). `Infinity` is no idle timer:
   * OpenAI documents no keep-alive while a model reasons, so a row has one only if the benchmark
   * measured events flowing during reasoning (B4) AND the owner wants the timer.
   */
  idleMs: number;
  /** The call is aborted at this long, whatever arrives (`ceiling`). */
  callMs: number;
  /** A web search's wall clock (`WEB_SEARCH_TIMEOUT_MS`). */
  webMs: number;
  /** A whole research run's ceiling (`OIL_RESEARCH_RUN_TIMEOUT_MS`). */
  runMs: number;
  /** What a call the server accepted and that reported no usage is charged, USD. */
  unknownCallUsd: number;
};

const MINUTE = 60_000;

/**
 * The placeholder row (D6): a 240 s call, a 300 s web search, a 45 min run, no idle timer, and a
 * US$ 0.25 charge for an unknown call (a 25,000-token output reservation at US$ 10/M).
 */
export const PLACEHOLDER_LIMITS: LimitRow = {
  idleMs: Number.POSITIVE_INFINITY,
  callMs: 240_000,
  webMs: 300_000,
  runMs: 45 * MINUTE,
  unknownCallUsd: 0.25,
};

/**
 * The measured rows, keyed by model then by the effort sent.
 *
 * `gpt-6.1-sol` at `medium` was measured by the 2026-10-12 benchmark (design.md, "Benchmark"): 17
 * calls, the slowest 27.6 s (a search), the passage selections about 2 s, the extractions about
 * 2 s, and the longest gap between two stream events 4.2 s, so a call that is reasoning keeps
 * sending events. The values stay at the placeholder's generous ceilings, and there is NO idle
 * timer (PR B brief, 2026-10-12): the benchmark read no real manual, so a 6-page extraction's latency
 * is unmeasured, and cutting a paid call that is merely slow costs more than waiting for it.
 */
export const OPENAI_LIMITS: Readonly<Record<string, Partial<Record<ReasoningEffort, LimitRow>>>> = {
  "gpt-6.1-sol": { medium: { ...PLACEHOLDER_LIMITS } },
};

/** A positive integer from the environment, or undefined when unset or not one. */
function envMs(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

/** Whether `model` is one the effort and limits tables know. */
export function hasOpenAILimitsEntry(model: string): boolean {
  return model in OPENAI_EFFORT_TABLE;
}

/** The measured row for (model, effort), or `null` when that pair was never measured. */
export function measuredOpenAIRow(model: string, effort: ReasoningEffort | null): LimitRow | null {
  if (effort === null) return null;
  return OPENAI_LIMITS[model]?.[effort] ?? null;
}

/**
 * The limits for a call to `model`: the row of (model, effort sent), else the placeholder, with
 * the environment's overrides applied.
 *
 * `unknownCallUsd` here is the row's default; the strict money parse of
 * `OIL_RESEARCH_UNKNOWN_CALL_USD` is the meter's.
 *
 * @param model - The model the call names.
 * @param effort - The effort the call sends; the configured research effort when absent.
 */
export function limitsFor(model: string, effort: ReasoningEffort | null = openaiEffortFor(model)): LimitRow {
  const row = measuredOpenAIRow(model, effort) ?? PLACEHOLDER_LIMITS;
  return {
    ...row,
    callMs: envMs("OIL_RESEARCH_CALL_TIMEOUT_MS") ?? row.callMs,
    webMs: envMs("WEB_SEARCH_TIMEOUT_MS") ?? row.webMs,
  };
}

/**
 * Logs, once per (model, effort), each configured research model that runs on the placeholder
 * row, so the placeholder is visible at start-up.
 *
 * @param models - The configured models, by the setting that names each.
 * @param log - Where the line goes; `console.warn` by default.
 * @returns The unmeasured pairs, for tests.
 */
export function reportUnmeasuredOpenAILimits(
  models: readonly { setting: string; model: string; effort: ReasoningEffort | null }[],
  log: (message: string, detail: string) => void = (message, detail) => console.warn(message, detail),
): { model: string; effort: ReasoningEffort | "none"; settings: string[] }[] {
  const pairs = new Map<string, { model: string; effort: ReasoningEffort | "none"; settings: string[] }>();
  for (const { setting, model, effort } of models) {
    if (measuredOpenAIRow(model, effort)) continue;
    const key = `${model}|${effort ?? "none"}`;
    const pair = pairs.get(key) ?? { model, effort: effort ?? "none", settings: [] };
    pair.settings.push(setting);
    pairs.set(key, pair);
  }
  for (const pair of pairs.values()) {
    log("openai-limits", JSON.stringify({ outcome: "placeholder_limits", ...pair, runsOn: "placeholder" }));
  }
  return [...pairs.values()];
}

/**
 * The OpenAI research model (switch-oil-research-to-openai D2; `research-model-calls` "Every
 * research model call goes to the one configured OpenAI model").
 *
 * Every port factory resolves its target here when it is not handed one: `OPENAI_API_KEY`, the
 * model `OIL_RESEARCH_MODEL` and the effort `OIL_RESEARCH_REASONING_EFFORT`. There is no other
 * provider and no setting that selects one.
 */
import { configuredOpenAIEffort, openaiEffortFor, type ReasoningEffort } from "./effort.js";
import { reportUnmeasuredOpenAILimits } from "./limits.js";

/** The research model when `OIL_RESEARCH_MODEL` is unset (owner, 2026-10-11). */
export const OIL_RESEARCH_DEFAULT_MODEL = "gpt-6.1-sol";

/** OpenAI's API, when `OPENAI_BASE_URL` is unset. */
export const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";

/** The OpenAI endpoint research calls: `OPENAI_BASE_URL` (the SDK reads the same variable), else the default; no trailing slash. */
export function openaiBaseUrl(): string {
  return (process.env.OPENAI_BASE_URL?.trim() || OPENAI_DEFAULT_BASE_URL).replace(/\/+$/, "");
}

/** The configured OpenAI research model, its effort, and escalation's own overrides. */
export type ResearchModelConfig = {
  provider: "openai";
  model: string;
  effort: ReasoningEffort | null;
  escalationModel: string;
  escalationEffort: ReasoningEffort | null;
  /** The key research needs. */
  keyName: "OPENAI_API_KEY";
};

/**
 * Reads the research model settings. Never throws: a value a model does not accept is replaced
 * by its default and reported once ({@link openaiEffortFor}).
 *
 * `ESCALATION_MODEL` / `ESCALATION_EFFORT` default to the research model and effort.
 */
export function researchModel(): ResearchModelConfig {
  const model = process.env.OIL_RESEARCH_MODEL?.trim() || OIL_RESEARCH_DEFAULT_MODEL;
  const escalationModel = process.env.ESCALATION_MODEL?.trim() || model;
  const wanted = configuredOpenAIEffort();
  const escalationWanted = process.env.ESCALATION_EFFORT?.trim() ? configuredOpenAIEffort("ESCALATION_EFFORT") : wanted;
  return {
    provider: "openai",
    model,
    effort: openaiEffortFor(model, wanted),
    escalationModel,
    escalationEffort: openaiEffortFor(escalationModel, escalationWanted),
    keyName: "OPENAI_API_KEY",
  };
}

/** One line for the start-up log: the research model and effort. */
export function researchModelLogLine(config: ResearchModelConfig = researchModel()): string {
  return JSON.stringify({ provider: config.provider, model: config.model, effort: config.effort ?? "none" });
}

/** Who and what a port calls. */
export type ModelTarget = {
  provider: "openai";
  apiKey: string;
  model: string;
  /** The effort sent, or `null` for none. */
  effort: ReasoningEffort | null;
};

/**
 * The research target, or `null` without `OPENAI_API_KEY`.
 *
 * @param use - `escalation` names the escalation model and effort.
 */
export function openaiResearchTarget(use: "read" | "escalation" = "read"): ModelTarget | null {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return null;
  const config = researchModel();
  return use === "escalation"
    ? { provider: "openai", apiKey, model: config.escalationModel, effort: config.escalationEffort }
    : { provider: "openai", apiKey, model: config.model, effort: config.effort };
}

/**
 * The output limit every non-benchmark OpenAI research call is sent (`max_output_tokens`), when
 * `OIL_RESEARCH_MAX_OUTPUT_TOKENS` is unset: OpenAI's recommended 25,000-token reservation for
 * reasoning and output (reasoning guide). An answer is a JSON object of a few hundred tokens, and
 * the reasoning at `medium` is expected in the low thousands (GLM measured 600–6,400 from `high` to
 * `max`), so the limit is a spend bound — US$ 0.25 at the list output price, the same as the
 * placeholder's unknown-call charge — not an answer size. A reply cut by it is a model failure.
 */
export const OIL_RESEARCH_DEFAULT_MAX_OUTPUT_TOKENS = 25_000;

/** `OIL_RESEARCH_MAX_OUTPUT_TOKENS` when it is a positive integer, else the default. */
export function openaiMaxOutputTokens(): number {
  const raw = Number(process.env.OIL_RESEARCH_MAX_OUTPUT_TOKENS?.trim());
  return Number.isInteger(raw) && raw > 0 ? raw : OIL_RESEARCH_DEFAULT_MAX_OUTPUT_TOKENS;
}

/**
 * The provider options an OpenAI research read is sent on the Responses API: the effort (when the
 * model has an entry), reasoning summaries so a reasoning call makes stream events (benchmark B4),
 * and `store: false` — every call is a single turn, so nothing is kept at the provider.
 */
export function openaiReadOptions(effort: ReasoningEffort | null): { openai: Record<string, string | boolean> } {
  return {
    openai: {
      ...(effort ? { reasoningEffort: effort } : {}),
      reasoningSummary: "auto",
      store: false,
    },
  };
}

/** The research model a run is configured with, as `provider:model:effort` (`none` when no effort is sent). */
export function researchModelKey(provider: string, model: string, effort: ReasoningEffort | null | "none"): string {
  return `${provider}:${model}:${effort ?? "none"}`;
}

/**
 * The research model this process is configured with, as the key recorded on a run at claim and
 * used to choose the duration sample (switch-oil-research-to-openai D7).
 */
export function configuredResearchModelKey(): string {
  const config = researchModel();
  return researchModelKey(config.provider, config.model, config.effort);
}

/** What a run recorded before research models were recorded counts as (D7): the only configuration production ran. */
export const LEGACY_RESEARCH_MODEL_KEY = "glm:glm-5.3-flash:high";

/** The models start-up checks for limits, by the setting that names each. */
export function configuredResearchModels(): { setting: string; model: string; effort: ReasoningEffort | null }[] {
  const config = researchModel();
  return [
    { setting: "OIL_RESEARCH_MODEL", model: config.model, effort: config.effort },
    { setting: "ESCALATION_MODEL", model: config.escalationModel, effort: config.escalationEffort },
  ];
}

/**
 * Start-up report (a composition root calls it once): the research model and effort, and — once per
 * pair — each configured model whose (model, effort) has no measured limits and so runs on the
 * placeholder row (background-oil-research D2).
 *
 * @param log - Where each line goes: a message and its JSON detail.
 */
export function reportResearchModel(log: (message: string, detail: string) => void = (message, detail) => console.info(message, detail)): void {
  log("oil-research-model", researchModelLogLine());
  reportUnmeasuredOpenAILimits(configuredResearchModels(), log);
}

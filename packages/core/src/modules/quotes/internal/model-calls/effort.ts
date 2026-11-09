/**
 * The reasoning effort every research request carries (`research-model-calls` "Every research
 * call carries the configured reasoning effort"; switch-oil-research-to-openai D2).
 *
 * One setting — {@link OPENAI_DEFAULT_REASONING_EFFORT}, overridable by
 * `OIL_RESEARCH_REASONING_EFFORT` — checked per request against the model that request names:
 * escalation may name another model than the reads, so one effort checked against one model
 * would not be enough. A value the model does not accept gives that model's default; a model
 * with no entry is sent no effort at all. Neither throws: the worker also drains the WhatsApp
 * outbox, and a typo in one variable must not stop sends.
 */

/** An effort a model may be sent. */
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

/** What the table knows about one model: the efforts it accepts, and its own default. */
export type EffortEntry = { accepts: readonly ReasoningEffort[]; default: ReasoningEffort };

/**
 * The effort an OpenAI research call is sent when `OIL_RESEARCH_REASONING_EFFORT` is unset
 * (switch-oil-research-to-openai D2: orchestrator, 2026-10-11, following the owner's ask).
 */
export const OPENAI_DEFAULT_REASONING_EFFORT: ReasoningEffort = "medium";

/**
 * Per OpenAI model, the efforts it accepts and its default, from OpenAI's model page
 * (developers.openai.com/api/docs/models/gpt-6.1-sol, read 2026-10-10): `none` and `minimal`
 * are not supported, so they are not in the list and are never sent.
 */
export const OPENAI_EFFORT_TABLE: Readonly<Record<string, EffortEntry>> = {
  "gpt-6.1-sol": { accepts: ["low", "medium", "high", "xhigh", "max"], default: "medium" },
};

const reported = new Set<string>();

/** Logs once per key, so a typo in one variable does not flood the worker's log. */
function reportOnce(key: string, message: string, detail: Record<string, unknown>): void {
  if (reported.has(key)) return;
  reported.add(key);
  console.warn(message, JSON.stringify(detail));
}

/** Forgets what was reported; tests call it so each can see its own warning. */
export function resetEffortReportsForTests(): void {
  reported.clear();
}

/** The configured OpenAI research effort, trimmed and lowercased; the default when unset or blank. */
export function configuredOpenAIEffort(setting = "OIL_RESEARCH_REASONING_EFFORT"): string {
  const raw = process.env[setting]?.trim().toLowerCase();
  return raw ? raw : OPENAI_DEFAULT_REASONING_EFFORT;
}

/**
 * The effort an OpenAI request to `model` is sent, or `null` when the model has no entry and is
 * sent none (the provider's own default then applies). A value the model does not accept gives
 * its default, reported once per (model, value); a model with no entry is reported once. Never
 * throws.
 *
 * @param model - The model the request names.
 * @param wanted - The configured value; {@link configuredOpenAIEffort} when absent.
 */
export function openaiEffortFor(model: string, wanted: string = configuredOpenAIEffort()): ReasoningEffort | null {
  const entry = OPENAI_EFFORT_TABLE[model];
  if (!entry) {
    reportOnce(`openai|none|${model}`, "openai-effort", { outcome: "no_entry", model, sent: "none" });
    return null;
  }
  if ((entry.accepts as readonly string[]).includes(wanted)) {
    return wanted as ReasoningEffort;
  }
  reportOnce(`openai|${model}|${wanted}`, "openai-effort", {
    outcome: "not_accepted",
    model,
    value: wanted,
    accepted: entry.accepts,
    sent: entry.default,
  });
  return entry.default;
}

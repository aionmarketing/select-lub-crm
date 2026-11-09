/**
 * LLM option picker injected into `resolveFilters` (tecfil-filter-pricing D4).
 *
 * Tecfil's catalogue names a make, a vehicle and an engine in its own words, which rarely
 * equal the CRM's spelling. When normalized equality (and, for the engine, unanimity)
 * fails, this picker asks the model to choose one entry from Tecfil's own list, so the
 * answer can never be a name Tecfil does not have. It is best-effort: with no
 * `OPENAI_API_KEY`, an empty list, a `none` answer, an out-of-list answer, a timeout or any
 * thrown error it returns `null`, and the resolver then reports the field as unmatched.
 */
import { createOpenAI } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { z } from "zod";
import type { PickableField, TecfilIdentity, TecfilOptionPicker } from "../../../../kernel/clients/tecfil/index.js";
import type { UsageMeter } from "../model-calls/meter.js";
import { tokenUsageOf } from "../model-calls/stream-call.js";
import type { TokenUsage } from "../retrieval/search-cost.js";

/** Model used when neither `TECFIL_PICKER_MODEL` nor `OPENAI_MODEL` is set — the Motul agent's default. */
export const TECFIL_PICKER_DEFAULT_MODEL = "gpt-5.6-luna";

/**
 * Milliseconds one pick may take before its request is aborted and the pick counts as a failure,
 * when `TECFIL_PICKER_TIMEOUT_MS` is unset. 60 s, raised from 10 s once no quote waits on the
 * picker: it runs only in background research (background-oil-research D2, D12).
 */
export const TECFIL_PICKER_DEFAULT_TIMEOUT_MS = 60_000;

/**
 * The picker's per-pick timeout: `TECFIL_PICKER_TIMEOUT_MS` when it is a positive whole number,
 * else {@link TECFIL_PICKER_DEFAULT_TIMEOUT_MS}. Read at each pick, like the key and the model.
 */
export function tecfilPickerTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.TECFIL_PICKER_TIMEOUT_MS);
  return Number.isInteger(raw) && raw > 0 ? raw : TECFIL_PICKER_DEFAULT_TIMEOUT_MS;
}

/** System prompt: choose from Tecfil's list or decline; never invent a name. */
export const TECFIL_PICKER_SYSTEM_PROMPT =
  "Você associa a identificação de um veículo do CRM de uma oficina a uma opção do catálogo da Tecfil. Escolha exatamente uma opção da lista fornecida, copiada literalmente. Se nenhuma opção corresponder ao veículo com segurança, responda \"none\". Nunca invente um nome que não esteja na lista.";

/** Portuguese label for each field, so the prompt names what is being disambiguated. */
const FIELD_LABEL: Record<PickableField, string> = {
  manufacturer: "montadora",
  vehicle: "veículo",
  engine: "motor",
};

/**
 * Builds the user prompt: which field is being matched, the CRM value, the full CRM
 * identity as context, and Tecfil's options one per line.
 *
 * @param field - Identity field being disambiguated.
 * @param query - The CRM value that matched no Tecfil option exactly.
 * @param context - Full CRM identity (make/year/model/version).
 * @param options - Tecfil's own labels for `field`, verbatim.
 * @returns Multi-line prompt string.
 */
export function buildTecfilPickerPrompt(
  field: PickableField,
  query: string,
  context: TecfilIdentity,
  options: string[],
): string {
  return [
    `campo: ${FIELD_LABEL[field]}`,
    `valor_no_crm: ${query}`,
    `veiculo_no_crm: ${JSON.stringify(context)}`,
    "opcoes_tecfil:",
    ...options.map((option) => `- ${option}`),
  ].join("\n");
}

/**
 * Creates the production picker for `resolveFilters`.
 *
 * Reads `OPENAI_API_KEY` at call time (absent means no model call at all) and picks the
 * model from `TECFIL_PICKER_MODEL`, then `OPENAI_MODEL`, then
 * {@link TECFIL_PICKER_DEFAULT_MODEL}. One attempt, aborted after
 * `TECFIL_PICKER_TIMEOUT_MS` ({@link tecfilPickerTimeoutMs}, 60 s by default).
 *
 * Each request is reported to `options.meter` as a picker call, outside the cap
 * (background-oil-research D3): answered with its usage, refused (non-2xx) as not accepted, and
 * aborted or failed after an answer began with no usage.
 *
 * @param deps.meter - Where each request is reported.
 * @param deps.transport - The socket; tests inject a fake.
 * @param deps.signal - An outer bound on each pick (a research run's signal, D9).
 * @param deps.onFailure - Told when a `null` is a failure rather than "none" (background-oil-research
 *   D12): no key, an error or a timeout, or an answer outside the list. An empty option list and a
 *   `none` answer are genuine no-picks and are not reported.
 * @returns A {@link TecfilOptionPicker} resolving to one of `options` verbatim, or `null`
 * for no pick. Never throws and never returns a string outside `options`.
 */
export function createTecfilOptionPicker(
  deps: { meter?: UsageMeter; transport?: typeof fetch; signal?: AbortSignal; onFailure?: (why: "no_key" | "error" | "out_of_list") => void } = {},
): TecfilOptionPicker {
  return async (field, query, context, options) => {
    if (options.length === 0) {
      return null;
    }
    if (!process.env.OPENAI_API_KEY) {
      deps.onFailure?.("no_key");
      return null;
    }
    const model = process.env.TECFIL_PICKER_MODEL ?? process.env.OPENAI_MODEL ?? TECFIL_PICKER_DEFAULT_MODEL;
    const base = deps.transport ?? fetch;
    let accepted = false;
    const report = (usage: TokenUsage | null, ok: boolean) =>
      deps.meter?.onCall({ model, provider: "openai", usage, timedOut: false, accepted: ok, picker: true });
    const transport: typeof fetch = async (input, init) => {
      const res = await base(input, init);
      if (res.ok) accepted = true;
      else report(null, false);
      return res;
    };
    // z.enum needs a non-empty tuple; "none" first guarantees one is always there.
    const choices: [string, ...string[]] = ["none", ...options];
    try {
      const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY, fetch: transport });
      const result = await generateObject({
        model: openai(model),
        schema: z.object({ choice: z.enum(choices) }),
        system: TECFIL_PICKER_SYSTEM_PROMPT,
        prompt: buildTecfilPickerPrompt(field, query, context, options),
        abortSignal: deps.signal
          ? AbortSignal.any([AbortSignal.timeout(tecfilPickerTimeoutMs()), deps.signal])
          : AbortSignal.timeout(tecfilPickerTimeoutMs()),
      });
      report(tokenUsageOf(result.usage), true);
      const choice = (result.object as { choice?: unknown }).choice;
      if (choice === "none") {
        return null;
      }
      if (typeof choice !== "string" || !options.includes(choice)) {
        deps.onFailure?.("out_of_list");
        return null;
      }
      return choice;
    } catch (err) {
      if (accepted) report(null, true);
      deps.onFailure?.("error");
      console.error("tecfil-option-picker: pick failed", err);
      return null;
    }
  };
}

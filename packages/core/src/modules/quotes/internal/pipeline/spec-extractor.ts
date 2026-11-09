/**
 * Model-backed extractor for prose sources (oil-quote-liters-pricing D10 step 4, D11), run on the
 * configured OpenAI research model (`gpt-6.1-sol` at `medium` by default).
 *
 * The model's whole job is reading: it copies the SAE grades and the service-fill volume out
 * of the passage it is given. It is never asked what oil a car should use, and never asked
 * which product the workshop should sell — those would be memory answers, and this change
 * exists to keep memory answers off a customer's quote.
 *
 * With no `OPENAI_API_KEY`, an empty passage, or a refusal, this returns `null` and the quote
 * misses in Portuguese instead of guessing. The Tecfil option picker uses the same key but keeps
 * its own model (`OPENAI_MODEL`).
 */
import { z } from "zod";
import { fillConditionSchema } from "../../contracts/http.js";
import { fillConditionOf } from "./fill-condition.js";
import {
  ESCALATION_FAILED,
  EXTRACTION_FAILED,
  type EscalationInput,
  type ExtractedOilSpec,
  type OilSpecEscalator,
  type OilSpecExtractor,
  type RetrievedSource,
} from "./oil-spec.js";
import type { VehicleIdentity } from "../store/store.js";
import { callPlumbing, resolveCall, type ModelPortOptions } from "../model-calls/ports.js";
import { streamModelCall } from "../model-calls/stream-call.js";

/**
 * How a per-engine column table is read (background-oil-research D5; ingest-harvested-manuals
 * PR 4's sentence, extended with its other half). In the benchmark, without it, the Gol's column
 * table read `several` in 7 of the 9 Gol extractions although the identity names the 1.0.
 */
export const COLUMN_TABLE_NOTE =
  "O trecho pode vir de uma tabela com uma coluna por motor: cada linha traz os valores na ordem " +
  "das colunas. Leia a coluna do motor do veículo do orçamento; se a identidade do veículo aponta " +
  "uma única coluna, engineCoverage é \"one\"; se aponta mais de uma coluna, engineCoverage é \"several\". ";

/**
 * System prompt: copy from the passage, say so when the passage is silent, and refuse when
 * the passage is not about this car's engine.
 *
 * `engineCoverage` is a refusal, not a choice. The model is never asked which engine the car
 * has — only whether the passage in front of it covers one engine or several. That
 * distinction is what keeps this inside `prompt.md`'s "the LLM may select relevant passages"
 * and outside its "the LLM must not infer a missing engine".
 *
 * Scope, measured rather than assumed: it catches a passage that visibly lists several
 * engines. It does NOT catch a single-engine passage about the WRONG engine — see the
 * `EngineCoverage` docs in oil-spec.ts for the HR-V case it misses and why no prompt can
 * fix it.
 */
export const OIL_SPEC_SYSTEM_PROMPT =
  "Você extrai fatos de um trecho de documento técnico automotivo. Use SOMENTE o texto fornecido. " +
  "Responda com as viscosidades SAE que o trecho lista para o motor (todas elas, na ordem do texto) " +
  "e com o volume de óleo do motor que o trecho indicar, em litros, dizendo que volume é. " +
  "Nunca use conhecimento próprio sobre o veículo. Nunca escolha uma marca ou produto. " +
  "Se o trecho não indicar uma informação, deixe-a vazia ou nula em vez de deduzir. " +
  "Você também recebe a identidade do veículo do orçamento. Ela serve APENAS para conferir se o " +
  "trecho fala do motor desse veículo — nunca para preencher viscosidade ou litros. " +
  "Em engineCoverage responda: \"one\" se o trecho descreve exatamente um motor e ele corresponde " +
  "ao veículo; \"several\" se o trecho lista mais de um motor e não dá para saber qual é o do " +
  "veículo; \"mismatch\" se o motor do trecho claramente não é o do veículo; \"unknown\" se não " +
  "for possível decidir. Na dúvida entre \"one\" e qualquer outro valor, NÃO responda \"one\". " +
  "Em enginesNamed liste, literalmente como aparecem no trecho, os motores que ele nomeia. " +
  COLUMN_TABLE_NOTE +
  "Responda APENAS com um objeto JSON, sem texto antes ou depois, sem markdown, no formato: " +
  '{"viscosityGrades": ["5W-30"], "classification": "", "fillLiters": 4.2, "fillCondition": "with_filter", ' +
  '"engineCoverage": "one", "enginesNamed": ["1.0 TSI"]}. ' +
  'Em fillCondition responda "with_filter" quando o trecho disser com filtro, em serviço ou ' +
  'preenchimento de serviço; "without_filter" quando disser sem filtro ou sem troca do filtro; ' +
  '"dry" quando disser volume seco ou motor seco; "unlabeled" quando houver UM único volume para o ' +
  "motor, sem legenda; e null quando não houver volume, ou quando houver mais de um volume sem " +
  "legenda para o mesmo motor. Se o trecho der o volume com filtro e outros, responda o com filtro.";

/**
 * Shape the model must answer in.
 *
 * `fillCondition` says what the volume is (ingest-harvested-manuals D5); the validator prices only
 * `with_filter` and `unlabeled`, and keeps `without_filter` and `dry` aside. `fillKind` is the
 * older legend, still read when a reply carries only it.
 */
const extractionSchema = z.object({
  viscosityGrades: z.array(z.string()),
  classification: z.string(),
  fillLiters: z.number().nullable(),
  fillCondition: fillConditionSchema.nullable().optional(),
  fillKind: z.enum(["em_servico", "unlabeled"]).nullable().optional(),
  // Defaulted, not required: an older or terser reply must not throw away a good
  // extraction, and "unknown" is the value that does not block a quote.
  engineCoverage: z.enum(["one", "several", "mismatch", "unknown"]).default("unknown"),
  enginesNamed: z.array(z.string()).default([]),
});

/**
 * A parsed reply as an extraction: the capacity type as the model gave it (else read from an
 * older `fillKind`), and the legend derived from it, so the validator sees both consistently.
 */
function fromReply(object: z.infer<typeof extractionSchema>): ExtractedOilSpec {
  const fillCondition = fillConditionOf({ fillCondition: object.fillCondition, fillKind: object.fillKind ?? null });
  return {
    viscosityGrades: object.viscosityGrades,
    classification: object.classification,
    fillLiters: object.fillLiters,
    fillKind: fillCondition === "with_filter" ? "em_servico" : fillCondition === "unlabeled" ? "unlabeled" : null,
    fillCondition,
    engineCoverage: object.engineCoverage,
    enginesNamed: object.enginesNamed,
  };
}

/**
 * Builds the user prompt: the car being quoted, the citation, then the passage.
 *
 * The identity leads so the coverage check has something to compare against; the passage
 * is still the only place a grade or a volume may come from.
 *
 * @param source - The retrieved source; only `text` content reaches this extractor.
 * @param identity - The vehicle the quote is for.
 * @returns Multi-line prompt string.
 */
export function buildOilSpecPrompt(source: RetrievedSource, identity: VehicleIdentity): string {
  const text = source.content.kind === "text" ? source.content.text : "";
  return [
    `veiculo_do_orcamento: ${identity.make} ${identity.model} ${identity.year} ${identity.version}`,
    // An engine re-read (D24): the attendant chose this engine; its values are the ones to read.
    ...(identity.engine ? [`motor_escolhido_pelo_atendente: ${identity.engine} (leia os valores deste motor)`] : []),
    `fonte: ${source.publisher} — ${source.document} (${source.page})`,
    "trecho:",
    text,
  ].join("\n");
}

/**
 * Pulls the JSON object out of a model reply.
 *
 * This provider answers `/chat/completions` in prose when asked for a JSON schema, so the
 * reply is treated as text and the object is located in it. Anything the model added around
 * that object — commentary, a markdown table, advice it remembered rather than read — is
 * discarded here and can never reach a quote.
 *
 * @param reply - Raw model output.
 * @returns The parsed object.
 * @throws When the reply contains no parseable JSON object, which the caller retries once.
 */
export function parseJsonReply(reply: string): unknown {
  const withoutFence = reply.replace(/```(?:json)?/gi, "");
  const start = withoutFence.indexOf("{");
  const end = withoutFence.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error("model reply contained no JSON object");
  }
  return JSON.parse(withoutFence.slice(start, end + 1));
}

/**
 * Creates the production prose extractor.
 *
 * Resolves the research model at call time (`OPENAI_API_KEY`; absent means no model call at all).
 * The call is streamed under its model's and effort's limits (background-oil-research D2), never
 * a fixed number of seconds. An unparseable reply or a provider error is retried once (D10 step
 * 4); a timeout is not, it is a failure at once.
 *
 * @param options - The transport, the meter, the outer signal and, optionally, the target model
 *   (tests and the runner).
 * @returns An extractor that resolves to the extracted facts; `null` when it read the
 * passage and the passage stated nothing (or was empty); {@link EXTRACTION_FAILED} when it
 * could not read it — no key, a timeout, a provider error, a length stop with no answer, a reply
 * unparseable twice. Never throws, and never returns facts when the passage was empty.
 */
export function createModelOilSpecExtractor(options: ModelPortOptions = {}): OilSpecExtractor {
  return async (source, identity) => {
    const text = source.content.kind === "text" ? source.content.text.trim() : "";
    if (text === "") {
      return null;
    }
    const who = resolveCall(options);
    if (!who) {
      return EXTRACTION_FAILED;
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const call = await streamModelCall({
        ...who,
        system: OIL_SPEC_SYSTEM_PROMPT,
        prompt: buildOilSpecPrompt(source, identity),
        label: "oil-spec-extractor",
        ...callPlumbing(options),
      });
      if (call.timeout) {
        // Cut by a limit: a source left unread, never "the page is silent".
        return EXTRACTION_FAILED;
      }
      if (!call.failed) {
        try {
          return fromReply(extractionSchema.parse(parseJsonReply(call.text)));
        } catch (err) {
          if (attempt === 1) console.error("oil-spec-extractor: extraction failed", err);
        }
      }
      // One retry; a second failure is a failure, not a guess and not "the page is silent".
    }
    return EXTRACTION_FAILED;
  };
}

/**
 * Addendum that turns the extraction prompt into a conflict-settling one.
 *
 * The model is told what the passages disagree on and that it may only choose among the
 * values they contain. Code re-checks that afterwards ({@link withinCandidates}); the
 * instruction is there so a well-behaved model does not waste the one attempt.
 */
export const ESCALATION_SYSTEM_ADDENDUM =
  " Você recebe VÁRIOS trechos, de fontes diferentes, que discordam entre si sobre este veículo. " +
  "Leia todos e responda com a especificação que se aplica ao veículo informado, escolhendo " +
  "APENAS entre os valores que os trechos trazem — nunca um valor que nenhum trecho contenha. " +
  "Se os trechos realmente conflitam para o mesmo motor e não há como decidir pelo texto, " +
  "responda fillLiters null e viscosityGrades [].";

/**
 * Builds the escalation prompt: the car, the dispute, then every passage with its citation
 * and tier.
 *
 * @param input - The conflicting sources, the vehicle, and what they disagree on.
 * @returns Multi-line prompt string.
 */
export function buildEscalationPrompt(input: EscalationInput): string {
  const { identity, conflicts, sources } = input;
  const lines = [
    `veiculo_do_orcamento: ${identity.make} ${identity.model} ${identity.year} ${identity.version}`,
    "discordancias:",
    ...conflicts.map(
      (conflict) =>
        `- ${conflict.field}: ${conflict.values
          .map((entry) => `${entry.value} (${entry.citation.publisher}, autoridade ${entry.citation.authority ?? "?"})`)
          .join(" | ")}`,
    ),
  ];
  sources.forEach((source, index) => {
    const text =
      source.content.kind === "text" || source.content.kind === "stored_spec" ? source.content.text : "(payload estruturado)";
    lines.push(
      `trecho ${index + 1} — fonte: ${source.publisher} — ${source.document} (${source.page}), autoridade ${source.authority ?? "?"}:`,
      text,
    );
  });
  return lines.join("\n");
}

/**
 * Creates the production escalation read.
 *
 * The model is the escalation model (`ESCALATION_MODEL`, default the research model) at its effort
 * (`ESCALATION_EFFORT`, default the research effort), both OpenAI. Streamed under the limits of
 * its model and effort (background-oil-research D2).
 *
 * A decline and a failure are told apart (D10): `null` only when the model itself says the
 * passages cannot be reconciled, or no key is set; {@link ESCALATION_FAILED} for an error, a
 * timeout, or a reply that is not one — a conflict left unsettled that could have been settled,
 * which research retries as an outage.
 *
 * @param options - The transport, the meter, the outer signal and, optionally, the target model
 *   (tests and the runner).
 * @returns An escalator that never throws.
 */
export function createEscalationExtractor(options: ModelPortOptions = {}): OilSpecEscalator {
  return async (input) => {
    const who = resolveCall(options, "escalation");
    if (!who) {
      return null;
    }
    const call = await streamModelCall({
      ...who,
      system: OIL_SPEC_SYSTEM_PROMPT + ESCALATION_SYSTEM_ADDENDUM,
      prompt: buildEscalationPrompt(input),
      label: "oil-spec-escalation",
      ...callPlumbing(options),
    });
    return escalationReply(call);
  };
}

/** Reads an escalation call: a failure, a decline (`null`), an unusable reply, or the reconciled spec. */
function escalationReply(call: { failed: boolean; text: string }): ExtractedOilSpec | null | typeof ESCALATION_FAILED {
  if (call.failed) {
    return ESCALATION_FAILED;
  }
  try {
    const object = extractionSchema.parse(parseJsonReply(call.text));
    if (object.viscosityGrades.length === 0 && object.fillLiters == null) {
      // The model itself says the passages cannot be reconciled. Honour it.
      return null;
    }
    return fromReply(object);
  } catch (err) {
    console.error("oil-spec-escalation: escalation reply unusable", err);
    return ESCALATION_FAILED;
  }
}

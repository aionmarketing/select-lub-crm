/**
 * LLM prompt construction and OpenAI extraction for cadastro prefill suggestions.
 */
import { createOpenAI } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { z } from "zod";
import type { PrefillFields } from "../contracts/http.js";
import { pickV1Fields, postFilterFilled, storedV1 } from "./gate.js";
import type { PrefillCadastroSnapshot, PrefillTextLine } from "./cadastro-snapshot.js";

/** Maximum recent text lines included in a prefill extraction prompt. */
export const PREFILL_RECENT_TEXT_LIMIT = 10;

const llmFieldsSchema = z.object({
  name: z.string().optional(),
  taxId: z.string().optional(),
  plate: z.string().optional(),
  make: z.string().optional(),
  model: z.string().optional(),
  version: z.string().optional(),
  year: z.number().int().optional(),
  odometerKm: z.number().optional(),
  shouldReply: z.boolean(),
});

/** System prompt instructing the model to extract v1 fields (including corrections) and shouldReply. */
export const PREFILL_SYSTEM_PROMPT =
  "Você extrai dados de cadastro de oficina (Cliente e um veículo titular) e diz se a janela ainda precisa de resposta da equipe. Avalie todos os campos v1. Pode corrigir um valor já gravado quando a conversa sustentar outro; não copie o valor gravado. Campos listados em campos_autoritativos_da_placa vieram da consulta de placa e são autoritativos; não os proponha. Omita chaves sem suporte. Não invente rua, endereço, last-oil ou um segundo carro. shouldReply é true quando o cliente ainda espera resposta, false quando a janela encerra a conversa (ex.: ok, obrigado). Responda só com as chaves v1 e shouldReply.";

/**
 * Builds the user prompt from stored cadastro, pending suggestion, and recent messages.
 *
 * @param input - Context assembled for the LLM extraction call.
 * @param input.stored - Non-empty v1 fields already persisted on the customer/vehicle.
 * @param input.pending - Current pending suggestion fields, if any.
 * @param input.messages - Recent text lines in chronological order.
 * @param input.plateSourcedKeys - Veículo keys confirmed from a plate lookup; listed as authoritative.
 * @returns Multi-line prompt string with JSON snapshots and message lines.
 */
export function buildPrefillPrompt(input: {
  stored: PrefillFields;
  pending: PrefillFields;
  messages: PrefillTextLine[];
  plateSourcedKeys?: readonly (keyof PrefillFields)[];
}) {
  const lines = input.messages.map((item) => `${item.direction}: ${item.textBody}`);
  const header = [
    `cadastro_armazenado: ${JSON.stringify(input.stored)}`,
    `sugestao_pendente: ${JSON.stringify(input.pending)}`,
  ];
  if (input.plateSourcedKeys && input.plateSourcedKeys.length > 0) {
    header.push(`campos_autoritativos_da_placa: ${JSON.stringify([...input.plateSourcedKeys])}`);
  }
  return [...header, "mensagens:", ...lines].join("\n");
}

/** Injectable LLM backend used by tests to stub field extraction.
 *
 * @param prompt - User prompt built by {@link buildPrefillPrompt}.
 * @returns Raw field map from the model response.
 */
export type GeneratePrefillFields = (prompt: string) => Promise<Record<string, unknown>>;

/**
 * Calls OpenAI structured output to extract v1 cadastro fields from the prompt.
 *
 * @param prompt - User prompt built by {@link buildPrefillPrompt}.
 * @returns Raw field map from the model response.
 * @throws `"openai_unconfigured"` when `OPENAI_API_KEY` is unset; propagates SDK errors on API failure.
 */
export async function defaultGeneratePrefillFields(prompt: string) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("openai_unconfigured");
  }
  const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const result = await generateObject({
    model: openai(process.env.OPENAI_MODEL ?? "gpt-5.6-luna"),
    schema: llmFieldsSchema,
    system: PREFILL_SYSTEM_PROMPT,
    prompt,
  });
  return result.object as Record<string, unknown>;
}

/** What extraction reads before the call: the pending suggestion and the recent text. */
export type ExtractContext = {
  /** The conversation's pending suggestion fields, `{}` when none. */
  pending: PrefillFields;
  /** Up to {@link PREFILL_RECENT_TEXT_LIMIT} recent text lines, oldest first. */
  recent: PrefillTextLine[];
};

/**
 * Runs extraction on context already read, and returns v1 fields (echoes
 * dropped) plus shouldReply.
 *
 * It used to read the context itself through the worker's store port. The reads
 * now happen in the caller's `db.tx`, and this runs AFTER that transaction has
 * closed: `generate` is the LLM call, a provider, and never runs inside one.
 *
 * @param snapshot - Cadastro snapshot used for stored-field projection, including plate-sourced keys.
 * @param context - See {@link ExtractContext}.
 * @param generate - Injectable LLM backend; defaults to {@link defaultGeneratePrefillFields}.
 * @returns The prompt sent to the model, the post-filtered suggestion fields, and the window shouldReply label.
 * @throws Propagates errors from `generate` (e.g. `"openai_unconfigured"`); throws `"shouldReply_invalid"` when the model omits a boolean shouldReply.
 */
export async function runExtract(
  snapshot: PrefillCadastroSnapshot,
  context: ExtractContext,
  generate: GeneratePrefillFields = defaultGeneratePrefillFields,
): Promise<{ prompt: string; fields: PrefillFields; shouldReply: boolean }> {
  const stored = storedV1(snapshot);
  const { pending, recent } = context;
  const plateSourcedKeys = snapshot.plateSourcedKeys;
  const prompt = buildPrefillPrompt({ stored, pending, messages: recent, plateSourcedKeys });
  const raw = await generate(prompt);
  if (typeof raw.shouldReply !== "boolean") {
    throw new Error("shouldReply_invalid");
  }
  const picked = pickV1Fields(raw);
  return {
    prompt,
    fields: postFilterFilled(picked, stored, plateSourcedKeys),
    shouldReply: raw.shouldReply,
  };
}

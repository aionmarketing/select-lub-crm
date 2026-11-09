/**
 * Motul oil-spec assistant loop: OpenAI tool-calling with {@link findOil} and {@link SYSTEM_PROMPT}.
 * Returns draft text for attendant review — never sends WhatsApp messages.
 */
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, stepCountIs, type ModelMessage } from "ai";
import { SYSTEM_PROMPT } from "./prompt.js";
import { findOil } from "./tools.js";

const FALLBACK_REPLY =
  "Não foi possível gerar a sugestão agora. Tente de novo em instantes.";

const MAX_HISTORY_MESSAGES = 30;

/**
 * Runs the Motul agent on recent chat turns and returns Portuguese draft oil-spec text.
 *
 * Uses `OPENAI_API_KEY` and optional `OPENAI_MODEL` (default `gpt-5.6-luna`).
 * On model or tool failure, logs the error and returns a fixed Portuguese fallback
 * instead of throwing.
 *
 * @param messages - Prior user/assistant turns. Only the last 30 are sent to the model.
 * @returns Non-empty Portuguese suggestion text, or the fallback sentence if generation fails or the model returns empty.
 */
export async function runMotulAgent(
  messages: ModelMessage[],
): Promise<string> {
  const openai = createOpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  try {
    const result = await generateText({
      model: openai(process.env.OPENAI_MODEL ?? "gpt-5.6-luna"),
      instructions: SYSTEM_PROMPT,
      tools: { findOil },
      stopWhen: stepCountIs(8),
      messages: messages.slice(-MAX_HISTORY_MESSAGES),
    });

    return result.text || FALLBACK_REPLY;
  } catch (err) {
    console.error("motul-agent: generation failed", err);
    return FALLBACK_REPLY;
  }
}
